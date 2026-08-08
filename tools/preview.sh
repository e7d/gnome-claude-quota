#!/usr/bin/env bash
set -euo pipefail

UUID='claude-quota@e7d.io'
MONITOR='1400x900'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/preview"
RUN="$(mktemp -d)"
CFG="$RUN/config"
BUS_FILE="$RUN/bus"
PID_FILE="$RUN/pid"
LOG="$RUN/shell.log"

cleanup() {
    if [ -s "$PID_FILE" ]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        sleep 1
    fi
    rm -rf "$RUN"
}

die() {
    echo "preview: $1" >&2
    [ -s "$LOG" ] && tail -5 "$LOG" >&2
    exit 1
}

# The nested shell shares the user's dconf unless we hand it a private copy, and
# its extensions write to whatever they are given, including enabled-extensions.
isolate_dconf() {
    mkdir -p "$CFG/dconf"
    cp "${XDG_CONFIG_HOME:-$HOME/.config}/dconf/user" "$CFG/dconf/user"
}

# GNOME 50 dropped the nested backend; --devkit is the replacement, and runs even
# though its viewer binary is unpackaged. --unsafe-mode is what unlocks Eval.
#
# Every dconf write lives inside this dbus-run-session, and nowhere else in the
# script. XDG_CONFIG_HOME does NOT sandbox dconf: writes travel over the session
# bus to the dconf service, which reads its own environment, so a write issued
# before the private bus exists lands in the live session's database. That is how
# the user's enabled-extensions list got replaced with a single entry — twice.
# The list is replaced rather than appended to, so no other extension's indicator
# lands in the panel next to this one, and the font is pinned so a shot reads the
# same whatever the host happens to run (Cantarell ships with gnome-shell).
start_shell() {
    # The inner shell must expand these itself, so the body stays single-quoted.
    # shellcheck disable=SC2016
    XDG_CONFIG_HOME="$CFG" dbus-run-session -- bash -c '
        echo "$DBUS_SESSION_BUS_ADDRESS" > "$1"
        echo $$ > "$2"
        dconf write /org/gnome/shell/enabled-extensions "['"'"'$4'"'"']"
        gsettings set org.gnome.desktop.interface font-name "Cantarell 11"
        exec gnome-shell --devkit --virtual-monitor "$3" --unsafe-mode
    ' _ "$BUS_FILE" "$PID_FILE" "$MONITOR" "$UUID" >"$LOG" 2>&1 &
    for _ in $(seq 60); do
        [ -s "$BUS_FILE" ] && break
        sleep 1
    done
    [ -s "$BUS_FILE" ] || die 'shell never published a bus address'
    DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")"
    export DBUS_SESSION_BUS_ADDRESS
}

shell_eval() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null
}

# Eval answers (false, '') both when it is locked down and when the script is
# wrong, so treat anything but a true reply as not-ready rather than as an error.
wait_for_indicator() {
    for _ in $(seq 60); do
        case "$(shell_eval "Object.keys(Main.panel.statusArea).includes('$UUID').toString()")" in
            "(true, '\"true\"')"|"(true, 'true')") return 0 ;;
        esac
        sleep 1
    done
    die "indicator $UUID never appeared"
}

# Every state below is fabricated, so the real endpoint must never answer over the
# top of it. Stubbing the instance method also spares the shared API rate limit.
freeze() {
    shell_eval "Main.panel.statusArea['$UUID']._refresh = () => {}; 'ok'" >/dev/null
}

set_theme() {
    XDG_CONFIG_HOME="$CFG" gsettings set org.gnome.desktop.interface color-scheme "prefer-$1"
    sleep 2
}

unwrap() {
    sed -n "s/^(true, '\(.*\)')\$/\1/p" | tr -d '"'
}

# Spans the panel button and the popup so the button's hover pill is never clipped.
shot_box() {
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        const [bx, by] = i.get_transformed_position();
        const [bw, bh] = i.get_transformed_size();
        const m = i.menu.actor;
        const [mx, my] = m.get_transformed_position();
        const [mw, mh] = m.get_transformed_size();
        const x0 = Math.max(0, Math.round(Math.min(bx, mx)) - 12);
        const x1 = Math.round(Math.max(bx + bw, mx + mw)) + 12;
        [x0, 0, x1 - x0, Math.round(my + mh) + 12].join(' ')" | unwrap
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
        long-name) echo "i._quotas = [q('S','Session',30,'normal',200,SESSION), q('So','Sonnet with a very long display name',61,'normal',200,SESSION)];" ;;
        rate-limited) echo "i._quotas = [q('S','Session',21,'normal',253,SESSION), q('W','Weekly',94,'critical',13,WEEK)]; i._error = 'Rate limited'; i._blockedUntil = new Date(Date.now() + 180000);" ;;
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

capture() {
    local name="$1" box rect
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        $QUOTA
        i._quotas = []; i._error = null; i._serviceStatus = null; i._blockedUntil = null; i._refreshing = false; i._fetchedAt = new Date(Date.now() - 360000);
        $(setup_for "$2")
        i.menu.open(false); i._render(); 'ok'" >/dev/null
    sleep 1
    box="$(shot_box)"
    [ -n "$box" ] || die "could not measure the popup for $name"
    read -r -a rect <<<"$box"
    gdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.ScreenshotArea \
        "${rect[@]}" false "$OUT/$name.png" >/dev/null || die "screenshot failed for $name"
    shell_eval "Main.panel.statusArea['$UUID'].menu.close(false); 'ok'" >/dev/null
    SHOTS+=("$OUT/$name.png")
    echo "  $OUT/$name.png"
}

overview() {
    if ! command -v montage >/dev/null; then
        echo 'preview: montage missing, skipping overview' >&2
        return 0
    fi
    montage -background '#101014' -fill '#b9b9c0' -font DejaVu-Sans -pointsize 22 -label '%t' \
        -tile 7x -geometry '+12+12' \
        "${SHOTS[@]}" "$OUT/overview.png"
    echo "  $OUT/overview.png"
}

SCENARIOS=(normal over-pace warning critical full zero expired model-scoped
           long-name rate-limited error token-expired loading refreshing fresh no-data
           service-degraded service-partial service-major service-maintenance
           service-error)
SHOTS=()

main() {
    command -v gnome-shell >/dev/null || die 'gnome-shell not found'
    trap cleanup EXIT
    mkdir -p "$OUT"
    rm -f "$OUT"/*.png
    isolate_dconf
    start_shell
    wait_for_indicator
    freeze
    for theme in dark light; do
        set_theme "$theme"
        echo "$theme:"
        for scenario in "${SCENARIOS[@]}"; do
            capture "$theme-$scenario" "$scenario"
        done
    done
    overview
}

main "$@"
