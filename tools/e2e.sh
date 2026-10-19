#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='e2e'
DEVKIT_SETUP='gsettings set org.gnome.desktop.interface font-name "Cantarell 11"'
DEVKIT_HEADLESS=1
# shellcheck source=tools/lib/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/devkit.sh"
# shellcheck source=tools/lib/indicator.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/indicator.sh"
# shellcheck source=tools/lib/capture.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/capture.sh"
# shellcheck source=tools/lib/assert.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/assert.sh"

# GROUPS is a bash built-in holding the user's gids, and assignments to it are ignored.
ALL_GROUPS=(state panel hover refresh notify lifecycle)
RUN_GROUPS=("${ALL_GROUPS[@]}")
THEMES=(dark light)
A11Y_SHOTS=(normal warning critical model-scoped error service-major over-pace rate-limited rate-limited-day no-data)
SHOOT_MODE=all
PICKED_GROUPS=()
ATTEMPTS_LOG=''

usage() {
    cat <<USAGE
Usage: tools/e2e.sh [options]

Asserts what the extension renders and how it reacts, in a throwaway nested GNOME
shell, and shoots what it asserts.

Options:
  --headless           Run with no window, driven over D-Bus (default)
  --windowed           Show the session in a Mutter devkit window
  --dark-only          Assert the dark theme only
  --light-only         Assert the light theme only
  --scenario=<name>    Assert one scenario; repeat the flag for several
  --group=<name>       Run one group; repeat the flag for several
  --a11y               Shoot only the subset npm run a11y scores
  --assert             Shoot nothing, leaving preview/ alone
  --language=<tag>     Language for the nested session's words (default C, e.g. fr_FR)
  --locale=<tag>       Locale for its clock and numbers (default C, e.g. fr_FR)
  -h, --help           Show this message

Every scenario is shot by default, which costs minutes; narrow with --group,
--scenario or --dark-only while iterating, or pass --assert to shoot nothing.
Screenshots belong to the state group, so a run that excludes it leaves
preview/ alone and npm run a11y would score whatever was already there.

Groups:
  ${ALL_GROUPS[*]}

Scenarios:
  ${SCENARIOS[*]}

Needs magick and gnome-shell.
USAGE
}

for arg in "$@"; do
    devkit_flag "$arg" && continue
    case "$arg" in
        --dark-only) THEMES=(dark) ;;
        --light-only) THEMES=(light) ;;
        --scenario=*) PICKED+=("${arg#*=}") ;;
        --group=*) PICKED_GROUPS+=("${arg#*=}") ;;
        --a11y) SHOOT_MODE=a11y ;;
        --assert) SHOOT_MODE=none ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $arg" ;;
    esac
done

# preview.sh runs as a subprocess, so an axis left unexported reaches the nested
# shell as its default and the run reports success in the wrong language.
export DEVKIT_LANGUAGE DEVKIT_LOCALE

select_groups() {
    local want known found
    [ "${#PICKED_GROUPS[@]}" -gt 0 ] || return 0
    for want in "${PICKED_GROUPS[@]}"; do
        found=''
        for known in "${ALL_GROUPS[@]}"; do
            [ "$known" = "$want" ] && found=1 && break
        done
        [ -n "$found" ] || die "unknown group '$want'; known: ${ALL_GROUPS[*]}"
    done
    RUN_GROUPS=("${PICKED_GROUPS[@]}")
}

runs_group() {
    local name
    for name in "${RUN_GROUPS[@]}"; do
        [ "$name" = "$1" ] && return 0
    done
    return 1
}

probe() {
    shell_eval "JSON.stringify($1)" | unwrap
}

shoots() {
    local name
    case "$SHOOT_MODE" in
        all) return 0 ;;
        none) return 1 ;;
    esac
    for name in "${A11Y_SHOTS[@]}"; do
        [ "$name" = "$1" ] && return 0
    done
    return 1
}

IND="Main.panel.statusArea['$UUID']"
BLOCK_ROWS="$IND._popup._blocks.flatMap(b => [b._name.text, b._percent.text, b._caption.text])"
PANEL_LABELS="$IND._panel._cells.map(c => c.label.text)"
PANEL_QUOTAS="$IND._panel._cells
    .filter(c => /cq-panel-quota/.test(c.label.get_style_class_name() ?? ''))
    .map(c => c.label.text)"
CRITICAL_COLOR="$IND._popup._blocks[1]._percent.get_theme_node().get_foreground_color().to_string()"

assert_rows_filled() {
    assert_eq "$1 rows filled" 'true' "$(probe "$BLOCK_ROWS.every(t => t !== '')")"
}

assert_no_placeholders() {
    assert_eq "$1 no placeholder leaked" 'true' \
        "$(probe "$BLOCK_ROWS.concat($PANEL_LABELS).every(t => !/null|undefined|NaN/.test(t))")"
}

assert_block_count() {
    assert_eq "$1 block count" "$(probe "$IND._quotas.length")" "$(probe "$IND._popup._blocks.length")"
}

assert_panel_matches() {
    assert_eq "$1 panel agrees with blocks" 'true' \
        "$(probe "$IND._popup._blocks.every((b, n) => ($PANEL_QUOTAS)[n].endsWith(b._percent.text))")"
}

assert_rate_limit_note() {
    local header limited
    header="$(js_string "$(catalog_prefix 'Last refresh: {time}')")"
    limited="$(js_string "$(catalog_msg 'Rate limited')")"
    assert_eq "$1 header always states the last refresh" 'true' \
        "$(probe "$IND._popup._refreshLabel.text.startsWith($header)")"
    assert_eq "$1 the rate-limit row tracks the block" 'true' \
        "$(probe "($IND._popup._messageLabel.text.includes($limited) && $IND._popup._message.visible)
            === ($IND._block?.until > new Date())")"
}

assert_issue_trails_quota() {
    assert_eq "$1 the incident emoji trails live quota cells" 'true' \
        "$(probe "($PANEL_QUOTAS).length > 0
            && /cq-panel-issue/.test($PANEL_CELLS.at(-1).label.get_style_class_name() ?? '')")"
}

assert_issue_trails_quota_probe() { assert_issue_trails_quota control; }

assert_issue_rides_healthy_quota() {
    render_state service-quota-ok
    assert_issue_trails_quota "$1"
}

stage_service() {
    shell_eval "$IND._service = {status: '$1', until: null}; $IND._render(); 'ok'" >/dev/null
}

assert_no_issue_while_operational() {
    assert_eq "$1 an operational component carries no issue emoji" 'false' \
        "$(probe "$PANEL_CELLS.some(c => /cq-panel-issue/.test(c.label.get_style_class_name() ?? ''))")"
}

assert_no_issue_while_operational_probe() { assert_no_issue_while_operational control; }

assert_operational_clears_the_issue() {
    render_state service-quota-ok
    stage_service operational
    assert_no_issue_while_operational "$1"
}

assert_incident_window() {
    local until
    until="$(js_string "$(catalog_prefix 'until {time}')")"
    assert_eq "$1 the incident line names an end exactly when the window has one" 'true' \
        "$(probe "$IND._popup._issueItem.label.text.includes($until)
            === ($IND._popup._issueItem.visible && $IND._service?.until > new Date())")"
}

# The popup is as wide as its widest item, so the incident line staying inside the
# quota body is what keeps a named window from stretching every row that carries one.
assert_incident_within_popup() {
    assert_eq "$1 the incident line never widens the popup" 'true' \
        "$(probe "!$IND._popup._issueItem.visible ||
            $IND._popup._issueItem.get_preferred_width(-1)[1] <= $IND._popup._body.get_preferred_width(-1)[1]")"
}

# A detail row is a dimmed label beside its value under the header, opt-in through its
# own switch: <name>, the popup's row property, the indicator's state field, the schema
# key, and the msgid its label must carry.
assert_detail_row() {
    local label
    label="$(js_string "$(catalog_msg "$6")")"
    assert_eq "$1 the $2 row pairs its label with its value, or hides" 'true' \
        "$(probe "(() => {
            const shown = $IND._prefs.get_boolean('$5') && $IND.$4 !== null;
            const row = $IND._popup.$3;
            const text = row.value.text;
            const cut = text.indexOf('…');
            const stands = text === $IND.$4 || (cut > 0 && $IND.$4.startsWith(text.slice(0, cut)));
            return row.name.visible === shown && row.value.visible === shown
                && (!shown || (row.name.text === $label && stands));
        })()")"
}

assert_account_fits_its_column() {
    assert_eq "$1 the account value fits its column without Pango cutting it" 'true' \
        "$(probe "(() => {
            const popup = $IND._popup;
            return !popup._account.value.visible
                || popup._account.value.get_preferred_width(-1)[1] <= popup._valueWidth();
        })()")"
}

FITTING_EMAIL='jane.doe@example.org'
LONG_EMAIL='areallylongusernamebeforedomain@areallylongdomainafteruser.tld'

await_resource_scale() {
    local _
    for _ in $(seq 50); do
        [ "$(probe "$IND._popup._account.value.get_resource_scale()")" = "$1" ] && return 0
        sleep 0.1
    done
    die "the account value never reached resource scale $1"
}

account_text_at() {
    set_monitor_scale "$1"
    await_resource_scale "$2"
    shell_eval "$IND._accountEmail = $(js_string "$3"); $IND._render(); 'ok'" >/dev/null
    shell_eval "$IND._popup._account.value.text" | unwrap
}

