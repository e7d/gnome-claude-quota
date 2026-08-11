#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='preview'
DEVKIT_SETUP='gsettings set org.gnome.desktop.interface font-name "Cantarell 11"'
DEVKIT_HEADLESS=1
# shellcheck source=tools/lib/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/devkit.sh"
# shellcheck source=tools/lib/indicator.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/indicator.sh"
# shellcheck source=tools/lib/capture.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/capture.sh"

THEMES=(dark light)

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

subset() {
    [ "${#PICKED[@]}" -gt 0 ] || [ "${#THEMES[@]}" -lt 2 ]
}

main() {
    require_install
    require_commands magick
    select_scenarios
    if subset; then
        echo "preview: subset run (${THEMES[*]} x ${SCENARIOS[*]}); other shots left as they are"
        prepare_out subset
    else
        prepare_out full
    fi
    isolate_dconf
    own_session
    start_shell
    wait_for_indicator
    hide_overview
    freeze
    for theme in "${THEMES[@]}"; do
        set_theme "$theme"
        echo "$theme:"
        for scenario in "${SCENARIOS[@]}"; do
            render_state "$scenario"
            capture "$theme-$scenario"
        done
    done
    normalize
    overview
}

main
