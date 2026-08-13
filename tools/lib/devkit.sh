# shellcheck shell=bash

UUID='claude-quota@e7d.io'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLED="$HOME/.local/share/gnome-shell/extensions/$UUID"
RUNTIME_ROOT="${CLAUDE_QUOTA_RUNTIME:-${XDG_RUNTIME_DIR:-/tmp}/claude-quota}"

use_session() {
    RUN="$RUNTIME_ROOT/$1"
    CFG="$RUN/config"
    SANDBOX_HOME="$RUN/home"
    BUS_FILE="$RUN/bus"
    PID_FILE="$RUN/pid"
    LOG="$RUN/shell.log"
    STATE_FILE="$RUN/state"
    HOST_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/claude-quota/usage.json"
    SANDBOX_CACHE="$SANDBOX_HOME/.cache/claude-quota/usage.json"
}

session_live() {
    [ -s "$PID_FILE" ] || return 1
    kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

reap_session() {
    session_live && return 0
    rm -rf "$RUN"
    return 0
}

attach_session() {
    session_live || return 1
    DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")"
    export DBUS_SESSION_BUS_ADDRESS
}

state_get() {
    [ -f "$STATE_FILE" ] || return 0
    sed -n "s/^$1=//p" "$STATE_FILE"
}

state_set() {
    local kept="$RUN/state.next"
    [ -f "$STATE_FILE" ] && grep -v "^$1=" "$STATE_FILE" > "$kept" || : > "$kept"
    echo "$1=$2" >> "$kept"
    mv "$kept" "$STATE_FILE"
}

tile_name() {
    local theme
    theme="$(state_get theme)"
    echo "${theme:-default}-$(state_get data)"
}

: "${DEVKIT_NAME:=devkit}"
: "${DEVKIT_SETUP:=}"
: "${DEVKIT_HEADLESS:=0}"
: "${DEVKIT_SESSION:=$DEVKIT_NAME}"
DEVKIT_MONITOR='1440x900'
DEVKIT_VIEWER='/usr/lib/mutter-devkit'

die() {
    echo "$DEVKIT_NAME: $1" >&2
    [ -s "$LOG" ] && tail -5 "$LOG" >&2
    exit 1
}

# Killing by name instead would match the host session's own gnome-shell. The pid
# is read once and the directory rechecked, because a blocking owner reaps the
# session the moment its shell dies — under a concurrent --stop, from beneath us.
stop_shell() {
    [ -s "$PID_FILE" ] || return 0
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
    done
    [ -d "$RUN" ] || return 0
    : > "$PID_FILE"
    : > "$BUS_FILE"
}

release_session() {
    stop_shell
    rm -rf "$RUN"
}

own_session() {
    trap release_session EXIT INT TERM
}

require_commands() {
    local missing=() cmd
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null || missing+=("$cmd")
    done
    [ "${#missing[@]}" -eq 0 ] || die "missing command(s): ${missing[*]}"
}

require_install() {
    require_commands gnome-shell dbus-run-session dconf gsettings gdbus
    if [ "$DEVKIT_HEADLESS" -eq 0 ] && [ ! -x "$DEVKIT_VIEWER" ]; then
        echo "$DEVKIT_NAME: $DEVKIT_VIEWER missing, install mutter-devkit for a window" >&2
    fi
    [ -e "$INSTALLED" ] || die "not installed; run: ln -s '$ROOT' '$INSTALLED'"
    [ "$(readlink -f "$INSTALLED")" = "$ROOT" ] ||
        die "$INSTALLED points at $(readlink -f "$INSTALLED"), not this checkout"
}

isolate_dconf() {
    local live="${XDG_CONFIG_HOME:-$HOME/.config}/dconf/user"
    mkdir -p "$CFG/dconf"
    [ -f "$live" ] && cp "$live" "$CFG/dconf/user"
    return 0
}

# --headless starts with no monitor at all, where --devkit brings its own; giving
# --devkit a --virtual-monitor too would strand the panel on a second display the
# viewer window never shows.
devkit_flag() {
    case "$1" in
        --headless) DEVKIT_HEADLESS=1 ;;
        --windowed) DEVKIT_HEADLESS=0 ;;
        *) return 1 ;;
    esac
}

backend_args() {
    if [ "$DEVKIT_HEADLESS" -eq 1 ]; then
        printf '%s\n' --headless --virtual-monitor "$DEVKIT_MONITOR"
    else
        printf '%s\n' --devkit
    fi
}

# The nested shell gets a HOME of its own so the extension finds no credentials
# there and cannot spend a request at startup — three consecutive 401s earn the
# account an hour's block, and the tooling used to outspend the product three to
# one. It also keeps the token out of the nested session altogether, and sends its
# cache and attempt log to the sandbox instead of over the host's evidence.
prepare_home() {
    mkdir -p "$SANDBOX_HOME/.local/share/gnome-shell/extensions"
    ln -sfn "$ROOT" "$SANDBOX_HOME/.local/share/gnome-shell/extensions/$UUID"
}