# Every fractional scale draws text at resource scale 2, so 1.5 stands for all of them.
# The label column is measured in half pixels there, which can cost the cut one character.
assert_account_fit_ignores_scale() {
    local long_flat fitting_scaled long_scaled
    long_flat="$(account_text_at 1.0 1 "$LONG_EMAIL")"
    fitting_scaled="$(account_text_at 1.5 2 "$FITTING_EMAIL")"
    long_scaled="$(account_text_at 1.5 2 "$LONG_EMAIL")"
    set_monitor_scale 1.0
    await_resource_scale 1
    render_state normal
    assert_eq "$1 an address that fits keeps every character at a fractional scale" \
        "$FITTING_EMAIL" "$fitting_scaled"
    assert_eq "$1 a cut address keeps as much at a fractional scale" 'true' \
        "$([ "$long_flat" != "$LONG_EMAIL" ] && [ $((${#long_flat} - ${#long_scaled})) -le 1 ] && echo true || echo false)"
}

assert_account_row() { assert_detail_row "$1" account _account _accountEmail show-account 'Account'; }
assert_plan_row() { assert_detail_row "$1" plan _plan _accountPlan show-plan 'Plan'; }

assert_detail_rows_in_order() {
    assert_eq "$1 the detail block sits between the header and the quotas, account above plan" 'true' \
        "$(probe "(() => {
            const popup = $IND._popup;
            const kids = popup._bodyBox.get_children();
            const rows = popup._details.get_children();
            return kids.indexOf(popup._details) === kids.indexOf(popup._metaBox) + 1
                && kids.indexOf(popup._blockBox) === kids.indexOf(popup._details) + 1
                && rows.indexOf(popup._account.name) < rows.indexOf(popup._plan.name);
        })()")"
}

assert_detail_values_aligned() {
    await_paint
    assert_eq "$1 the detail labels start at one x and the values at another" 'true' \
        "$(probe "(() => {
            const popup = $IND._popup;
            const x = actor => actor.get_transformed_position()[0];
            const both = popup._account.name.visible && popup._plan.name.visible;
            return !both || (x(popup._account.name) === x(popup._plan.name)
                && x(popup._account.value) === x(popup._plan.value)
                && x(popup._account.value) > x(popup._account.name));
        })()")"
}

assert_detail_margins_match_header() {
    await_paint
    assert_eq "$1 the detail block keeps the header's bottom margin" 'true' \
        "$(probe "(() => {
            const popup = $IND._popup;
            const pad = actor => actor.get_theme_node().get_padding(imports.gi.St.Side.BOTTOM);
            return pad(popup._details) === pad(popup._metaBox);
        })()")"
}

assert_hidden_details_take_no_space() {
    assert_eq "$1 the detail block is gone, with its margin, when both rows are" 'true' \
        "$(probe "(() => {
            const popup = $IND._popup;
            const rows = [popup._account, popup._plan];
            const any = rows.some(row => row.name.visible);
            return popup._details.visible === any;
        })()")"
}

assert_details_within_popup() {
    assert_eq "$1 the detail rows never widen the popup" 'true' \
        "$(probe "(() => {
            const popup = $IND._popup;
            const shown = popup._details.visible;
            const width = $IND.menu.box.get_preferred_width(-1)[1];
            popup._details.visible = false;
            const without = $IND.menu.box.get_preferred_width(-1)[1];
            popup._details.visible = shown;
            return width === without;
        })()")"
}

stage_details() {
    shell_eval "$IND._accountEmail = $1; $IND._accountPlan = $2; $IND._render(); 'ok'" >/dev/null
}

assert_no_detail_hides_its_row() {
    render_state normal
    stage_details null null
    assert_account_row "$1-no-email"
    assert_plan_row "$1-no-plan"
    assert_hidden_details_take_no_space "$1-no-details"
}

stage_detail_setting() {
    shell_eval "$IND._prefs.set_boolean('$1', $2); 'ok'" >/dev/null
}

assert_setting_hides_its_row() {
    render_state normal
    stage_detail_setting show-account false
    assert_account_row "$1-account-setting-off"
    assert_plan_row "$1-account-setting-off"
    stage_detail_setting show-account true
    stage_detail_setting show-plan false
    assert_plan_row "$1-plan-setting-off"
    assert_account_row "$1-plan-setting-off"
    stage_detail_setting show-plan true
}

assert_details_off_by_default() {
    assert_eq "$1 the detail rows are off in the schema" 'true' \
        "$(probe "['show-account', 'show-plan'].every(key => $IND._prefs.get_default_value(key).unpack() === false)")"
}

LANGUAGE_LIMITS="[{kind: 'session', group: 'session', percent: 7}, {kind: 'weekly_all', group: 'weekly', percent: 12}]"
BLOCK_NAMES="$IND._popup._blocks.map(b => b._name.text).join('|')"

po_msgstr() {
    awk -v id="msgid \"$1\"" '$0 == id { getline; sub(/^msgstr "/, ""); sub(/"$/, ""); print; exit }' "$ROOT/po/$2.po"
}

block_names_in() {
    shell_eval "$IND._limits = $LANGUAGE_LIMITS; $IND._prefs.set_string('language', '$1'); 'ok'" >/dev/null
    shell_eval "$BLOCK_NAMES" | unwrap
}

reset_language() {
    shell_eval "$IND._prefs.set_string('language', ''); $IND._limits = []; 'ok'" >/dev/null
    render_state normal
}

assert_language_forces_catalog() {
    assert_eq "$1 a forced French renames the quotas live" \
        "$(po_msgstr 'Session (5h)' fr)|$(po_msgstr Weekly fr)" "$(block_names_in fr)"
    reset_language
}

assert_language_forces_english() {
    assert_eq "$1 a forced English ignores the session language" 'Session (5h)|Weekly' "$(block_names_in en)"
    reset_language
}

assert_language_automatic() {
    block_names_in fr >/dev/null
    assert_eq "$1 Automatic returns to the session language" \
        "$(catalog_msg 'Session (5h)')|$(catalog_msg Weekly)" "$(block_names_in '')"
    reset_language
}

assert_language_forces_either_probe() {
    assert_language_forces_catalog control
    assert_language_forces_english control
}

assert_state() {
    assert_account_row "$1"
    assert_plan_row "$1"
    assert_detail_rows_in_order "$1"
    assert_account_fits_its_column "$1"
    assert_detail_values_aligned "$1"
    assert_detail_margins_match_header "$1"
    assert_hidden_details_take_no_space "$1"
    assert_details_within_popup "$1"
    assert_rows_filled "$1"
    assert_no_placeholders "$1"
    assert_block_count "$1"
    assert_panel_matches "$1"
    assert_rate_limit_note "$1"
    assert_incident_window "$1"
    assert_incident_within_popup "$1"
}

assert_theme_differs() {
    [ "${#THEMES[@]}" -eq 2 ] || return 0
    local dark light
    set_theme dark
    render_state critical
    dark="$(probe "$CRITICAL_COLOR")"
    set_theme light
    render_state critical
    light="$(probe "$CRITICAL_COLOR")"
    assert_ne 'critical severity repaints per scheme' "$dark" "$light"
    assert_not_empty 'critical severity resolves a colour' "$dark"
}

assert_threshold_repaints() {
    local before after
    before="$(probe "$IND._popup._blocks[0]._percent.get_style_class_name()")"
    set_quota_pref warning-percent 5
    after="$(probe "$IND._popup._blocks[0]._percent.get_style_class_name()")"
    set_quota_pref warning-percent 75
    assert_ne "$1 a lower warning threshold repaints a normal quota" "$before" "$after"
}

assert_scope_leaves_the_bar() {
    local before after
    before="$(probe "$SHOWN_CELLS.length")"
    set_quota_pref weekly-in-bar false
    after="$(probe "$SHOWN_CELLS.length")"
    set_quota_pref weekly-in-bar true
    assert_eq "$1 hiding the weekly quota takes a cell out of the bar" \
        "$((before - 1))" "$after"
}

assert_scope_leaves_the_menu() {
    local hidden
    set_quota_pref weekly-in-menu false
    hidden="$(probe "$IND._popup._blocks.length")"
    set_quota_pref weekly-in-menu true
    assert_eq "$1 hiding the weekly quota takes a block out of the menu" \
        "$(( $(probe "$IND._quotas.length") - 1 ))" "$hidden"
}

assert_all_hidden_says_so() {
    set_quota_pref session-in-menu false
    set_quota_pref weekly-in-menu false
    set_quota_pref scoped-in-menu false
    local shown text
    shown="$(probe "$IND._popup._hiddenNote.mapped")"
    text="$(probe "$IND._popup._hiddenNote.text")"
    set_quota_pref session-in-menu true
    set_quota_pref weekly-in-menu true
    set_quota_pref scoped-in-menu true
    assert_eq "$1 a menu with every quota hidden says why it is empty" 'true' "$shown"
    assert_ne "$1 the hidden note carries a string" '""' "$text"
}

