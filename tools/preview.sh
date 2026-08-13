#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='preview'
DEVKIT_SETUP='gsettings set org.gnome.desktop.interface font-name "Cantarell 11"'
DEVKIT_HEADLESS=0
# shellcheck source=tools/lib/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/devkit.sh"
# shellcheck source=tools/lib/indicator.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/indicator.sh"
# shellcheck source=tools/lib/capture.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/capture.sh"

SESSION='preview'
WANT_THEME=''
WANT_DATA=''
DATA_EXPLICIT=0
WANT_POPUP=''
WANT_BACKEND=''
DETACH=0
STOP=0
CAPTURE=0
WATCH=0

usage() {
    cat <<USAGE
Usage: tools/preview.sh [options]

Owns one nested GNOME shell and sets the shape of the extension inside it. Called
again while that session is up, it changes the shape live instead of restarting.

Options:
  --session=<name>   Name the session (default preview)
  --windowed         Show the session in a Mutter devkit window (default)
  --headless         Run with no window, driven over D-Bus
  --dark, --light    Force a colour scheme
  --scenario=<name>  Render a fabricated state
  --locale=<tag>     Locale for the nested session (default C, e.g. fr_FR.UTF-8)
  --live             Render your own last-cached values (default; issues no request)
  --close            Leave the popup closed and the pointer away (default)
  --hover            Leave the pointer on the panel button
  --open             Leave the popup open
  --capture          Shoot preview/<theme>-<scenario>.png of the shape applied
  --watch            Restart the shell on a source change, replaying the shape
  --detach           Start the session and return instead of blocking
  --stop             Tear the session down
  -h, --help         Show this message

An option you leave out is left alone: preview.sh --light repaints and changes
nothing else. On a fresh session the defaults above apply.

Scenarios:
  ${SCENARIOS[*]}

Needs gnome-shell with this checkout symlinked at
$INSTALLED
USAGE
}

for arg in "$@"; do
    case "$arg" in
        --session=*) SESSION="${arg#*=}" ;;
        --windowed) WANT_BACKEND=windowed ;;
        --headless) WANT_BACKEND=headless ;;
        --dark|--light) WANT_THEME="${arg#--}" ;;
        --scenario=*) WANT_DATA="${arg#*=}"; PICKED=("${arg#*=}") ;;
        --locale=*) DEVKIT_LOCALE="${arg#*=}" ;;
        --live) WANT_DATA=live; DATA_EXPLICIT=1 ;;
        --close|--hover|--open) WANT_POPUP="${arg#--}" ;;
        --capture) CAPTURE=1 ;;
        --detach) DETACH=1 ;;
        --watch) WATCH=1 ;;
        --stop) STOP=1 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $arg" ;;
    esac
done

apply_theme() {
    [ -n "$WANT_THEME" ] || return 0
    set_theme "$WANT_THEME"
    state_set theme "$WANT_THEME"
}

# Showing real values means the ones the extension last cached, injected like any
# other scenario. It used to mean un-stubbing _refresh, which spent a request per
# session — 21 of them in one afternoon against the product's 7.
seed_live_cache() {
    local cache
    cache="$(host_cache_path)"
    if [ -s "$cache" ]; then
        seed_cache "$cache"
        return 0
    fi
    [ "$DATA_EXPLICIT" -eq 1 ] &&
        die "--live needs $cache: open the popup on your own panel once, so a fetch is cached"
    echo "$DEVKIT_NAME: no cached usage at $cache — showing --scenario=normal instead" >&2
    WANT_DATA=normal
    return 0
}

apply_data() {
    [ -n "$WANT_DATA" ] || return 0
    freeze
    [ "$WANT_DATA" = 'live' ] && seed_live_cache
    render_state "$WANT_DATA"
    state_set data "$WANT_DATA"
}

# --open moves the pointer away first because the session's first pointer motion
# closes a menu it lands inside — the same reason e2e.sh has reopen_menu.
apply_popup() {
    [ -n "$WANT_POPUP" ] || return 0
    case "$WANT_POPUP" in
        close) close_menu; point_at away ;;
        hover) close_menu; point_at pill ;;
        open) point_at away; open_menu ;;
    esac
    state_set popup "$WANT_POPUP"
}

# render_state and capture both leave the menu open, so touching data or shooting a
# tile moves the popup dimension too; re-asserting the recorded popup is what keeps
# an omitted flag from changing anything.
apply_shape() {
    apply_theme
    apply_data
    shoot_tile
    { [ -z "$WANT_DATA" ] && [ "$CAPTURE" -ne 1 ]; } || : "${WANT_POPUP:=$(state_get popup)}"
    apply_popup
}

shoot_tile() {
    [ "$CAPTURE" -eq 1 ] || return 0
    require_commands magick
    mkdir -p "$OUT"
    capture "$(tile_name)"
}

fresh_defaults() {
    : "${WANT_THEME:=}"
    : "${WANT_DATA:=live}"
    : "${WANT_POPUP:=close}"
    : "${WANT_BACKEND:=windowed}"
}

start() {
    fresh_defaults
    [ "$WANT_BACKEND" = 'headless' ] && DEVKIT_HEADLESS=1
    require_install
    reap_session
    isolate_dconf
    [ "$DETACH" -eq 1 ] || own_session
    start_shell
    wait_for_indicator
    hide_overview
    state_set backend "$WANT_BACKEND"
    apply_shape
}

replay_backend() {
    WANT_THEME="${WANT_THEME:-$(state_get theme)}"
    WANT_DATA="${WANT_DATA:-$(state_get data)}"
    WANT_POPUP="${WANT_POPUP:-$(state_get popup)}"
    stop_shell
    start
}

sources() {
    find "$ROOT/extension.js" "$ROOT/stylesheet.css" "$ROOT/metadata.json" \
        "$ROOT/lib" "$ROOT/icons" -type f 2>/dev/null | sort
}

# sha256sum digests empty input to a real-looking constant, leaving the watcher
# silently never firing.
signature() {
    local list="$RUN/sources"
    sources > "$list"
    [ -s "$list" ] || die 'no source files matched; watch would never fire'
    xargs stat -c '%n %Y' < "$list" | sha256sum | cut -d' ' -f1
}

# Shell caches extension modules for the life of the process, so a disable/enable
# cycle would silently re-run the old code.
watch_sources() {
    require_commands find stat sha256sum xargs
    local last now
    last="$(signature)"
    while true; do
        sleep 1
        [ -d "$RUN" ] || exit 0
        now="$(signature)"
        [ "$now" = "$last" ] && continue
        last="$now"
        echo 'preview: source changed, restarting'
        replay_backend
    done
}

main() {
    use_session "$SESSION"
    select_scenarios
    if [ "$STOP" -eq 1 ]; then
        session_live && release_session
        exit 0
    fi
    if attach_session; then
        wait_for_indicator
        if [ -n "$WANT_BACKEND" ] && [ "$WANT_BACKEND" != "$(state_get backend)" ]; then
            echo "preview: $WANT_BACKEND needs a new shell, restarting session '$SESSION'"
            replay_backend
        else
            [ "$WATCH" -eq 0 ] ||
                die "--watch needs a session of its own; --session=$SESSION is already running, --stop it first"
            apply_shape
            exit 0
        fi
    else
        start
    fi
    [ "$DETACH" -eq 1 ] && { echo "preview: session '$SESSION' up, detached"; exit 0; }
    echo "preview: session '$SESSION' up, Ctrl-C to stop"
    echo "preview: log $LOG"
    if [ "$WATCH" -eq 0 ]; then
        wait
        exit 0
    fi
    watch_sources
}

main