seed_cache() {
    mkdir -p "$(dirname "$SANDBOX_CACHE")"
    cp "$1" "$SANDBOX_CACHE"
}

host_cache_path() {
    printf '%s\n' "$HOST_CACHE"
}

# XDG_CONFIG_HOME does not sandbox dconf, so a write hoisted out of this
# dbus-run-session lands in the live session's database instead.
start_shell() {
    mkdir -p "$RUN"
    prepare_home
    local backend
    mapfile -t backend < <(backend_args)
    # shellcheck disable=SC2016
    HOME="$SANDBOX_HOME" XDG_CONFIG_HOME="$CFG" dbus-run-session -- bash -c '
        echo "$DBUS_SESSION_BUS_ADDRESS" > "$1"
        echo $$ > "$2"
        dconf write /org/gnome/shell/enabled-extensions "['"'"'$3'"'"']"
        dconf write /org/gnome/shell/disable-user-extensions false
        dconf reset /org/gnome/desktop/background/picture-uri
        dconf reset /org/gnome/desktop/background/picture-uri-dark
        dconf reset /org/gnome/desktop/background/primary-color
        dconf reset /org/gnome/desktop/interface/color-scheme
        dconf reset /org/gnome/desktop/interface/accent-color
        eval "$4"
        exec gnome-shell "${@:5}" --unsafe-mode
    ' _ "$BUS_FILE" "$PID_FILE" "$UUID" "$DEVKIT_SETUP" "${backend[@]}" >"$LOG" 2>&1 &
    for _ in $(seq 300); do
        [ -s "$BUS_FILE" ] && break
        sleep 0.2
    done
    [ -s "$BUS_FILE" ] || die 'shell never published a bus address'
    DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")"
    export DBUS_SESSION_BUS_ADDRESS
}

shell_eval() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null
}

eval_json() {
    shell_eval "JSON.stringify($1)" | unwrap
}

# Eval answers from the actor tree while a screenshot reads the framebuffer, so a
# change is observable over D-Bus several frames before it is on screen.
await_paint() {
    sleep 0.05
}

STYLE_SETTLE=''

# Hover and open both repaint the panel button through a CSS transition, so a shot
# taken before it lands catches a colour that belongs to neither state.
await_style() {
    [ -n "$STYLE_SETTLE" ] || STYLE_SETTLE="$(style_settle_seconds)"
    sleep "$STYLE_SETTLE"
}

style_settle_seconds() {
    if [ "$(eval_json "imports.gi.St.Settings.get().enable_animations")" = 'true' ]; then
        awk -v ms="$(eval_json "Main.panel.statusArea['$UUID'].get_theme_node().get_transition_duration()")" \
            'BEGIN { print (ms + 16) / 1000 }'
    else
        echo 0.05
    fi
}

set_animations() {
    XDG_CONFIG_HOME="$CFG" gsettings set org.gnome.desktop.interface enable-animations "$1"
    STYLE_SETTLE=''
    await_paint
}

elapsed_since() {
    awk -v started="$1" -v now="$(date +%s%N)" 'BEGIN { printf "%.1f", (now - started) / 1000000000 }'
}

shell_settle() {
    XDG_CONFIG_HOME="$CFG" gsettings set org.gnome.desktop.interface "$1" "$2"
    sleep 2
}

is_true() {
    case "$1" in
        "(true, '\"true\"')"|"(true, 'true')") return 0 ;;
        *) return 1 ;;
    esac
}

wait_for_indicator() {
    for _ in $(seq 240); do
        is_true "$(shell_eval "Object.keys(Main.panel.statusArea).includes('$UUID').toString()")" &&
            return 0
        sleep 0.25
    done
    die "indicator $UUID never appeared"
}

# The shell opens the overview again a second or so into startup, well after the
# indicator appears, and a hide issued while that show animates is swallowed — as is
# one from a 'showing' or 'shown' handler, and clearing sessionMode.hasOverview does
# not stop it either. Taking show away is what holds; the loop still hides, for an
# overview already on its way up. The original is kept so a session driven by hand can
# put it back.
hide_overview() {
    shell_eval "globalThis._cqOverviewShow ??= Main.overview.show.bind(Main.overview);
        Main.overview.show = () => {};
        'ok'" >/dev/null
    local quiet=0
    for _ in $(seq 150); do
        if is_true "$(shell_eval 'Main.overview.visible.toString()')"; then
            quiet=0
            shell_eval "Main.overview.hide(); 'ok'" >/dev/null
        else
            quiet=$((quiet + 1))
            [ "$quiet" -ge 5 ] && return 0
        fi
        sleep 0.2
    done
    echo "$DEVKIT_NAME: overview would not stay hidden" >&2
}

unwrap() {
    sed -n "s/^(true, '\(.*\)')\$/\1/p" | tr -d '"'
}

use_session "$DEVKIT_SESSION"