# Fetched data with every quota hidden from the bar empties the same list the
# no-data fallback reads as empty, so the panel's own ellipsis/dash floor is the
# wrong thing to distinguish them: .mapped is the ancestor-aware read, since a
# leftover child can sit at visible=true behind a box the fit hid.
assert_bar_all_hidden_shows_icon_only() {
    set_quota_pref session-in-bar false
    set_quota_pref weekly-in-bar false
    set_quota_pref scoped-in-bar false
    local mapped
    mapped="$(probe "$IND._panel._box.mapped")"
    set_quota_pref session-in-bar true
    set_quota_pref weekly-in-bar true
    set_quota_pref scoped-in-bar true
    assert_eq "$1 hiding every quota from the bar leaves only the icon" 'false' "$mapped"
}

# The note reading as attached to whatever sits beside it is a packing-order bug,
# so the proof is geometry: a row of its own sits below the meta line, while a
# label merely sharing _body's own row sits beside it at roughly the same height.
assert_hidden_note_own_line() {
    set_quota_pref session-in-menu false
    set_quota_pref weekly-in-menu false
    set_quota_pref scoped-in-menu false
    local below
    below="$(probe "(() => {
        const [, my] = $IND._popup._metaBox.get_transformed_position();
        const [, mh] = $IND._popup._metaBox.get_transformed_size();
        const [, ny] = $IND._popup._hiddenNote.get_transformed_position();
        return ny >= my + mh;
    })()")"
    set_quota_pref session-in-menu true
    set_quota_pref weekly-in-menu true
    set_quota_pref scoped-in-menu true
    assert_eq "$1 the all-hidden note sits on its own line, below the meta row" 'true' "$below"
}

assert_hidden_note_offers_settings() {
    set_quota_pref session-in-menu false
    set_quota_pref weekly-in-menu false
    set_quota_pref scoped-in-menu false
    local shown label below
    shown="$(probe "$IND._popup._hiddenNoteButton.mapped")"
    label="$(probe "$IND._popup._hiddenNoteButton.label")"
    below="$(probe "(() => {
        const [, ny] = $IND._popup._hiddenNote.get_transformed_position();
        const [, nh] = $IND._popup._hiddenNote.get_transformed_size();
        const [, by] = $IND._popup._hiddenNoteButton.get_transformed_position();
        return by >= ny + nh;
    })()")"
    set_quota_pref session-in-menu true
    set_quota_pref weekly-in-menu true
    set_quota_pref scoped-in-menu true
    assert_eq "$1 the all-hidden note offers a way into the settings" 'true' "$shown"
    assert_ne "$1 the settings button carries a label" '""' "$label"
    assert_eq "$1 the settings button sits under the note, not beside it" 'true' "$below"
}

assert_account_row_probe() { assert_account_row control; }
assert_plan_row_probe() { assert_plan_row control; }
assert_detail_rows_in_order_probe() { assert_detail_rows_in_order control; }
assert_detail_values_aligned_probe() { assert_detail_values_aligned control; }
assert_account_fits_its_column_probe() { assert_account_fits_its_column control; }
assert_account_fit_ignores_scale_probe() { assert_account_fit_ignores_scale control; }
assert_detail_margins_match_header_probe() { assert_detail_margins_match_header control; }
assert_hidden_details_take_no_space_probe() { assert_hidden_details_take_no_space control; }
assert_details_within_popup_probe() { assert_details_within_popup control; }
assert_rows_filled_probe() { assert_rows_filled control; }
assert_no_placeholders_probe() { assert_no_placeholders control; }
assert_block_count_probe() { assert_block_count control; }
assert_panel_matches_probe() { assert_panel_matches control; }
assert_rate_limit_note_probe() { assert_rate_limit_note control; }
assert_incident_window_probe() { assert_incident_window control; }
assert_incident_within_popup_probe() { assert_incident_within_popup control; }
assert_threshold_repaints_probe() { assert_threshold_repaints control; }
assert_scope_leaves_the_bar_probe() { assert_scope_leaves_the_bar control; }
assert_scope_leaves_the_menu_probe() { assert_scope_leaves_the_menu control; }
assert_all_hidden_says_so_probe() { assert_all_hidden_says_so control; }
assert_bar_all_hidden_shows_icon_only_probe() { assert_bar_all_hidden_shows_icon_only control; }
assert_hidden_note_own_line_probe() { assert_hidden_note_own_line control; }
assert_hidden_note_offers_settings_probe() { assert_hidden_note_offers_settings control; }

prove_state() {
    render_state normal
    prove 'the account row shows the connected account' \
        "shell_eval \"$IND._popup._account.value.text = 'nobody@example.org'; $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_account_row_probe
    prove 'the account setting hides the row' \
        "shell_eval \"$IND._render = () => {}; $IND._prefs.set_boolean('show-account', false); 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._prefs.set_boolean('show-account', true); $IND._render(); 'ok'\" >/dev/null" \
        assert_account_row_probe
    prove 'the plan row shows the plan' \
        "shell_eval \"$IND._popup._plan.value.text = 'Nothing'; $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_plan_row_probe
    prove 'the plan setting hides the row' \
        "shell_eval \"$IND._render = () => {}; $IND._prefs.set_boolean('show-plan', false); 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._prefs.set_boolean('show-plan', true); $IND._render(); 'ok'\" >/dev/null" \
        assert_plan_row_probe
    prove 'the detail block sits between the header and the quotas, account above plan' \
        "shell_eval \"const d = $IND._popup._details, n = $IND._popup._account.name; d.remove_child(n); d.add_child(n); 'ok'\" >/dev/null" \
        "shell_eval \"const d = $IND._popup._details, n = $IND._popup._account.name; d.remove_child(n); d.insert_child_at_index(n, 0); 'ok'\" >/dev/null" \
        assert_detail_rows_in_order_probe
    prove 'the account value fits its column' \
        "shell_eval \"$IND._render = () => {}; $IND._popup._account.value.text = 'a'.repeat(120); 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_account_fits_its_column_probe
    prove 'the account value is fitted the same at any monitor scale' \
        "shell_eval \"const p = $IND._popup; const w = p._valueWidth.bind(p); p._valueWidth = () => w() / p._account.value.get_resource_scale(); 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._popup._valueWidth; 'ok'\" >/dev/null" \
        assert_account_fit_ignores_scale_probe
    prove 'the detail values share a column' \
        "shell_eval \"$IND._popup._plan.value.translation_x = 20; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._popup._plan.value.translation_x = 0; 'ok'\" >/dev/null" \
        assert_detail_values_aligned_probe
    prove 'the detail block keeps the header margin' \
        "shell_eval \"$IND._popup._details.set_style('padding-bottom: 30px'); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._popup._details.set_style(null); 'ok'\" >/dev/null" \
        assert_detail_margins_match_header_probe
    prove 'the detail block disappears with its rows' \
        "shell_eval \"$IND._render = () => {}; $IND._popup._details.visible = false; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_hidden_details_take_no_space_probe
    prove 'the account value stays inside the popup' \
        "shell_eval \"$IND._popup._details.set_style('max-width: 2000px'); $IND._popup._account.value.text = 'a'.repeat(200); $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._popup._details.set_style(null); $IND._render(); 'ok'\" >/dev/null" \
        assert_details_within_popup_probe
    prove 'the plan value stays inside the popup' \
        "shell_eval \"$IND._popup._details.set_style('max-width: 2000px'); $IND._popup._plan.value.text = 'a'.repeat(200); $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._popup._details.set_style(null); $IND._render(); 'ok'\" >/dev/null" \
        assert_details_within_popup_probe
    prove 'rows filled' \
        "shell_eval \"$IND._popup._blocks[0]._caption.text = ''; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_rows_filled_probe
    prove 'no placeholder leaked' \
        "shell_eval \"$IND._popup._blocks[0]._name.text = 'undefined'; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_no_placeholders_probe
    prove 'block count' \
        "shell_eval \"$IND._popup._blocks.pop().destroy(); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._popup._blocks = []; $IND._render(); 'ok'\" >/dev/null" \
        assert_block_count_probe
    prove 'panel agrees with blocks' \
        "shell_eval \"${PANEL_CELLS}[0].label.set_text('S 0%'); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_panel_matches_probe
    prove 'header states the retry time while blocked, the last refresh otherwise' \
        "shell_eval \"$IND._popup._refreshLabel.text = 'retry at 9:00'; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_rate_limit_note_probe
    render_state service-maintenance-day
    prove 'incident line names the end of the window' \
        "shell_eval \"$IND._popup._issueItem.label.text = '🚧 Under maintenance'; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_incident_window_probe
    prove 'incident line stays inside the popup' \
        "shell_eval \"$IND._popup._issueItem.label.text = 'until '.repeat(40); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_incident_within_popup_probe
    render_state service-quota-ok
    prove 'incident emoji trails the quota cells' \
        "shell_eval \"$IND._service = null; $IND._render(); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._service = {status: 'partial_outage', until: null}; $IND._render(); 'ok'\" >/dev/null" \
        assert_issue_trails_quota_probe
    stage_service operational
    prove 'an operational component carries no issue emoji' \
        "stage_service partial_outage" \
        "stage_service operational" \
        assert_no_issue_while_operational_probe
    render_state normal
    prove 'a lower warning threshold repaints' \
        "shell_eval \"$IND._popup._blocks[0]._percent.style_class = 'cq-percent cq-warning-dark'; $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_threshold_repaints_probe
    render_state normal
    prove 'hiding a scope empties its cell' \
        "shell_eval \"$IND._visibleOn = (surface, views) => views; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._visibleOn; $IND._render(); 'ok'\" >/dev/null" \
        assert_scope_leaves_the_bar_probe
    prove 'hiding every quota from the bar leaves only the icon' \
        "shell_eval \"$IND._panel._box.visible = true; $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_bar_all_hidden_shows_icon_only_probe
    prove 'hiding a scope empties its block' \
        "shell_eval \"$IND._visibleOn = (surface, views) => views; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._visibleOn; $IND._render(); 'ok'\" >/dev/null" \
        assert_scope_leaves_the_menu_probe
    prove 'an all-hidden menu explains itself' \
        "shell_eval \"$IND._popup._hiddenNote.visible = false; $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_all_hidden_says_so_probe
    prove 'the all-hidden note occupies its own line' \
        "shell_eval \"$IND._popup._hiddenNoteBox.remove_child($IND._popup._hiddenNote); $IND._popup._body.add_child($IND._popup._hiddenNote); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._popup._body.remove_child($IND._popup._hiddenNote); $IND._popup._hiddenNoteBox.insert_child_at_index($IND._popup._hiddenNote, 0); 'ok'\" >/dev/null" \
        assert_hidden_note_own_line_probe
    prove 'the all-hidden note offers a way into the settings' \
        "shell_eval \"$IND._popup._hiddenNoteButton.visible = false; $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_hidden_note_offers_settings_probe
    prove 'a forced language reaches the popup' \
        "shell_eval \"$IND._keptApply = $IND._applyLanguage; $IND._applyLanguage = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._applyLanguage = $IND._keptApply; delete $IND._keptApply; 'ok'\" >/dev/null" \
        assert_language_forces_either_probe
}

