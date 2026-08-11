#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='e2e'
DEVKIT_SETUP='gsettings set org.gnome.desktop.interface font-name "Cantarell 11"'
DEVKIT_HEADLESS=1
# shellcheck source=tools/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/devkit.sh"
# shellcheck source=tools/indicator.sh
. "$(dirname "${BASH_SOURCE[0]}")/indicator.sh"
# shellcheck source=tools/capture.sh
. "$(dirname "${BASH_SOURCE[0]}")/capture.sh"
# shellcheck source=tools/assert.sh
. "$(dirname "${BASH_SOURCE[0]}")/assert.sh"

# GROUPS is a bash built-in holding the user's gids, and assignments to it are ignored.
ALL_GROUPS=(state hover refresh lifecycle)
RUN_GROUPS=("${ALL_GROUPS[@]}")
THEMES=(dark light)
SHOOT=(normal warning critical model-scoped error service-major over-pace rate-limited no-data)
PICKED_GROUPS=()
ATTEMPTS_LOG=''

usage() {
    cat <<USAGE
Usage: tools/e2e.sh [options]

Asserts what the extension renders and how it reacts, in a throwaway nested GNOME
shell, and shoots the subset of states npm run a11y scores.

Options:
  --headless           Run with no window, driven over D-Bus (default)
  --windowed           Show the session in a Mutter devkit window
  --dark-only          Assert the dark theme only
  --light-only         Assert the light theme only
  --scenario=<name>    Assert one scenario; repeat the flag for several
  --group=<name>       Run one group; repeat the flag for several
  -h, --help           Show this message

Screenshots belong to the state group, so a run that excludes it leaves
preview/ alone and npm run a11y would score whatever was already there.

Groups:
  ${ALL_GROUPS[*]}

Scenarios:
  ${SCENARIOS[*]}

Needs magick, and gnome-shell with this checkout symlinked at
$INSTALLED
USAGE
}

for arg in "$@"; do
    devkit_flag "$arg" && continue
    case "$arg" in
        --dark-only) THEMES=(dark) ;;
        --light-only) THEMES=(light) ;;
        --scenario=*) PICKED+=("${arg#*=}") ;;
        --group=*) PICKED_GROUPS+=("${arg#*=}") ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $arg" ;;
    esac
done

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
    for name in "${SHOOT[@]}"; do
        [ "$name" = "$1" ] && return 0
    done
    return 1
}

IND="Main.panel.statusArea['$UUID']"
BLOCK_ROWS="$IND._blocks.flatMap(b => [b._name.text, b._percent.text, b._caption.text])"
PANEL_LABELS="$IND._panelQuotas.get_children().map(c => c.text ?? '').filter(t => t !== '')"
PANEL_QUOTAS="$IND._panelQuotas.get_children()
    .filter(c => /cq-panel-quota/.test(c.get_style_class_name() ?? ''))
    .map(c => c.text)"
CRITICAL_COLOR="$IND._blocks[1]._percent.get_theme_node().get_foreground_color().to_string()"

assert_rows_filled() {
    assert_eq "$1 rows filled" 'true' "$(probe "$BLOCK_ROWS.every(t => t !== '')")"
}

assert_no_placeholders() {
    assert_eq "$1 no placeholder leaked" 'true' \
        "$(probe "$BLOCK_ROWS.concat($PANEL_LABELS).every(t => !/null|undefined|NaN/.test(t))")"
}

assert_block_count() {
    assert_eq "$1 block count" "$(probe "$IND._quotas.length")" "$(probe "$IND._blocks.length")"
}

assert_panel_matches() {
    assert_eq "$1 panel agrees with blocks" 'true' \
        "$(probe "$IND._blocks.every((b, n) => ($PANEL_QUOTAS)[n].endsWith(b._percent.text))")"
}

assert_rate_limit_note() {
    assert_eq "$1 retry note tracks the block" 'true' \
        "$(probe "$IND._rateLimitLabel.visible === /^retry /.test($IND._rateLimitLabel.text) && $IND._rateLimitLabel.visible === ($IND._blockedUntil > new Date())")"
}

