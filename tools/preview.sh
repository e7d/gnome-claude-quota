#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='preview'
DEVKIT_SETUP='gsettings set org.gnome.desktop.interface font-name "Cantarell 11"'
DEVKIT_HEADLESS=1
# shellcheck source=tools/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/devkit.sh"
# shellcheck source=tools/indicator.sh
. "$(dirname "${BASH_SOURCE[0]}")/indicator.sh"

SHOTS=()
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

OUT="$ROOT/preview"

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

shoot() {
    local path="$1"
    shift
    gdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.ScreenshotArea \
        "$@" false "$path" >/dev/null || die "screenshot failed for $path"
}

capture() {
    local name="$1" box rect panel
    render_state "$2"
    sleep 1
    box="$(popup_box)"
    [ -n "$box" ] || die "could not measure the popup for $name"
    read -r -a rect <<<"$box"
    panel="$(panel_height)"
    close_menu
    sleep 1
    point_at away
    sleep 1
    shoot "$RUN/closed.png" "${rect[0]}" 0 "${rect[2]}" "$panel"
    point_at pill
    sleep 1
    shoot "$RUN/hovered.png" "${rect[0]}" 0 "${rect[2]}" "$panel"
    open_menu
    sleep 1
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
