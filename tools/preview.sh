#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='preview'
DEVKIT_SETUP='gsettings set org.gnome.desktop.interface font-name "Cantarell 11"'
DEVKIT_HEADLESS=1
# shellcheck source=tools/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/devkit.sh"

SCENARIOS=(normal over-pace warning critical full zero expired model-scoped no-reset
           long-name locale rate-limited error token-expired loading refreshing fresh no-data
           service-degraded service-partial service-major service-maintenance
           service-error)
SHOTS=()
THEMES=(dark light)
PICKED=()

usage() {
    cat <<USAGE
Usage: tools/preview.sh [options]

Shoots preview/<theme>-<scenario>.png in a throwaway nested GNOME shell, each one
stacking the panel button resting, hovered, then pressed with the popup open, plus
an overview.png contact sheet of them all.

Options:
  --headless           Run with no window, driven over D-Bus (default)
  --windowed           Show the session in a Mutter devkit window
  --dark-only          Shoot the dark theme only
  --light-only         Shoot the light theme only
  --scenario=<name>    Shoot one scenario; repeat the flag for several
  -h, --help           Show this message

A full run takes a few minutes; a subset run takes seconds and leaves the
screenshots it did not shoot alone.

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
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $arg" ;;
    esac
done

OUT="$ROOT/preview"

# Every state below is fabricated, so the real endpoint must never answer over the
# top of it. Stubbing the instance method also spares the shared API rate limit.
freeze() {
    shell_eval "Main.panel.statusArea['$UUID']._refresh = () => {}; 'ok'" >/dev/null
}

set_theme() {
    shell_settle color-scheme "prefer-$1"
}

popup_box() {
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        const [bx] = i.get_transformed_position();
        const [bw] = i.get_transformed_size();
        const m = i.menu.actor;
        const [mx, my] = m.get_transformed_position();
        const [mw, mh] = m.get_transformed_size();
        const mon = Main.layoutManager.primaryMonitor;
        const x0 = Math.max(0, Math.round(Math.min(bx, mx)) - 12);
        const x1 = Math.min(mon.width, Math.round(Math.max(bx + bw, mx + mw)) + 12);
        const y1 = Math.min(mon.height, Math.round(my + mh) + 12);
        [x0, 0, x1 - x0, y1].join(' ')" | unwrap
}

panel_height() {
    shell_eval "(Math.round(Main.panel.height) + 12).toString()" | unwrap
}

# warp_pointer is ignored while the devkit viewer owns the pointer, so hover has
# to come from a virtual device emitting real motion events.
point_at() {
    shell_eval "const C = imports.gi.Clutter;
        globalThis._vd ||= C.get_default_backend().get_default_seat()
            .create_virtual_device(C.InputDeviceType.POINTER_DEVICE);
        const i = Main.panel.statusArea['$UUID'];
        const mon = Main.layoutManager.primaryMonitor;
        const [bx, by] = i.get_transformed_position();
        const [bw, bh] = i.get_transformed_size();
        const [x, y] = '$1' === 'pill'
            ? [bx + bw / 2, by + bh / 2]
            : [mon.width / 2, mon.height - 8];
        globalThis._vd.notify_absolute_motion(global.get_current_time(), Math.round(x), Math.round(y));
        'ok'" >/dev/null
}

shoot() {
    local path="$1"
    shift
    gdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.ScreenshotArea \
        "$@" false "$path" >/dev/null || die "screenshot failed for $path"
}

QUOTA="const q = (short, name, percent, severity, leftMin, winMin) => {
    const progress = Math.min(1, Math.max(0, 1 - leftMin / winMin));
    return {
        short, name, percent, severity,
        modelScoped: !['Session', 'Weekly'].includes(name),
        resetsAt: new Date(Date.now() + leftMin * 60000),
        windowProgress: progress,
        aheadOfPace: percent / 100 - progress > 0.1,
    };
};
const SESSION = 300, WEEK = 10080;"