subset_kind() {
    if [ "$SHOOT_MODE" = 'none' ] || [ "${#PICKED[@]}" -gt 0 ] || [ "${#THEMES[@]}" -lt 2 ]; then
        echo subset
    else
        echo full
    fi
}

PREVIEW="$ROOT/tools/preview.sh"

# A dead session's attach_session fails, so preview.sh falls through to starting
# a brand-new one and blocks in `wait` forever — a command substitution calling
# it would then never return, hanging the suite instead of failing it.
# --notify=off on every preview call, because a banner draws top-centre over a capture
# rect that starts at y=0. The notify group drives the record itself instead, which is
# what makes an assertion here repeatable rather than dependent on what a shoot left up.
preview() {
    session_live || die 'the e2e session died'
    "$PREVIEW" --session=e2e --notify=off "$@"
}

# The theme is set once per row rather than per scenario: set_theme sleeps two
# seconds, and preview.sh leaves an omitted dimension alone.
# Every state the tiles show is a settled one, and the transitions into them only
# decide how long a shot must wait. Shooting with them off is the same pixels sooner,
# and it pins the spinner to one angle instead of wherever the shot landed.
group_state() {
    prepare_out "$(subset_kind)"
    prove_state
    set_animations false
    local theme scenario shot
    for theme in "${THEMES[@]}"; do
        preview "--$theme" >/dev/null
        echo "$theme:"
        for scenario in "${SCENARIOS[@]}"; do
            if shoots "$scenario"; then
                shot="$(preview --scenario="$scenario" --capture)"
                SHOTS+=("$shot")
                echo "  $shot"
            else
                preview --scenario="$scenario" >/dev/null
            fi
            assert_state "$theme-$scenario"
        done
        render_state normal
        assert_scope_leaves_the_bar "$theme"
        assert_scope_leaves_the_menu "$theme"
        assert_all_hidden_says_so "$theme"
        assert_bar_all_hidden_shows_icon_only "$theme"
        assert_hidden_note_own_line "$theme"
        assert_hidden_note_offers_settings "$theme"
        assert_issue_rides_healthy_quota "$theme"
        assert_operational_clears_the_issue "$theme"
        assert_no_detail_hides_its_row "$theme"
        assert_setting_hides_its_row "$theme"
        assert_details_off_by_default "$theme"
    done
    assert_account_fit_ignores_scale state
    assert_language_forces_catalog state
    assert_language_forces_english state
    assert_language_automatic state
    set_animations true
    assert_theme_differs
    [ "${#SHOTS[@]}" -eq 0 ] || { normalize; overview; }
}

PANEL_CELLS="$IND._panel._cells"
SHOWN_CELLS="$PANEL_CELLS.filter(c => c.actor.visible)"
PANEL_NATURAL="$IND.container.get_preferred_width(-1)[1]"

assert_panel_cells() {
    assert_eq "$1 panel shows $2 cell(s)" "$2" "$(probe "$SHOWN_CELLS.length")"
}

assert_panel_drops_from_the_right() {
    assert_eq "$1 panel drops from the right" 'true' \
        "$(probe "(() => {
            const kept = $IND._panel._keepOrder.map(c => c.actor.visible);
            return kept.every((visible, n) => n === 0 || !visible || kept[n - 1]);
        })()")"
}

assert_panel_within_budget() {
    assert_eq "$1 panel fits the space the shell gives it" 'true' \
        "$(probe "$SHOWN_CELLS.length === 0 || $PANEL_NATURAL <= $IND._panel._budget()")"
}

assert_panel_separators() {
    assert_eq "$1 only a value with something before it carries a dot" 'true' \
        "$(probe "(() => {
            let earlier = false;
            return $PANEL_CELLS.every(cell => {
                const want = cell.actor.visible && earlier;
                earlier = earlier || cell.actor.visible;
                return !cell.dot || cell.dot.visible === want;
            });
        })()")"
}

assert_panel_keeps_icon() {
    assert_eq "$1 the icon is the floor" 'true' "$(probe "$IND._panel._icon.visible")"
}

assert_panel_shape() {
    assert_panel_drops_from_the_right "$1"
    assert_panel_within_budget "$1"
    assert_panel_separators "$1"
    assert_panel_keeps_icon "$1"
}

assert_panel_cells_probe() { assert_panel_cells control 3; }
assert_panel_drops_from_the_right_probe() { assert_panel_drops_from_the_right control; }
assert_panel_within_budget_probe() { assert_panel_within_budget control; }
assert_panel_separators_probe() { assert_panel_separators control; }

refit_panel() {
    shell_eval "$IND._panel.fit(); 'ok'" >/dev/null
}

# A fit still queued for the next redraw would land on top of a deliberate break and
# repair it, which reads as an assertion that cannot fail.
settle_panel() {
    for _ in $(seq 70); do
        [ "$(probe "$IND._panel._fitLaterId")" = '0' ] && { await_paint; return 0; }
        sleep 0.15
    done
    die 'the panel never stopped refitting'
}

# Every restore is the fit itself: repairing the actors by hand would prove the
# assertion and not the fit.
prove_panel() {
    settle_panel
    prove 'panel shows every value it has room for' \
        "shell_eval \"${PANEL_CELLS}[0].actor.visible = false; 'ok'\" >/dev/null" \
        refit_panel \
        assert_panel_cells_probe
    prove 'panel drops from the right' \
        "shell_eval \"$IND._panel._keepOrder[1].actor.visible = false; 'ok'\" >/dev/null" \
        refit_panel \
        assert_panel_drops_from_the_right_probe
    prove 'only a value with something before it carries a dot' \
        "shell_eval \"${PANEL_CELLS}[1].dot.visible = false; 'ok'\" >/dev/null" \
        refit_panel \
        assert_panel_separators_probe
}

prove_panel_squeezed() {
    settle_panel
    prove 'panel fits the space the shell gives it' \
        "shell_eval \"$IND._panel._showCells($PANEL_CELLS.length); 'ok'\" >/dev/null" \
        refit_panel \
        assert_panel_within_budget_probe
}

group_panel() {
    echo 'panel:'
    render_state model-scoped
    prove_panel
    assert_panel_cells 'wide' 3
    assert_panel_shape 'wide'
    render_state model-scoped-issue
    assert_panel_cells 'widest' 4
    assert_panel_shape 'widest'
    local scenario
    for scenario in narrow-two narrow-one narrow-icon narrow-issue; do
        render_state "$scenario"
        [ "$scenario" = 'narrow-one' ] && prove_panel_squeezed
        assert_panel_cells "$scenario" "$(narrow_cells "$scenario")"
        assert_panel_shape "$scenario"
    done
    assert_eq 'the incident emoji outlives every value' 'true' \
        "$(probe "${PANEL_CELLS}[$PANEL_CELLS.length - 1].actor.visible")"
    assert_panel_refits_unprompted
}

# Nothing calls _fitPanel here: taking the space back has to be enough on its own,
# the way another indicator leaving the panel is.
assert_panel_refits_unprompted() {
    render_state narrow-icon
    assert_panel_cells 'squeezed' 0
    shell_eval "$FILLER?.destroy(); $FILLER = null; 'ok'" >/dev/null
    sleep 1
    assert_panel_cells 'space returned' 3
}

QS="Main.panel.statusArea.quickSettings"

hover_shape() {
    probe "[$1.hover, $1.get_style_pseudo_class(), $1.track_hover].join('|')"
}

# The session's first pointer motion closes the menu when it lands inside it, so
# the pointer is moved once while the menu is deliberately shut.
reopen_menu() {
    close_menu
    point_at away
    open_menu
    await_paint
}

