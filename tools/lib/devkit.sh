# shellcheck shell=bash

UUID='claude-quota@e7d.io'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# A fixed name under a world-writable /tmp is a path any other user on the host can create
# first, and what goes in it is a lock and a sandbox home. Without a runtime directory to
# put it in, the fallback is at least scoped to this uid.
default_runtime_root() {
    if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
        printf '%s/claude-quota' "$XDG_RUNTIME_DIR"
    else
        printf '/tmp/claude-quota-%s' "$(id -u)"
    fi
}

RUNTIME_ROOT="${CLAUDE_QUOTA_RUNTIME:-$(default_runtime_root)}"
DEVKIT_LANGUAGE="${DEVKIT_LANGUAGE:-C}"
DEVKIT_LOCALE="${DEVKIT_LOCALE:-C}"

normalize_locale() {
    case "$1" in
        C|POSIX|*.*) printf '%s' "$1" ;;
        *) printf '%s.UTF-8' "$1" ;;
    esac
}

locale_tag() {
    printf '%s' "${1%%.*}"
}

locale_subdir() {
    [ "$DEVKIT_LANGUAGE" = 'C' ] && [ "$DEVKIT_LOCALE" = 'C' ] && return 0
    printf '%s-%s' "$(locale_tag "$DEVKIT_LANGUAGE")" "$(locale_tag "$DEVKIT_LOCALE")"
}

# locale -a spells it fr_FR.utf8, so an exact match would reject the very form the
# flag documents — and an ungenerated locale falls back to C without a word.
locale_available() {
    local want
    want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '-')"
    locale -a 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '-' | grep -qx "$want"
}

# Everything fixed at start_shell belongs here. A flag that only takes effect on a
# fresh shell and is silently dropped on an attached one renders the wrong thing and
# reports success.
stale_axis() {
    local want
    want="${WANT_BACKEND:-}"
    if [ -n "$want" ] && [ "$want" != "$(state_get backend)" ]; then
        printf '%s' "$want"
        return 0
    fi
    if [ "$DEVKIT_LANGUAGE" != "$(state_get language)" ]; then
        printf 'language %s' "$DEVKIT_LANGUAGE"
        return 0
    fi
    if [ "$DEVKIT_LOCALE" != "$(state_get locale)" ]; then
        printf 'locale %s' "$DEVKIT_LOCALE"
    fi
}

# An assertion that spells an English msgid can never pass under --language, and a
# control reports that as a dead assertion. Read the wording from the catalog the
# shell is reading instead of keeping a second copy of it here.
catalog_msg() {
    TEXTDOMAINDIR="$ROOT/locale" LC_ALL="$DEVKIT_LANGUAGE" gettext -d claude-quota "$1"
}

catalog_prefix() {
    local text
    text="$(catalog_msg "$1")"
    printf '%s' "${text%%\{*}"
}

# The notification title's msgid opens on a placeholder, so catalog_prefix returns
# nothing to match on; the connector between the two placeholders is what proves a
# language run reached the catalog.
catalog_infix() {
    local text
    text="$(catalog_msg "$1")"
    text="${text#*\}}"
    printf '%s' "${text%%\{*}"
}

js_string() {
    local escaped="${1//\\/\\\\}"
    printf '"%s"' "${escaped//\"/\\\"}"
}

accept_locale() {
    local value
    value="$(normalize_locale "$1")"
    if ! locale_available "$value"; then
        die "locale '$value' is not generated on this host; locale -a lists what is"
    fi
    printf '%s' "$value"
}

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
    : > "$kept"
    if [ -f "$STATE_FILE" ]; then
        grep -v "^$1=" "$STATE_FILE" > "$kept" || true
    fi
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
: "${GTK_A11Y:=none}"
export GTK_A11Y
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

keep_log() {
    [ -n "${DEVKIT_KEEP_LOG:-}" ] && [ -s "$LOG" ] || return 0
    mkdir -p "$(dirname "$DEVKIT_KEEP_LOG")"
    cp "$LOG" "$DEVKIT_KEEP_LOG"
}

release_session() {
    stop_shell
    keep_log
    rm -rf "$RUN"
}

own_session() {
    trap release_session EXIT INT TERM
}

# The kernel holds this against the open descriptor and drops it on any exit, kill
# included, so there is no stale lock to detect or clear. It sits outside $RUN
# because reap_session removes that directory, and a second run would then lock a
# fresh file and walk straight in. Two suites sharing one nested shell interleave
# their state and their pointer, which reads as a defect anywhere in the run.
claim_session() {
    mkdir -p "$RUNTIME_ROOT"
    [ -O "$RUNTIME_ROOT" ] || die "$RUNTIME_ROOT is not owned by this user; remove it and retry"
    chmod 700 "$RUNTIME_ROOT"
    exec 9>"$RUNTIME_ROOT/$1.lock"
    flock -n 9 || die "session '$1' is already running; wait for it, or --stop it first"
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
        --language=*) DEVKIT_LANGUAGE="$(accept_locale "${1#*=}")" ;;
        --locale=*) DEVKIT_LOCALE="$(accept_locale "${1#*=}")" ;;
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
    env -u LC_ALL HOME="$SANDBOX_HOME" XDG_CONFIG_HOME="$CFG" LANG=C \
    LC_MESSAGES="$DEVKIT_LANGUAGE" LC_TIME="$DEVKIT_LOCALE" LC_NUMERIC="$DEVKIT_LOCALE" \
    dbus-run-session -- bash -c '
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
        exec gnome-shell --wayland-display="$5" "${@:6}" --unsafe-mode
    ' _ "$BUS_FILE" "$PID_FILE" "$UUID" "$DEVKIT_SETUP" "$DEVKIT_NAME" "${backend[@]}" >"$LOG" 2>&1 &
    for _ in $(seq 300); do
        [ -s "$BUS_FILE" ] && break
        sleep 0.2
    done
    [ -s "$BUS_FILE" ] || die 'shell never published a bus address'
    DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")"
    export DBUS_SESSION_BUS_ADDRESS
}