# The scenario name carries the component status the status page would publish, so
# the emoji mapping is never restated here — the extension resolves it at render.
service_status() {
    case "$1" in
        service-degraded) echo 'degraded_performance' ;;
        service-partial) echo 'partial_outage' ;;
        service-major) echo 'major_outage' ;;
        service-maintenance) echo 'under_maintenance' ;;
        service-error) echo 'unknown' ;;
        *) die "unknown service scenario $1" ;;
    esac
}

setup_quotas() {
    echo "i._quotas = [q('S','Session',21,'normal',253,SESSION), q('W','Weekly',94,'critical',13,WEEK)];"
}

setup_for() {
    case "$1" in
        normal) echo "i._quotas = [q('S','Session',7,'normal',270,SESSION), q('W','Weekly',12,'normal',9000,WEEK)];" ;;
        over-pace) echo "i._quotas = [q('S','Session',68,'normal',240,SESSION), q('W','Weekly',20,'normal',2000,WEEK)];" ;;
        warning) echo "i._quotas = [q('S','Session',78,'warning',90,SESSION), q('W','Weekly',80,'warning',2000,WEEK)];" ;;
        critical) echo "i._quotas = [q('S','Session',96,'critical',20,SESSION), q('W','Weekly',94,'critical',400,WEEK)];" ;;
        full) echo "i._quotas = [q('S','Session',100,'critical',5,SESSION), q('W','Weekly',100,'critical',60,WEEK)];" ;;
        zero) echo "i._quotas = [q('S','Session',0,'normal',300,SESSION), q('W','Weekly',0,'normal',WEEK,WEEK)];" ;;
        expired) echo "i._quotas = [q('S','Session',40,'normal',-5,SESSION), q('W','Weekly',60,'normal',-5,WEEK)];" ;;
        model-scoped) echo "i._quotas = [q('S','Session',30,'normal',200,SESSION), q('W','Weekly',44,'normal',5000,WEEK), q('O','Opus',72,'warning',200,SESSION)];" ;;
        no-reset) echo "i._quotas = [q('S','Session',30,'normal',200,SESSION), q('W','Weekly',44,'normal',5000,WEEK), {...q('O','Opus',72,'normal',200,SESSION), resetsAt: null, windowProgress: null, aheadOfPace: false}];" ;;
        long-name) echo "i._quotas = [q('S','Session',30,'normal',200,SESSION), q('So','Sonnet with a very long display name',61,'normal',200,SESSION)];" ;;
        locale) echo "$(setup_quotas) i._locale = 'fr-FR';" ;;
        rate-limited) echo "i._quotas = [q('S','Session',21,'normal',253,SESSION), q('W','Weekly',94,'critical',13,WEEK)]; i._blockedUntil = new Date(Date.now() + 180000);" ;;
        error) echo "i._quotas = [q('S','Session',21,'normal',253,SESSION), q('W','Weekly',94,'critical',13,WEEK)]; i._error = 'Cannot reach api.anthropic.com';" ;;
        token-expired) echo "i._quotas = [q('S','Session',21,'normal',253,SESSION)]; i._error = 'Token expired, run Claude Code once';" ;;
        loading) echo "i._fetchedAt = null;" ;;
        refreshing) echo "$(setup_quotas) i._refreshing = true;" ;;
        fresh) echo "$(setup_quotas) i._fetchedAt = new Date();" ;;
        no-data) echo "i._fetchedAt = null; i._error = 'Cannot reach api.anthropic.com';" ;;
        service-*) echo "$(setup_quotas) i._error = 'Usage request failed (HTTP 503)'; i._serviceStatus = '$(service_status "$1")';" ;;
        *) die "unknown scenario $1" ;;
    esac
}

render_state() {
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        $QUOTA
        i._quotas = []; i._error = null; i._serviceStatus = null; i._blockedUntil = null; i._refreshing = false; i._fetchedAt = new Date(Date.now() - 360000); i._locale = 'en-US';
        $(setup_for "$1")
        i.menu.open(false); i._render(); 'ok'" >/dev/null
    sleep 1
}