assert_panel_matches_platform() {
    local hovered
    close_menu
    point_at away
    assert_eq 'panel resting matches quickSettings' "$(hover_shape "$QS")" "$(hover_shape "$IND")"
    point_at_actor "$QS"
    hovered="$(hover_shape "$QS")"
    point_at pill
    assert_eq 'panel hovered matches quickSettings' "$hovered" "$(hover_shape "$IND")"
    reopen_menu
}

assert_display_rows_inert() {
    local row
    for row in _body _message; do
        point_at_actor "$IND._popup.$row"
        assert_eq "$row does not track hover" 'false' "$(probe "$IND._popup.$row.track_hover")"
        assert_eq "$row takes no hover class" 'true' \
            "$(probe "!/hover|active/.test($IND._popup.$row.get_style_pseudo_class() ?? '')")"
    done
}

assert_status_row_highlights() {
    point_at_actor "$IND._popup._issueItem"
    assert_eq 'status row tracks hover' 'true' "$(probe "$IND._popup._issueItem.track_hover")"
    assert_eq 'status row highlights' 'true' \
        "$(probe "/hover/.test($IND._popup._issueItem.get_style_pseudo_class() ?? '')")"
    point_at away
}

prove_hover() {
    prove 'panel matches platform' \
        "shell_eval \"$IND.track_hover = false; 'ok'\" >/dev/null" \
        "shell_eval \"$IND.track_hover = true; 'ok'\" >/dev/null" \
        assert_panel_matches_platform
    prove 'display rows inert' \
        "shell_eval \"$IND._popup._body.track_hover = true; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._popup._body.track_hover = false; 'ok'\" >/dev/null" \
        assert_display_rows_inert
}

prove_status_row() {
    prove 'status row highlights' \
        "shell_eval \"$IND._popup._issueItem.track_hover = false; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._popup._issueItem.track_hover = true; 'ok'\" >/dev/null" \
        assert_status_row_highlights
}

# error is the only scenario where both display rows are visible, and service-major
# the only one where the status row is: _renderMessage blanks the message whenever
# it has a service issue to show instead.
group_hover() {
    echo 'hover:'
    render_state error
    reopen_menu
    prove_hover
    assert_panel_matches_platform
    assert_display_rows_inert
    render_state service-major
    reopen_menu
    prove_status_row
    assert_status_row_highlights
}

# freeze stubs the instance's _refresh, so without the delete the click runs
# nothing and every assertion below describes a refresh that never started. The
# fetch never settles because a real poll resolves before the spinner is read.
unfreeze_refresh() {
    shell_eval "delete $IND._refresh;
        $IND._poller.refresh = () => new Promise(() => {});
        'ok'" >/dev/null
}

refreeze_refresh() {
    shell_eval "$IND._refreshing = false;
        delete $IND._poller.refresh;
        $IND._refresh = () => {};
        $IND._render();
        'ok'" >/dev/null
}

# St.Button::clicked carries the button number, and emitting it without one is
# refused outright — the click then runs nothing and no assertion below can tell.
click_refresh() {
    shell_eval "$IND._popup._refreshButton.emit('clicked', 1); 'ok'" >/dev/null
}

assert_menu_survives_refresh() {
    assert_eq 'menu stays open through a refresh' 'true' "$(probe "$IND.menu.isOpen")"
}

assert_spinner_runs() {
    assert_eq 'refresh icon spins' 'true' \
        "$(probe "$IND._popup._refreshButton.child.get_transition('spin') !== null")"
    assert_eq 'refresh button is insensitive while refreshing' 'false' \
        "$(probe "$IND._popup._refreshButton.reactive")"
}

assert_spinner_cleared() {
    assert_eq 'spin transition removed' 'true' \
        "$(probe "$IND._popup._refreshButton.child.get_transition('spin') === null")"
    assert_eq 'icon rotation reset' '0' \
        "$(probe "$IND._popup._refreshButton.child.rotation_angle_z")"
}

prove_refresh() {
    prove 'spinner runs' \
        "shell_eval \"$IND._popup._refreshButton.child.remove_transition('spin'); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_spinner_runs
    prove 'menu survives a refresh' \
        "shell_eval \"$IND.menu.close(false); 'ok'\" >/dev/null" \
        "shell_eval \"$IND.menu.open(false); 'ok'\" >/dev/null" \
        assert_menu_survives_refresh
}

# The real endpoint must never answer here either, so the 429 is fabricated — and
# the log is redirected to a temp file, since the live one is the evidence
# tools/quota-attribution.js reads and a test record would corrupt the verdict.
stub_attempt_log() {
    ATTEMPTS_LOG="$(mktemp -t claude-quota-attempts.XXXXXX)"
    shell_eval "delete $IND._refresh;
        $IND._store.attemptsPath = () => '$ATTEMPTS_LOG';
        $IND._poller._client.fetch = () => Promise.reject(Object.assign(new Error('Rate limited'),
            {rateLimited: true, retryAfter: 1, status: 429,
             headers: {'authorization': 'Bearer sk-ant-oat01-STUB',
                       'anthropic-ratelimit-requests-remaining': '0'}}));
        'ok'" >/dev/null
    log_attempt manual
}

restore_attempt_log() {
    shell_eval "delete $IND._poller._client.fetch;
        delete $IND._store.attemptsPath;
        $IND._block = null;
        $IND._refresh = () => {};
        $IND._render();
        'ok'" >/dev/null
    rm -f "$ATTEMPTS_LOG"
    ATTEMPTS_LOG=''
}

# The status poll writes to the same log on its own 60-second timer, so a byte
# count answers "did anything happen" where every assertion here asks "did we
# spend a request" — the two diverged the moment that timer existed.
own_attempts() {
    local count
    count="$(grep -vc '"endpoint":"status"' "$ATTEMPTS_LOG" 2>/dev/null || true)"
    echo "${count:-0}"
}

last_own_attempt() {
    grep -v '"endpoint":"status"' "$ATTEMPTS_LOG" 2>/dev/null | tail -n 1
}

# Three things stop a _refresh short of an upstream attempt, and any of them
# leaves the log unchanged, which reads as a dead assertion: an armed block, the
# minimum interval, and data too fresh for the trigger to want more. All three are
# cleared before each deliberate attempt.
log_attempt() {
    local before
    before="$(own_attempts)"
    shell_eval "$IND._block = null; $IND._lastRequestAt = null;
        $IND._fetchedAt = new Date(Date.now() - 3600000);
        $IND._refresh('$1'); 'ok'" >/dev/null
    for _ in $(seq 100); do
        [ "$(own_attempts)" -gt "$before" ] && return 0
        sleep 0.1
    done
    die "the $1 attempt was never logged"
}

last_attempt_field() {
    last_own_attempt | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

assert_attempt_logged() {
    assert_eq 'attempt records the trigger that caused it' 'manual' "$(last_attempt_field trigger)"
    assert_eq 'attempt records the 429 as its outcome' 'rate-limited' "$(last_attempt_field outcome)"
    assert_eq 'attempt keeps the rate-limit header' '0' \
        "$(last_attempt_field anthropic-ratelimit-requests-remaining)"
    assert_eq 'attempt carries no credential' '' \
        "$(last_own_attempt | grep -oiE 'bearer|authorization|sk-ant' | head -1 || true)"
}

prove_attempt_log() {
    prove 'attempt log records the trigger' \
        'log_attempt timer' \
        'log_attempt manual' \
        assert_attempt_logged
}

# The endpoint answers a run of 401s with an hour's block, so a token already past
# its expiry must cost no request — and must arm nothing, since only a new token
# ends the wait.
stub_expired_token() {
    shell_eval "$IND._poller._client.fetch = () => Promise.reject(Object.assign(
        new Error('Token expired, run Claude Code once'),
        {expired: true, status: null, headers: {}, body: null, durationMs: null,
         expiresAt: new Date(Date.now() - 3600000)}));
        'ok'" >/dev/null
    log_attempt timer
}

stub_server_unauthorized() {
    shell_eval "$IND._poller._client.fetch = () => Promise.reject(Object.assign(
        new Error('Token expired, run Claude Code once'),
        {status: 401, headers: {}, body: null, durationMs: null, expiresAt: null}));
        'ok'" >/dev/null
    log_attempt timer
}

assert_expired_token_declined() {
    assert_eq 'an expired token is logged as declined, not as a server refusal' 'token-expired' \
        "$(last_attempt_field outcome)"
    assert_eq 'declining to send arms no block' 'true' "$(probe "$IND._block === null")"
}

wake_on_renewed_token() {
    shell_eval "globalThis._wokeWith = null;
        $IND._refresh = trigger => { globalThis._wokeWith = trigger; };
        $IND._poller.credentialExpiry = () => new Date(Date.now() + 3600000);
        $IND._seenExpiry = new Date(Date.now() - 3600000);
        $IND._block = {until: new Date(Date.now() + 900000), reason: 'rate-limit'};
        $IND._poller._onCredentialsWritten();
        'ok'" >/dev/null
}

# The hour-long block is scoped to the token that earned it, so the same file
# rewritten with no newer token must leave the block standing.
wake_on_same_token() {
    shell_eval "globalThis._wokeWith = null;
        globalThis._sameExpiry = new Date(Date.now() + 3600000);
        $IND._refresh = trigger => { globalThis._wokeWith = trigger; };
        $IND._poller.credentialExpiry = () => globalThis._sameExpiry;
        $IND._seenExpiry = globalThis._sameExpiry;
        $IND._block = {until: new Date(Date.now() + 900000), reason: 'rate-limit'};
        $IND._poller._onCredentialsWritten();
        'ok'" >/dev/null
}

