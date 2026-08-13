# shellcheck shell=bash

OUT="$ROOT/preview"
SHOTS=()

prepare_out() {
    mkdir -p "$OUT"
    [ "$1" = 'full' ] || return 0
    rm -f "$OUT"/*.png
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

shoot() {
    local path="$1"
    shift
    gdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.ScreenshotArea \
        "$@" false "$path" >/dev/null || die "screenshot failed for $path"
}

# An already-open menu neither repositions nor reallocates itself, so the cycle below
# is what stops it being drawn against the previous scenario's panel button — measured
# 305px out. The pointer moves before the menu opens, never after: a motion landing
# inside an open menu closes it.
capture() {
    local name="$1" box rect panel started
    started="$(date +%s%N)"
    close_menu
    point_at pill
    open_menu
    box="$(popup_box)"
    [ -n "$box" ] || die "could not measure the popup for $name"
    read -r -a rect <<<"$box"
    panel="$(panel_height)"
    await_style
    shoot "$RUN/open.png" "${rect[@]}"
    close_menu
    await_style
    shoot "$RUN/hovered.png" "${rect[0]}" 0 "${rect[2]}" "$panel"
    point_at away
    shoot "$RUN/closed.png" "${rect[0]}" 0 "${rect[2]}" "$panel"
    magick "$RUN/closed.png" "$RUN/hovered.png" "$RUN/open.png" \
        -background none -smush 8 "$OUT/$name.png"
    SHOTS+=("$OUT/$name.png")
    printf '  capture %s %ss\n' "$name" "$(elapsed_since "$started")" >&2
    echo "$OUT/$name.png"
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