close_menu() {
    shell_eval "Main.panel.statusArea['$UUID'].menu.close(false); 'ok'" >/dev/null
    sleep 1
}

open_menu() {
    shell_eval "Main.panel.statusArea['$UUID'].menu.open(false); 'ok'" >/dev/null
    sleep 1
}

capture() {
    local name="$1" box rect panel
    render_state "$2"
    box="$(popup_box)"
    [ -n "$box" ] || die "could not measure the popup for $name"
    read -r -a rect <<<"$box"
    panel="$(panel_height)"
    close_menu
    point_at away
    sleep 1
    shoot "$RUN/closed.png" "${rect[0]}" 0 "${rect[2]}" "$panel"
    point_at pill
    sleep 1
    shoot "$RUN/hovered.png" "${rect[0]}" 0 "${rect[2]}" "$panel"
    open_menu
    shoot "$RUN/open.png" "${rect[@]}"
    magick "$RUN/closed.png" "$RUN/hovered.png" "$RUN/open.png" \
        -background none -smush 8 "$OUT/$name.png"
    SHOTS+=("$OUT/$name.png")
    echo "  $OUT/$name.png"
}

normalize() {
    local w h
    w="$(magick identify -format '%w\n' "${SHOTS[@]}" | sort -n | tail -1)"
    h="$(magick identify -format '%h\n' "${SHOTS[@]}" | sort -n | tail -1)"
    [ "${w:-0}" -gt 0 ] && [ "${h:-0}" -gt 0 ] || die 'could not measure the captured shots'
    magick mogrify -background none -gravity north -extent "${w}x${h}" "${SHOTS[@]}"
    echo "  normalized ${#SHOTS[@]} shots to ${w}x${h}"
}

overview() {
    if ! command -v montage >/dev/null; then
        echo 'preview: montage missing, skipping overview' >&2
        return 0
    fi
    local fonts
    fonts="$(magick -list font)"
    if ! grep -qE '^ *Font: DejaVu-Sans$' <<<"$fonts"; then
        echo 'preview: DejaVu-Sans missing, skipping overview' >&2
        return 0
    fi
    local tiles=() shot name
    for shot in "${SHOTS[@]}"; do
        name="$(basename "$shot" .png)"
        magick -background '#101014' -fill '#b9b9c0' -font DejaVu-Sans -pointsize 22 \
            label:"$name" -gravity center "$shot" -append +set label "$RUN/tile-$name.png"
        tiles+=("$RUN/tile-$name.png")
    done
    montage -background '#101014' -tile 7x -geometry '+12+12' \
        "${tiles[@]}" "$OUT/overview.png"
    echo "  $OUT/overview.png"
}

select_scenarios() {
    local want found
    [ "${#PICKED[@]}" -gt 0 ] || return 0
    for want in "${PICKED[@]}"; do
        found=''
        for known in "${SCENARIOS[@]}"; do
            [ "$known" = "$want" ] && found=1 && break
        done
        [ -n "$found" ] || die "unknown scenario '$want'; known: ${SCENARIOS[*]}"
    done
    SCENARIOS=("${PICKED[@]}")
}

subset() {
    [ "${#PICKED[@]}" -gt 0 ] || [ "${#THEMES[@]}" -lt 2 ]
}

main() {
    require_install
    require_commands magick
    select_scenarios
    mkdir -p "$OUT"
    if subset; then
        echo "preview: subset run (${THEMES[*]} x ${SCENARIOS[*]}); other shots left as they are"
    else
        rm -f "$OUT"/*.png
    fi
    isolate_dconf
    start_shell
    wait_for_indicator
    hide_overview
    freeze
    for theme in "${THEMES[@]}"; do
        set_theme "$theme"
        echo "$theme:"
        for scenario in "${SCENARIOS[@]}"; do
            capture "$theme-$scenario" "$scenario"
        done
    done
    normalize
    overview
}

main