assert_credentials_wake() {
    assert_eq 'a renewed token clears the block it can no longer be subject to' 'true' \
        "$(probe "$IND._block === null")"
    assert_eq 'a renewed token refreshes at once' 'true' \
        "$(probe "globalThis._wokeWith === 'credentials'")"
}

# Adoption is tried before the block and the interval, so a fresher shared cache
# has to satisfy a refresh that would otherwise have spent a request.
stub_shared_usage() {
    shell_eval "$IND._sharedUsage = () => ({
        fetchedAt: new Date(),
        limits: [{kind: 'session', group: 'session', percent: 41, severity: 'normal',
                  resets_at: new Date(Date.now() + 3600000).toISOString(), scope: null}],
    });
    $IND._block = null; $IND._lastRequestAt = null; $IND._fetchedAt = new Date(Date.now() - 3600000);
    'ok'" >/dev/null
}

stub_stale_shared_usage() {
    shell_eval "$IND._sharedUsage = () => null;
    $IND._block = null; $IND._lastRequestAt = null; $IND._fetchedAt = new Date(Date.now() - 3600000);
    'ok'" >/dev/null
}

assert_shared_adopted() {
    local before after
    before="$(own_attempts)"
    shell_eval "$IND._refresh('timer'); 'ok'" >/dev/null
    sleep 1
    after="$(own_attempts)"
    assert_eq 'a fresher shared cache is adopted' '41' "$(probe "$IND._quotas[0].percent")"
    assert_eq 'adopting spends no request' 'true' "$(probe "$IND._lastRequestAt === null")"
    assert_eq 'the adoption is recorded' 'adopted' \
        "$(last_own_attempt | sed -n 's/.*"outcome":"\([^"]*\)".*/\1/p')"
    assert_ne 'the adoption reached the log' "$before" "$after"
}

restore_shared_usage() {
    shell_eval "delete $IND._sharedUsage; $IND._block = null; 'ok'" >/dev/null
}

prove_shared_adoption() {
    stub_shared_usage
    prove 'a fresher shared cache is used instead of a request' \
        stub_stale_shared_usage \
        stub_shared_usage \
        assert_shared_adopted
}

stub_reachable_endpoint() {
    shell_eval "$IND._poller._client.fetch = () => Promise.reject(Object.assign(
        new Error('Cannot reach api.anthropic.com'),
        {status: null, headers: {}, body: null, durationMs: 7, expiresAt: null}));
        'ok'" >/dev/null
}

spend_one_request() {
    shell_eval "$IND._block = null; $IND._lastRequestAt = null; 'ok'" >/dev/null
    log_attempt timer
}

hold_floor() {
    shell_eval "$IND._block = null; $IND._lastRequestAt = new Date(); 'ok'" >/dev/null
}

drop_floor() {
    shell_eval "$IND._block = null; $IND._lastRequestAt = null; 'ok'" >/dev/null
}

assert_floor_holds() {
    local before after
    before="$(own_attempts)"
    shell_eval "$IND._refresh('manual'); 'ok'" >/dev/null
    sleep 1
    after="$(own_attempts)"
    assert_eq 'a request inside the minimum interval is never sent' "$before" "$after"
    assert_eq 'the refresh button is insensitive while the interval holds' 'false' \
        "$(probe "$IND._popup._refreshButton.reactive")"
}

prove_request_floor() {
    stub_reachable_endpoint
    spend_one_request
    hold_floor
    prove 'the minimum interval between requests' \
        drop_floor \
        hold_floor \
        assert_floor_holds
}

status_attempts() {
    local count
    count="$(grep -c '"endpoint":"status"' "$ATTEMPTS_LOG" 2>/dev/null || true)"
    echo "${count:-0}"
}

# The break stubs the status client before it plants a token, or the poll it unblocks
# reaches status.claude.com for real — which is the thing being fixed.
plant_credentials() {
    shell_eval "$IND._poller._status.fetch = () => Promise.resolve({value: null, status: null,
        headers: {}, body: null, durationMs: 3, error: 'Cannot reach status.claude.com'});
        $IND._poller._statusPolling = false; 'ok'" >/dev/null
    mkdir -p "$SANDBOX_HOME/.claude"
    printf '{}\n' > "$SANDBOX_HOME/.claude/.credentials.json"
}

remove_token() {
    rm -f "$SANDBOX_HOME/.claude/.credentials.json"
}

drop_credentials() {
    remove_token
    shell_eval "$IND._poller._statusPolling = false; 'ok'" >/dev/null
}

# Without a token the poll never leaves, so the teardown assertions on the status
# timer and its cancellable would otherwise hold over objects that never existed.
arm_status_poll() {
    plant_credentials
    shell_eval "$IND._poller._pollStatus(); 'ok'" >/dev/null
    for _ in $(seq 50); do
        [ "$(probe "$IND._poller._statusTimerId !== 0")" = 'true' ] && return 0
        sleep 0.1
    done
    die 'the status poll never armed its timer'
}

assert_status_poll_needs_credentials() {
    local before after
    before="$(status_attempts)"
    shell_eval "$IND._poller._pollStatus(); 'ok'" >/dev/null
    sleep 1
    after="$(status_attempts)"
    assert_eq 'a status poll with no token is never sent' "$before" "$after"
}

prove_status_needs_credentials() {
    drop_credentials
    prove 'a token is what lets the status poll leave' \
        plant_credentials \
        drop_credentials \
        assert_status_poll_needs_credentials
    shell_eval "delete $IND._poller._status.fetch; 'ok'" >/dev/null
}

prove_credentials_recovery() {
    stub_expired_token
    prove 'an expired token costs no request' \
        stub_server_unauthorized \
        stub_expired_token \
        assert_expired_token_declined
    wake_on_renewed_token
    prove 'a renewed token ends the block' \
        wake_on_same_token \
        wake_on_renewed_token \
        assert_credentials_wake
}

restore_credentials_stubs() {
    shell_eval "delete $IND._poller.credentialExpiry;
        delete globalThis._wokeWith;
        $IND._block = null;
        'ok'" >/dev/null
}

assert_prefs_button_after_refresh() {
    assert_eq 'settings button follows the refresh button in the meta row' 'true' "$(probe "(() => {
        const kids = $IND._popup._metaBox.get_children();
        return kids.indexOf($IND._popup._prefsButton) === kids.indexOf($IND._popup._refreshButton) + 1;
    })()")"
}

assert_prefs_button_opens_settings() {
    reopen_menu
    shell_eval "globalThis._prefsOpened = false;
        $IND._openPrefs = () => { globalThis._prefsOpened = true; };
        $IND._popup._prefsButton.emit('clicked', 1);
        'ok'" >/dev/null
    assert_eq 'settings button opens the preferences' 'true' "$(probe "globalThis._prefsOpened === true")"
    assert_eq 'settings button closes the menu' 'false' "$(probe "$IND.menu.isOpen")"
}

prove_prefs_button() {
    prove 'settings button sits after refresh' \
        "shell_eval \"$IND._popup._metaBox.set_child_below_sibling($IND._popup._prefsButton, $IND._popup._refreshButton); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._popup._metaBox.set_child_above_sibling($IND._popup._prefsButton, $IND._popup._refreshButton); 'ok'\" >/dev/null" \
        assert_prefs_button_after_refresh
    prove 'settings button opens the preferences' \
        "shell_eval \"globalThis._origPrefs = $IND._popup._onOpenPrefs; $IND._popup._onOpenPrefs = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._popup._onOpenPrefs = globalThis._origPrefs; 'ok'\" >/dev/null" \
        assert_prefs_button_opens_settings
}

group_refresh() {
    echo 'refresh:'
    render_state normal
    reopen_menu
    unfreeze_refresh
    click_refresh
    sleep 1
    prove_refresh
    assert_menu_survives_refresh
    assert_spinner_runs
    prove_prefs_button
    reopen_menu
    refreeze_refresh
    sleep 1
    assert_spinner_cleared
    stub_attempt_log
    prove_attempt_log
    assert_attempt_logged
    prove_shared_adoption
    assert_shared_adopted
    restore_shared_usage
    prove_request_floor
    assert_floor_holds
    prove_status_needs_credentials
    assert_status_poll_needs_credentials
    prove_credentials_recovery
    assert_expired_token_declined
    assert_credentials_wake
    restore_credentials_stubs
    restore_attempt_log
}

LIVE_ALERTS="[...$IND._alerts._live.keys()].sort()"

# The comparison is made in the session because a string cannot come back through
# probe intact, and the expected list is spelled as a JS array literal because a
# backslash anywhere in the argument defeats gdbus's fallback to a plain string —
# an escaped JSON string would fail the Eval outright rather than the assertion.
assert_alert_keys() {
    assert_eq "$1 live alerts" 'true' \
        "$(probe "JSON.stringify($LIVE_ALERTS) === JSON.stringify($2)")"
}

assert_source_holds_every_alert() {
    assert_eq "$1 every live alert is in the tray" 'true' \
        "$(probe "[...$IND._alerts._live.values()].every(n =>
            ($IND._alerts._source?.notifications ?? []).includes(n)) &&
            $IND._alerts._live.size === ($IND._alerts._source?.notifications ?? []).length")"
}

