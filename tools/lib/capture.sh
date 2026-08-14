# shellcheck shell=bash

SHOTS=()

out_dir() {
    local sub
    sub="$(locale_subdir)"
    if [ -n "$sub" ]; then
        printf '%s/preview/%s' "$ROOT" "$sub"
    else
        printf '%s/preview' "$ROOT"
    fi
}

prepare_out() {
    mkdir -p "$(out_dir)"
    [ "$1" = 'full' ] || return 0
    rm -f "$(out_dir)"/*.png
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
        -background none -smush 8 "$(out_dir)/$name.png"
    SHOTS+=("$(out_dir)/$name.png")
    printf '  capture %s %ss\n' "$name" "$(elapsed_since "$started")" >&2
    echo "$(out_dir)/$name.png"
}

# Only one banner is on screen at a time — the rest queue behind it — so the banner
# frames what a user actually sees and the tray list is the only complete surface.
# A NORMAL-urgency banner also expires on the shell's own timer, which is why an
# absent banner is reported and skipped rather than shot as an empty rect.
banner_box() {
    shell_eval "(() => {
        const tray = Main.messageTray;
        if (tray._banner === null || !tray.visible)
            return '';
        const [x, y] = tray._bannerBin.get_transformed_position();
        const [w, h] = tray._bannerBin.get_size();
        if (!(w >= 1 && h >= 1))
            return '';
        const mon = Main.layoutManager.primaryMonitor;
        const x0 = Math.max(0, Math.round(x) - 12);
        const y0 = Math.max(Math.round(Main.panel.height), Math.round(y) - 12);
        return [x0, y0, Math.min(mon.width - x0, Math.round(w) + 24),
            Math.min(mon.height - y0, Math.round(h) + 24)].join(' ');
    })()" | unwrap
}

tray_box() {
    shell_eval "(() => {
        const actor = Main.panel.statusArea.dateMenu.menu.actor;
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_size();
        if (!(w >= 1 && h >= 1))
            return '';
        const mon = Main.layoutManager.primaryMonitor;
        const x0 = Math.max(0, Math.round(x) - 12);
        return [x0, 0, Math.min(mon.width - x0, Math.round(w) + 24),
            Math.min(mon.height, Math.round(y + h) + 12)].join(' ');
    })()" | unwrap
}

# Deliberately not added to SHOTS: normalize pads every shot to the widest one, and the
# tray is three times an indicator tile — it would blow up the whole grid.
# The quota popup is left open by render_state and overlaps the banner's own rect, so it
# is closed first — a shot of the banner has to frame the banner and nothing else.
capture_notify() {
    local name="$1" box rect parts=()
    close_menu
    point_at away
    await_style
    box="$(banner_box)"
    if [ -n "$box" ]; then
        read -r -a rect <<<"$box"
        shoot "$RUN/banner.png" "${rect[@]}"
        parts+=("$RUN/banner.png")
    else
        printf '  capture notify-%s: no banner live, tray only\n' "$name" >&2
    fi
    date_menu open
    await_style
    box="$(tray_box)"
    [ -n "$box" ] || die "could not measure the notification tray for $name"
    read -r -a rect <<<"$box"
    shoot "$RUN/tray.png" "${rect[@]}"
    date_menu close
    parts+=("$RUN/tray.png")
    magick "${parts[@]}" -background none -gravity center -smush 8 "$(out_dir)/notify-$name.png"
    echo "$(out_dir)/notify-$name.png"
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
        "${tiles[@]}" "$(out_dir)/overview.png"
    echo "  $(out_dir)/overview.png"
}
