#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='dev'
DEVKIT_HEADLESS=0
# shellcheck source=tools/lib/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/devkit.sh"

WATCH=0
SCHEME=''

usage() {
    cat <<USAGE
Usage: tools/dev.sh [options]

Runs this checkout, and nothing else, in a throwaway nested GNOME shell. Your own
session, its dconf database and its extensions are untouched.

Options:
  --watch        Restart the shell whenever a source file changes
  --windowed     Show the session in a Mutter devkit window (default)
  --headless     Run with no window, driven over D-Bus
  --dark         Force prefer-dark
  --light        Force prefer-light
  -h, --help     Show this message

Without --dark or --light the colour scheme, wallpaper and accent colour reset to
the GNOME defaults, so a session looks the same on any machine.

Needs gnome-shell with this checkout symlinked at
$INSTALLED
USAGE
}

for arg in "$@"; do
    devkit_flag "$arg" && continue
    case "$arg" in
        --watch) WATCH=1 ;;
        --dark) SCHEME='prefer-dark' ;;
        --light) SCHEME='prefer-light' ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $arg" ;;
    esac
done
if [ -n "$SCHEME" ]; then
    DEVKIT_SETUP="gsettings set org.gnome.desktop.interface color-scheme '$SCHEME'"
fi

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

launch() {
    start_shell
    wait_for_indicator
    hide_overview
    echo "dev: shell up, running only $UUID"
    echo "dev: bus $DBUS_SESSION_BUS_ADDRESS"
    echo "dev: log $LOG"
}

require_install
if [ "$WATCH" -eq 1 ]; then
    require_commands find stat sha256sum xargs
fi
isolate_dconf

if [ "$WATCH" -eq 0 ]; then
    launch
    echo 'dev: Ctrl-C to stop'
    wait
    exit 0
fi

# Shell caches extension modules for the life of the process, so a disable/enable
# cycle would silently re-run the old code.
echo 'dev: watching for edits; each change restarts the shell'
LAST="$(signature)"
launch
while true; do
    sleep 1
    NOW="$(signature)"
    [ "$NOW" = "$LAST" ] && continue
    LAST="$NOW"
    echo 'dev: source changed, restarting'
    stop_shell
    launch
done