assert_alert_urgency() {
    assert_eq "$1 urgency escalates with the level" 'true' \
        "$(probe "[...$IND._alerts._live.entries()].every(([key, n]) =>
            n.urgency === (key.endsWith('|critical') ? 2 : 1))")"
}

assert_alert_titles_name_the_quota() {
    local infix
    infix="$(js_string "$(catalog_infix '{name} at {percent}')")"
    assert_eq "$1 each title joins a quota name to its percentage" 'true' \
        "$(probe "[...$IND._alerts._live.entries()].every(([key, n]) => {
            const quota = $IND._quotas.find(q => key.startsWith(q.key + '|'));
            return n.title.includes($infix) && n.title.includes(quota.name) &&
                n.title.includes(String(quota.percent));
        })")"
}

assert_one_alert_per_quota() {
    assert_eq "$1 a quota shows one banner at a time" 'true' \
        "$(probe "new Set(($LIVE_ALERTS).map(k => k.split('|')[0])).size === ($LIVE_ALERTS).length")"
}

assert_alerts() {
    assert_source_holds_every_alert "$1"
    assert_alert_urgency "$1"
    assert_alert_titles_name_the_quota "$1"
    assert_one_alert_per_quota "$1"
}

# A joined string cannot come back through probe — unwrap strips the quotes and
# leaves JSON's escaping behind — so each default is read as a number of its own.
schema_default() {
    probe "$IND._prefs.get_default_value('$1-percent').unpack()"
}

# The schema's defaults and lib/notify.js's NOTIFY_DEFAULTS are two declarations of
# one decision, and the indicator is the only thing that reads both.
assert_schema_defaults_agree() {
    local declared
    declared="$(node --input-type=module -e \
        "import {NOTIFY_DEFAULTS} from '$ROOT/lib/notify.js';
         console.log([NOTIFY_DEFAULTS.warning, NOTIFY_DEFAULTS.critical].join('/'));")"
    assert_eq "$1 the schema thresholds are the ones lib/notify.js assumes" \
        "$declared" "$(schema_default warning)/$(schema_default critical)"
}

assert_source_holds_every_alert_probe() { assert_source_holds_every_alert control; }
assert_alert_urgency_probe() { assert_alert_urgency control; }
assert_alert_titles_probe() { assert_alert_titles_name_the_quota control; }
assert_one_alert_per_quota_probe() { assert_one_alert_per_quota control; }
assert_schema_defaults_agree_probe() { assert_schema_defaults_agree control; }

prove_alerts() {
    reset_alerts
    render_state critical
    sync_alerts
    prove 'every live alert is in the tray' \
        "shell_eval \"const i = $IND;
            globalThis._ghost = new (i._alerts._live.values().next().value.constructor)(
                {source: i._alerts._source, title: 'ghost'});
            i._alerts._live.set('ghost|warning', globalThis._ghost); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._alerts._live.delete('ghost|warning');
            globalThis._ghost.destroy(1); delete globalThis._ghost; 'ok'\" >/dev/null" \
        assert_source_holds_every_alert_probe
    prove 'urgency escalates with the level' \
        "shell_eval \"[...$IND._alerts._live.values()].forEach(n => { n.urgency = 1; }); 'ok'\" >/dev/null" \
        "shell_eval \"[...$IND._alerts._live.entries()].forEach(([k, n]) => { n.urgency = k.endsWith('|critical') ? 2 : 1; }); 'ok'\" >/dev/null" \
        assert_alert_urgency_probe
    prove 'each title joins a quota name to its percentage' \
        "shell_eval \"[...$IND._alerts._live.values()].forEach(n => { n.title = 'nothing here'; }); 'ok'\" >/dev/null" \
        "shell_eval \"const i = $IND; [...i._alerts._live.keys()].forEach(k => i._alerts._withdrawAlert(k));
            i._fired = {}; i._syncAlerts(new Date()); 'ok'\" >/dev/null" \
        assert_alert_titles_probe
    prove 'a quota shows one banner at a time' \
        "shell_eval \"$IND._alerts._live.set('Session (5h)|warning', $IND._alerts._live.values().next().value); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._alerts._live.delete('Session (5h)|warning'); 'ok'\" >/dev/null" \
        assert_one_alert_per_quota_probe
}

# Setting a key cannot move its default, so the break replaces the reader itself
# with a value the schema never declares.
prove_schema_defaults() {
    prove 'the schema thresholds are the ones lib/notify.js assumes' \
        "shell_eval \"$IND._prefs.get_default_value = () => new imports.gi.GLib.Variant('i', 1); 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._prefs.get_default_value; 'ok'\" >/dev/null" \
        assert_schema_defaults_agree_probe
}

# Expiry has to be driven onto a state whose percentages still stand above both
# thresholds. On a scenario that expires and drops to 40/60 the alerts go quiet on
# the percent drop alone, so the verdict holds with or without the markExpired the
# planner is given — proving nothing about the one line the sync exists to apply.
expire_windows() {
    shell_eval "const i = $IND;
        i._quotas = i._quotas.map(q => ({...q, resetsAt: new Date(Date.now() - 300000)}));
        'ok'" >/dev/null
}

# Every other scenario here calls _syncAlerts by hand, which leaves the feature's
# primary trigger — a poll that answered — driven by nothing at all: deleting the
# sync from _applyResult used to keep the whole suite green. This one hands
# _applyResult a fabricated payload and lets the extension find its own way there.
apply_polled_result() {
    reset_alerts
    shell_eval "$IND._applyResult({error: null, expiresAt: null, payload: {limits: [
        {kind: 'session', group: 'session', percent: $1, severity: 'critical',
         resets_at: new Date(Date.now() + 900000).toISOString(), scope: null}]}});
        'ok'" >/dev/null
}

assert_polled_alert() {
    assert_eq 'a poll that answered posts its own alert' 'true' \
        "$(probe "[...$IND._alerts._live.keys()].includes('session|critical')")"
}

prove_polled_alert() {
    apply_polled_result 97
    prove 'a poll that answered posts its own alert' \
        'apply_polled_result 10' \
        'apply_polled_result 97' \
        assert_polled_alert
}

group_notify() {
    echo 'notify:'
    prove_schema_defaults
    assert_schema_defaults_agree 'shipped'
    prove_alerts
    reset_alerts
    render_state normal
    sync_alerts
    assert_alert_keys 'quiet' '[]'
    render_state warning
    sync_alerts
    assert_alert_keys 'warning' "['Session (5h)|warning','Weekly|warning']"
    assert_alerts 'warning'
    sync_alerts
    assert_alert_keys 'warning re-synced' "['Session (5h)|warning','Weekly|warning']"
    assert_alerts 'warning re-synced'
    reset_alerts
    render_state critical
    sync_alerts
    assert_alert_keys 'critical' "['Session (5h)|critical','Weekly|critical']"
    assert_alerts 'critical'
    expire_windows
    sync_alerts
    assert_alert_keys 'expired at critical' '[]'
    assert_eq 'expired empties the source with the last alert' 'null' \
        "$(probe "$IND._alerts._source")"
    reset_alerts
    render_state warning
    sync_alerts
    shell_eval "$IND._prefs.set_int('critical-percent', 50); 'ok'" >/dev/null
    await_prefs
    assert_alert_keys 'lowered threshold' "['Session (5h)|critical','Weekly|critical']"
    shell_eval "$IND._prefs.reset('critical-percent'); 'ok'" >/dev/null
    await_prefs
    prove_polled_alert
    assert_polled_alert
    prove_arc
    assert_lifecycle_arc
    prove_tiers
    assert_tier_behaviour
}

# One tier's worth of movement, then a crossing, then a dismissal — the three ways a live
# notification can be reached after it was posted.
assert_tier_behaviour() {
    reset_alerts
    render_state warning
    sync_alerts
    hold_alert 'Session (5h)|warning'
    set_percent 80
    sync_alerts
    assert_refresh_in_place 'tier' 'Session (5h)|warning' '80'
    set_percent 96
    sync_alerts
    assert_tier_crossing_reposts 'tier'
    reset_alerts
    render_state warning
    sync_alerts
    dismiss_alert 'Session (5h)|warning'
    sync_alerts
    assert_dismissal_sticks 'tier'
    reset_alerts
}

prove_tiers() {
    reset_alerts
    render_state warning
    sync_alerts
    hold_alert 'Session (5h)|warning'
    set_percent 80
    sync_alerts
    prove 'same tier rewrites rather than reposting' \
        "shell_eval \"$HELD.title = 'stale 78%'; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._alerts.refresh({
            quotas: $IND._quotas.map(q => ({...q, expired: q.resetsAt !== null && q.resetsAt <= new Date()})),
            fired: $IND._fired, now: new Date(), locale: $IND._locale, percentLocale: $IND._percentLocale});
            'ok'\" >/dev/null" \
        assert_refresh_in_place_probe
    set_percent 96
    sync_alerts
    prove 'crossing a tier posts anew' \
        "shell_eval \"$IND._alerts._live.set('Session (5h)|warning', $HELD); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._alerts._live.delete('Session (5h)|warning'); 'ok'\" >/dev/null" \
        assert_tier_crossing_probe
    reset_alerts
    render_state warning
    sync_alerts
    dismiss_alert 'Session (5h)|warning'
    prove 'a dismissal is not undone by a sync' \
        "shell_eval \"delete $IND._fired['Session (5h)|warning']; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._fired['Session (5h)|warning'] =
            {window: $IND._quotas[0].resetsAt.toISOString()}; 'ok'\" >/dev/null" \
        assert_dismissal_probe
    reset_alerts
}