assert_state() {
    assert_rows_filled "$1"
    assert_no_placeholders "$1"
    assert_block_count "$1"
    assert_panel_matches "$1"
    assert_rate_limit_note "$1"
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

assert_rows_filled_probe() { assert_rows_filled control; }
assert_no_placeholders_probe() { assert_no_placeholders control; }
assert_block_count_probe() { assert_block_count control; }
assert_panel_matches_probe() { assert_panel_matches control; }
assert_rate_limit_note_probe() { assert_rate_limit_note control; }

prove_state() {
    render_state normal
    prove 'rows filled' \
        "shell_eval \"$IND._blocks[0]._caption.text = ''; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_rows_filled_probe
    prove 'no placeholder leaked' \
        "shell_eval \"$IND._blocks[0]._name.text = 'undefined'; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_no_placeholders_probe
    prove 'block count' \
        "shell_eval \"$IND._blocks.pop().destroy(); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._blocks = []; $IND._render(); 'ok'\" >/dev/null" \
        assert_block_count_probe
    prove 'panel agrees with blocks' \
        "shell_eval \"$IND._panelQuotas.get_children().find(c => c.text)?.set_text('S 0%'); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_panel_matches_probe
    prove 'retry note tracks the block' \
        "shell_eval \"$IND._rateLimitLabel.text = 'retry at 9:00'; $IND._rateLimitLabel.show(); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._render(); 'ok'\" >/dev/null" \
        assert_rate_limit_note_probe
}

subset_kind() {
    if [ "${#PICKED[@]}" -gt 0 ] || [ "${#THEMES[@]}" -lt 2 ]; then
        echo subset
    else
        echo full
    fi
}

group_state() {
    prepare_out "$(subset_kind)"
    prove_state
    local theme scenario
    for theme in "${THEMES[@]}"; do
        set_theme "$theme"
        echo "$theme:"
        for scenario in "${SCENARIOS[@]}"; do
            if shoots "$scenario"; then
                capture "$theme-$scenario" "$scenario"
            else
                render_state "$scenario"
            fi
            assert_state "$theme-$scenario"
        done
    done
    assert_theme_differs
    [ "${#SHOTS[@]}" -eq 0 ] || { normalize; overview; }
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
    sleep 1
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
        point_at_actor "$IND.$row"
        assert_eq "$row does not track hover" 'false' "$(probe "$IND.$row.track_hover")"
        assert_eq "$row takes no hover class" 'true' \
            "$(probe "!/hover|active/.test($IND.$row.get_style_pseudo_class() ?? '')")"
    done
}

assert_status_row_highlights() {
    point_at_actor "$IND._issueItem"
    assert_eq 'status row tracks hover' 'true' "$(probe "$IND._issueItem.track_hover")"
    assert_eq 'status row highlights' 'true' \
        "$(probe "/hover/.test($IND._issueItem.get_style_pseudo_class() ?? '')")"
    point_at away
}

prove_hover() {
    prove 'panel matches platform' \
        "shell_eval \"$IND.track_hover = false; 'ok'\" >/dev/null" \
        "shell_eval \"$IND.track_hover = true; 'ok'\" >/dev/null" \
        assert_panel_matches_platform
    prove 'display rows inert' \
        "shell_eval \"$IND._body.track_hover = true; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._body.track_hover = false; 'ok'\" >/dev/null" \
        assert_display_rows_inert
}

prove_status_row() {
    prove 'status row highlights' \
        "shell_eval \"$IND._issueItem.track_hover = false; 'ok'\" >/dev/null" \
        "shell_eval \"$IND._issueItem.track_hover = true; 'ok'\" >/dev/null" \
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
        $IND._fetchCycle = () => new Promise(() => {});
        'ok'" >/dev/null
}

refreeze_refresh() {
    shell_eval "$IND._refreshing = false;
        delete $IND._fetchCycle;
        $IND._refresh = () => {};
        $IND._render();
        'ok'" >/dev/null
}

# St.Button::clicked carries the button number, and emitting it without one is
# refused outright — the click then runs nothing and no assertion below can tell.
click_refresh() {
    shell_eval "$IND._refreshButton.emit('clicked', 1); 'ok'" >/dev/null
}

assert_menu_survives_refresh() {
    assert_eq 'menu stays open through a refresh' 'true' "$(probe "$IND.menu.isOpen")"
}

assert_spinner_runs() {
    assert_eq 'refresh icon spins' 'true' \
        "$(probe "$IND._refreshButton.child.get_transition('spin') !== null")"
    assert_eq 'refresh button is insensitive while refreshing' 'false' \
        "$(probe "$IND._refreshButton.reactive")"
}

assert_spinner_cleared() {
    assert_eq 'spin transition removed' 'true' \
        "$(probe "$IND._refreshButton.child.get_transition('spin') === null")"
    assert_eq 'icon rotation reset' '0' \
        "$(probe "$IND._refreshButton.child.rotation_angle_z")"
}

prove_refresh() {
    prove 'spinner runs' \
        "shell_eval \"$IND._refreshButton.child.remove_transition('spin'); 'ok'\" >/dev/null" \
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
        $IND._attemptsPath = () => '$ATTEMPTS_LOG';
        $IND._client.fetch = () => Promise.reject(Object.assign(new Error('Rate limited'),
            {rateLimited: true, retryAfter: 1, status: 429,
             headers: {'authorization': 'Bearer sk-ant-oat01-STUB',
                       'anthropic-ratelimit-requests-remaining': '0'}}));
        'ok'" >/dev/null
    log_attempt manual
}

restore_attempt_log() {
    shell_eval "delete $IND._client.fetch;
        delete $IND._attemptsPath;
        $IND._blockedUntil = null;
        $IND._refresh = () => {};
        $IND._render();
        'ok'" >/dev/null
    rm -f "$ATTEMPTS_LOG"
    ATTEMPTS_LOG=''
}

# A 429 arms _blockedUntil, and a blocked _refresh makes no upstream attempt and
# therefore no record — so the block is cleared before each deliberate attempt.
log_attempt() {
    shell_eval "$IND._blockedUntil = null; $IND._refresh('$1'); 'ok'" >/dev/null
    sleep 1
}

last_attempt_field() {
    tail -n 1 "$ATTEMPTS_LOG" 2>/dev/null | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

assert_attempt_logged() {
    assert_eq 'attempt records the trigger that caused it' 'manual' "$(last_attempt_field trigger)"
    assert_eq 'attempt records the 429 as its outcome' 'rate-limited' "$(last_attempt_field outcome)"
    assert_eq 'attempt keeps the rate-limit header' '0' \
        "$(last_attempt_field anthropic-ratelimit-requests-remaining)"
    assert_eq 'attempt carries no credential' '' \
        "$(tail -n 1 "$ATTEMPTS_LOG" 2>/dev/null | grep -oiE 'bearer|authorization|sk-ant' | head -1 || true)"
}

prove_attempt_log() {
    prove 'attempt log records the trigger' \
        'log_attempt timer' \
        'log_attempt manual' \
        assert_attempt_logged
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
    refreeze_refresh
    sleep 1
    assert_spinner_cleared
    stub_attempt_log
    prove_attempt_log
    assert_attempt_logged
    restore_attempt_log
}

park_indicator() {
    shell_eval "globalThis._parked = $IND; 'ok'" >/dev/null
}

wait_for_teardown() {
    for _ in $(seq 30); do
        [ "$(probe "Object.keys(Main.panel.statusArea).includes('$UUID')")" = 'false' ] && return 0
        sleep 1
    done
    return 0
}

# _refresh only schedules the next poll once its fetch settles, so the first read
# after wait_for_indicator measures _timerId null with _refreshing still true.
wait_for_polling() {
    for _ in $(seq 30); do
        [ "$(probe "$IND._timerId !== null")" = 'true' ] && return 0
        sleep 1
    done
    return 0
}

assert_teardown_complete() {
    assert_eq 'timer released on disable' 'null' "$(probe "globalThis._parked._timerId")"
    assert_eq 'indicator marked destroyed' 'true' "$(probe "globalThis._parked._destroyed")"
    assert_eq 'in-flight fetch cancelled' 'true' \
        "$(probe "globalThis._parked._cancellable?.is_cancelled() ?? true")"
    assert_eq 'panel entry removed' 'false' \
        "$(probe "Object.keys(Main.panel.statusArea).includes('$UUID')")"
}

assert_reenable_registers_once() {
    assert_eq 'one panel entry after re-enable' '1' \
        "$(probe "Object.keys(Main.panel.statusArea).filter(k => k === '$UUID').length")"
    assert_eq 'a fresh indicator replaced the old one' 'false' \
        "$(probe "$IND === globalThis._parked")"
    assert_eq 'polling resumed' 'true' "$(probe "$IND._timerId !== null")"
}

prove_teardown() {
    prove 'teardown complete' \
        "shell_eval \"globalThis._parked._timerId = 1; 'ok'\" >/dev/null" \
        "shell_eval \"globalThis._parked._timerId = null; 'ok'\" >/dev/null" \
        assert_teardown_complete
}

group_lifecycle() {
    echo 'lifecycle:'
    park_indicator
    shell_eval "Main.extensionManager.disableExtension('$UUID'); 'ok'" >/dev/null
    wait_for_teardown
    prove_teardown
    assert_teardown_complete
    shell_eval "Main.extensionManager.enableExtension('$UUID'); 'ok'" >/dev/null
    wait_for_indicator
    wait_for_polling
    assert_reenable_registers_once
}

main() {
    require_install
    require_commands magick
    select_scenarios
    select_groups
    isolate_dconf
    start_shell
    wait_for_indicator
    hide_overview
    freeze
    runs_group state && group_state
    runs_group hover && group_hover
    runs_group refresh && group_refresh
    runs_group lifecycle && group_lifecycle
    assert_summary
}

main