# A call that fails or stalls says so on stderr: under set -e a failed Eval otherwise ends the
# run with status 1 and no text, which is how a CI job sat silent for two minutes and died.
stall_evidence() {
    echo "devkit: load $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo unknown)" >&2
    [ -s "$LOG" ] && { echo "devkit: shell log tail" >&2; tail -15 "$LOG" >&2; }
    return 0
}

shell_eval() {
    local out status started elapsed
    started="$(date +%s)"
    out="$(gdbus call --session --timeout 30 --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1)" && status=0 || status=$?
    elapsed=$(($(date +%s) - started))
    if [ -z "${DEVKIT_EVAL_QUIET:-}" ]; then
        [ "$elapsed" -lt 5 ] || echo "devkit: slow Eval (${elapsed}s, status $status): $(tr '\n' ' ' <<< "${1:0:120}")" >&2
        [ "$status" -eq 0 ] || echo "devkit: Eval failed (status $status): ${out:0:200} :: $(tr '\n' ' ' <<< "${1:0:120}")" >&2
        [ "$elapsed" -lt 5 ] || stall_evidence
    fi
    printf '%s\n' "$out"
    return "$status"
}

eval_json() {
    shell_eval "JSON.stringify($1)" | unwrap
}

# Eval answers from the actor tree while a screenshot reads the framebuffer, so a
# change is observable over D-Bus several frames before it is on screen.
await_paint() {
    sleep 0.05
}

# A GSettings write returns before the backend has dispatched changed:: on the main
# loop, so a handler-driven state is not observable on the next round trip by right.
await_prefs() {
    sleep 0.2
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

display_config() {
    gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig \
        --method "org.gnome.Mutter.DisplayConfig.$1" "${@:2}"
}

# On the host's bus this would rescale the user's real screens. A nested --headless
# shell has exactly one monitor, Mutter's virtual one, which a real screen never is.
set_monitor_scale() {
    local state monitor connector mode serial
    state="$(display_config GetCurrentState)"
    monitor="$(grep -oE "\(\('[^']*', '[^']*', '[^']*', '[^']*'\), \[" <<< "$state" || true)"
    [ "$(grep -c . <<< "$monitor")" -eq 1 ] && [[ "$monitor" == *"'MetaVirtualMonitor'"* ]] \
        || die 'refusing to rescale: this bus does not belong to a nested headless shell'
    connector="$(sed -E "s/^\(\('([^']*)'.*/\1/" <<< "$monitor")"
    mode="$(grep -oE "\('[^']+'(, [0-9.]+){4}, \[[^]]*\], \{'is-current': <true>" <<< "$state" \
        | sed -E "s/^\('([^']+)'.*/\1/" || true)"
    serial="$(grep -oE '^\(uint32 [0-9]+' <<< "$state" | grep -oE '[0-9]+$' || true)"
    [ -n "$mode" ] && [ -n "$serial" ] || die 'could not read the current mode of the virtual monitor'
    display_config ApplyMonitorsConfig "$serial" 1 \
        "[(0, 0, $1, uint32 0, true, [('$connector', '$mode', @a{sv} {})])]" '@a{sv} {}' >/dev/null
}

set_quota_pref() {
    XDG_CONFIG_HOME="$CFG" GSETTINGS_SCHEMA_DIR="$ROOT/schemas" \
        gsettings set org.gnome.shell.extensions.claude-quota "$1" "$2"
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
        is_true "$(DEVKIT_EVAL_QUIET=1 shell_eval "Object.keys(Main.panel.statusArea).includes('$UUID').toString()")" &&
            return 0
        sleep 0.25
    done
    die "indicator $UUID never appeared"
}

# A separate GTK process, so it needs the same sandboxed HOME and dconf as the shell
# itself or it would read and write the user's real settings instead of the session's.
# The actor appears before Mutter places and sizes it, so the wait is on the frame
# rect settling rather than on the actor merely existing — measured window rows of
# (0,0,0,0) for the first frames.
prefs_window() {
    env -u LC_ALL HOME="$SANDBOX_HOME" XDG_CONFIG_HOME="$CFG" \
        WAYLAND_DISPLAY="$DEVKIT_NAME" GDK_BACKEND=wayland \
        LC_MESSAGES="$DEVKIT_LANGUAGE" LC_TIME="$DEVKIT_LOCALE" LC_NUMERIC="$DEVKIT_LOCALE" \
        gnome-extensions prefs "$UUID" >>"$LOG" 2>&1 &
    for _ in $(seq 100); do
        is_true "$(shell_eval "global.get_window_actors().some(a => a.meta_window.get_frame_rect().width > 0).toString()")" &&
            return 0
        sleep 0.2
    done
    die 'the preferences window never appeared'
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

# gdbus wraps a reply as (true, '<payload>'), and JSON's own quoting comes off with the
# wrapper: a scalar arrives bare and a structure arrives with every string unquoted, which is
# the shape every assertion in the suite compares against. The consequence is the part worth
# knowing — a value whose own text contains a quote is indistinguishable from one that does
# not, so read such a thing as a number or one field at a time rather than as a joined string.
unwrap() {
    sed -n "s/^(true, '\(.*\)')\$/\1/p" | tr -d '"'
}

use_session "$DEVKIT_SESSION"