HELD='global.cqHeldAlert'

hold_alert() {
    shell_eval "$HELD = $IND._alerts._live.get('$1'); 'ok'" >/dev/null
}

# Moving the percentage inside one tier is how a refresh is observed without waiting a
# minute: the title carries the percentage, the window is untouched, so the plan posts
# nothing and only the rewrite can change what the tray reads.
assert_refresh_in_place() {
    assert_eq "$1 same tier rewrites the notification it already posted" 'true' \
        "$(probe "$HELD === $IND._alerts._live.get('$2') && /$3/.test($HELD.title)")"
}

assert_tier_crossing_reposts() {
    assert_eq "$1 crossing a tier posts a new notification" 'true' \
        "$(probe "!$IND._alerts._live.has('Session (5h)|warning') &&
            $IND._alerts._live.has('Session (5h)|critical') &&
            $IND._alerts._live.get('Session (5h)|critical') !== $HELD")"
}

# A dismissal destroys the notification, so _alerts loses the key while the record keeps
# it — which is the only thing standing between a dismissed banner and the next poll
# putting it straight back.
assert_dismissal_sticks() {
    assert_eq "$1 a dismissed alert stays dismissed" 'true' \
        "$(probe "!$IND._alerts._live.has('Session (5h)|warning') &&
            Object.hasOwn($IND._fired, 'Session (5h)|warning')")"
}

assert_refresh_in_place_probe() { assert_refresh_in_place control 'Session (5h)|warning' '80'; }
assert_tier_crossing_probe() { assert_tier_crossing_reposts control; }
assert_dismissal_probe() { assert_dismissal_sticks control; }

# destroy()'s own default reason is DISMISSED, which is exactly a user closing the banner.
# Naming the constant would need imports.ui.messageTray, and the legacy imports object does
# not exist under GNOME 50's ESM shell — the Eval fails and the dismissal silently no-ops.
dismiss_alert() {
    shell_eval "$IND._alerts._live.get('$1').destroy(); 'ok'" >/dev/null
}

SEVERITY_CLASSES="$IND._popup._blocks.map(b => b._percent.get_style_class_name())"
SEVERITY_COLOURS="$IND._popup._blocks.map(b => b._percent.get_theme_node().get_foreground_color().to_string())"

# The panel colour follows the payload's own severity while a notification follows the
# user's thresholds, so the two are independent inputs and agree only when the payload
# agrees with the configured percentages. Moving both together is the realistic shape,
# and the only one in which their coherence is a property worth asserting at all.
arc_step() {
    shell_eval "const i = $IND;
        i._quotas = i._quotas.map(q => ({...q, percent: $1, severity: '$2'}));
        i._render(); 'ok'" >/dev/null
    sync_alerts
}

assert_arc_colour() {
    assert_eq "$1 colour follows severity" 'true' \
        "$(probe "($SEVERITY_CLASSES).every(c => $2)")"
}

assert_arc_colour_probe() { assert_arc_colour control '/cq-warning-/.test(c)'; }

# Percentages are moved without re-rendering the scenario, so resetsAt holds still and
# every step is a quota that moved rather than a window that rolled.
assert_lifecycle_arc() {
    local amber red
    reset_alerts
    render_state normal
    arc_step 0 normal
    assert_arc_colour 'arc at 0%' '!/cq-(warning|critical)-/.test(c)'
    assert_alert_keys 'arc at 0%' '[]'
    arc_step 78 warning
    assert_arc_colour 'arc at 78%' '/cq-warning-/.test(c)'
    assert_alert_keys 'arc at 78%' "['Session (5h)|warning','Weekly|warning']"
    amber="$(probe "($SEVERITY_COLOURS)[0]")"
    arc_step 96 critical
    assert_arc_colour 'arc at 96%' '/cq-critical-/.test(c)'
    assert_alert_keys 'arc at 96%' "['Session (5h)|critical','Weekly|critical']"
    red="$(probe "($SEVERITY_COLOURS)[0]")"
    assert_ne 'arc paints warning and critical differently' "$amber" "$red"
    arc_step 0 normal
    assert_arc_colour 'arc back at 0%' '!/cq-(warning|critical)-/.test(c)'
    assert_alert_keys 'arc back at 0%' '[]'
    assert_eq 'arc leaves nothing behind' 'null' "$(probe "$IND._alerts._source")"
    reset_alerts
}

prove_arc() {
    reset_alerts
    render_state normal
    arc_step 78 warning
    prove 'colour follows severity' \
        "shell_eval \"$IND._popup._blocks.forEach(b => b._percent.set_style_class_name('cq-quota')); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_arc_colour_probe
    reset_alerts
}

park_indicator() {
    shell_eval "globalThis._parked = $IND;
        globalThis._parkedSource = $IND._alerts._source; 'ok'" >/dev/null
}

# A Source with no notification left has already destroyed itself, so _onDestroy's
# own teardown of it is only reachable while one is still live — and a group run on
# its own inherits nothing from the notify group's tail.
arm_alert() {
    reset_alerts
    render_state critical
    sync_alerts
}

wait_for_teardown() {
    for _ in $(seq 150); do
        [ "$(probe "Object.keys(Main.panel.statusArea).includes('$UUID')")" = 'false' ] && return 0
        sleep 0.2
    done
    return 0
}

# _refresh only schedules the next poll once its fetch settles, so the first read
# after wait_for_indicator measures _timerId null with _refreshing still true.
wait_for_polling() {
    for _ in $(seq 150); do
        [ "$(probe "$IND._poller._timerId !== null")" = 'true' ] && return 0
        sleep 0.2
    done
    return 0
}

assert_teardown_complete() {
    assert_eq 'timer released on disable' 'null' "$(probe "globalThis._parked._poller._timerId")"
    assert_eq 'indicator marked destroyed' 'true' "$(probe "globalThis._parked._destroyed")"
    assert_eq 'status timer released on disable' '0' \
        "$(probe "globalThis._parked._poller._statusTimerId")"
    assert_eq 'in-flight fetch cancelled' 'true' \
        "$(probe "globalThis._parked._poller._cancellable?.is_cancelled() ?? true")"
    assert_eq 'in-flight status fetch cancelled' 'true' \
        "$(probe "globalThis._parked._poller._statusCancellable?.is_cancelled() ?? true")"
    assert_eq 'panel entry removed' 'false' \
        "$(probe "Object.keys(Main.panel.statusArea).includes('$UUID')")"
}

assert_reenable_registers_once() {
    assert_eq 'one panel entry after re-enable' '1' \
        "$(probe "Object.keys(Main.panel.statusArea).filter(k => k === '$UUID').length")"
    assert_eq 'a fresh indicator replaced the old one' 'false' \
        "$(probe "$IND === globalThis._parked")"
    assert_eq 'polling resumed' 'true' "$(probe "$IND._poller._timerId !== null")"
}

prove_teardown() {
    prove 'teardown complete' \
        "shell_eval \"globalThis._parked._poller._timerId = 1; 'ok'\" >/dev/null" \
        "shell_eval \"globalThis._parked._poller._timerId = null; 'ok'\" >/dev/null" \
        assert_teardown_complete
}

# The parked source is the one armed before the disable, so a null one means the
# notification never went up and the tray check below would hold over nothing.
assert_source_closed_on_disable() {
    assert_eq 'disable closes the source it opened' 'true' \
        "$(probe "globalThis._parkedSource !== null &&
            !Main.messageTray.getSources().includes(globalThis._parkedSource)")"
}

prove_source_closed() {
    prove 'disable closes the source it opened' \
        "shell_eval \"Main.messageTray._sources.add(globalThis._parkedSource); 'ok'\" >/dev/null" \
        "shell_eval \"Main.messageTray._sources.delete(globalThis._parkedSource); 'ok'\" >/dev/null" \
        assert_source_closed_on_disable
}

group_lifecycle() {
    echo 'lifecycle:'
    arm_alert
    arm_status_poll
    park_indicator
    shell_eval "Main.extensionManager.disableExtension('$UUID'); 'ok'" >/dev/null
    wait_for_teardown
    prove_teardown
    remove_token
    assert_teardown_complete
    prove_source_closed
    assert_source_closed_on_disable
    shell_eval "Main.extensionManager.enableExtension('$UUID'); 'ok'" >/dev/null
    wait_for_indicator
    wait_for_polling
    assert_reenable_registers_once
}

main() {
    require_install
    require_commands magick gettext
    select_scenarios
    select_groups
    use_session e2e
    claim_session e2e
    reap_session
    own_session
    local backend_flag=--headless
    [ "$DEVKIT_HEADLESS" -eq 1 ] || backend_flag=--windowed
    "$PREVIEW" --session=e2e "$backend_flag" --detach --notify=off --scenario=normal >/dev/null
    attach_session || die 'preview.sh did not publish a session'
    freeze
    block_banners true
    runs_group state && group_state
    runs_group panel && group_panel
    runs_group hover && group_hover
    runs_group refresh && group_refresh
    runs_group notify && group_notify
    runs_group lifecycle && group_lifecycle
    assert_summary
}

main
