# shellcheck shell=bash

SCENARIOS=(normal over-pace warning critical full zero expired model-scoped no-reset
           long-name locale rate-limited rate-limited-day error token-expired loading refreshing fresh no-data
           model-scoped-issue narrow-two narrow-one narrow-icon narrow-issue
           service-degraded service-partial service-major service-maintenance
           service-error)
PICKED=()
FILLER='global.cqPanelFiller'

# Every state below is fabricated, so the real endpoint must never answer over the
# top of it. Stubbing the instance method also spares the shared API rate limit.
# Overriding _refresh alone only stops future calls: a fetch already in flight (the
# enable-time refresh, or preview.sh's own --live startup) resumes inside its
# original async body, where every guard asks whether _cancellable is still the one
# that flight started with. Cancelling does not change that answer, so the tail
# still renders over the fabricated state a few hundred ms later — mid-prove — and
# still applies a response that arrived before the cancel did. Dropping the
# reference is what supersedes the flight, the way _refresh supersedes its own
# predecessor.
freeze() {
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        i._cancellable?.cancel(); i._cancellable = null; i._refresh = () => {}; 'ok'" >/dev/null
}

# freeze sets _refresh as an own property, so delete restores the prototype method.
unfreeze() {
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        delete i._refresh; i._refresh('manual'); 'ok'" >/dev/null
}

set_theme() {
    shell_settle color-scheme "prefer-$1"
}

# warp_pointer is ignored while the devkit viewer owns the pointer, so hover has
# to come from a virtual device emitting real motion events.
point_at_actor() {
    shell_eval "const C = imports.gi.Clutter;
        globalThis._vd ||= C.get_default_backend().get_default_seat()
            .create_virtual_device(C.InputDeviceType.POINTER_DEVICE);
        const a = $1;
        const [ax, ay] = a.get_transformed_position();
        const [aw, ah] = a.get_transformed_size();
        globalThis._vd.notify_absolute_motion(global.get_current_time(),
            Math.round(ax + aw / 2), Math.round(ay + ah / 2));
        'ok'" >/dev/null
}

point_at() {
    case "$1" in
        pill) point_at_actor "Main.panel.statusArea['$UUID']" ;;
        away) point_at_away ;;
        *) die "unknown pointer target $1" ;;
    esac
}

point_at_away() {
    shell_eval "const C = imports.gi.Clutter;
        globalThis._vd ||= C.get_default_backend().get_default_seat()
            .create_virtual_device(C.InputDeviceType.POINTER_DEVICE);
        const mon = Main.layoutManager.primaryMonitor;
        globalThis._vd.notify_absolute_motion(global.get_current_time(),
            Math.round(mon.width / 2), mon.height - 8);
        'ok'" >/dev/null
}

QUOTA="const q = (short, name, percent, severity, leftMin, winMin) => {
    const progress = Math.min(1, Math.max(0, 1 - leftMin / winMin));
    return {
        short, name, percent, severity,
        modelScoped: !['Session (5h)', 'Weekly'].includes(name),
        resetsAt: new Date(Date.now() + leftMin * 60000),
        windowProgress: progress,
        aheadOfPace: percent / 100 - progress > 0.1,
    };
};
const SESSION = 300, WEEK = 10080;"

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
    echo "i._quotas = [q('S','Session (5h)',21,'normal',253,SESSION), q('W','Weekly',94,'critical',13,WEEK)];"
}

# The emulated monitor cannot be resized once the shell is up, so the space is taken
# away from the other side. Sizing the filler from the ladder the extension just
# measured keeps a scenario on the rung it names; a pixel width would drift with the
# font and the rendered text.
squeeze_panel() {
    cat <<JS
        const room = i._panelBudget();
        const rung = i._panelNaturalWidth(Math.min($1, i._panelCells.length));
        i._fitPanel();
        const width = Math.max(0, Math.floor(room - rung));
        if (width > 0) {
            $FILLER = new imports.gi.Clutter.Actor({width, height: 1});
            Main.panel._rightBox.add_child($FILLER);
        }
        i._fitPanel();
JS
}

narrow_cells() {
    case "$1" in
        narrow-two|narrow-issue) echo 2 ;;
        narrow-one) echo 1 ;;
        narrow-icon) echo 0 ;;
        *) echo '' ;;
    esac
}

squeeze_for() {
    local cells
    cells="$(narrow_cells "$1")"
    [ -n "$cells" ] || return 0
    squeeze_panel "$cells"
}

setup_for() {
    case "$1" in
        normal) echo "i._quotas = [q('S','Session (5h)',7,'normal',270,SESSION), q('W','Weekly',12,'normal',9000,WEEK)];" ;;
        over-pace) echo "i._quotas = [q('S','Session (5h)',68,'normal',240,SESSION), q('W','Weekly',20,'normal',2000,WEEK)];" ;;
        warning) echo "i._quotas = [q('S','Session (5h)',78,'warning',90,SESSION), q('W','Weekly',80,'warning',2000,WEEK)];" ;;
        critical) echo "i._quotas = [q('S','Session (5h)',96,'critical',20,SESSION), q('W','Weekly',94,'critical',400,WEEK)];" ;;
        full) echo "i._quotas = [q('S','Session (5h)',100,'critical',5,SESSION), q('W','Weekly',100,'critical',60,WEEK)];" ;;
        zero) echo "i._quotas = [q('S','Session (5h)',0,'normal',300,SESSION), q('W','Weekly',0,'normal',WEEK,WEEK)];" ;;
        expired) echo "i._quotas = [q('S','Session (5h)',40,'normal',-5,SESSION), q('W','Weekly',60,'normal',-5,WEEK)];" ;;
        model-scoped) echo "i._quotas = [q('S','Session (5h)',30,'normal',200,SESSION), q('W','Weekly',44,'normal',5000,WEEK), q('O','Opus',72,'warning',200,SESSION)];" ;;
        no-reset) echo "i._quotas = [q('S','Session (5h)',30,'normal',200,SESSION), q('W','Weekly',44,'normal',5000,WEEK), {...q('O','Opus',72,'normal',200,SESSION), resetsAt: null, windowProgress: null, aheadOfPace: false}];" ;;
        long-name) echo "i._quotas = [q('S','Session (5h)',30,'normal',200,SESSION), q('So','Sonnet with a very long display name',61,'normal',200,SESSION)];" ;;
        locale) echo "$(setup_quotas) i._locale = 'fr-FR';" ;;
        rate-limited) echo "i._quotas = [q('S','Session (5h)',21,'normal',253,SESSION), q('W','Weekly',94,'critical',13,WEEK)]; i._blockedUntil = new Date(Date.now() + 180000);" ;;
        rate-limited-day) echo "$(setup_quotas) i._fetchedAt = new Date(Date.now() - 26 * 3600000); i._blockedUntil = new Date(Date.now() + 26 * 3600000);" ;;
        error) echo "i._quotas = [q('S','Session (5h)',21,'normal',253,SESSION), q('W','Weekly',94,'critical',13,WEEK)]; i._error = 'Cannot reach api.anthropic.com';" ;;
        token-expired) echo "i._quotas = [q('S','Session (5h)',21,'normal',253,SESSION)]; i._error = 'Token expired, run Claude Code once';" ;;
        loading) echo "i._fetchedAt = null;" ;;
        refreshing) echo "$(setup_quotas) i._refreshing = true;" ;;
        fresh) echo "$(setup_quotas) i._fetchedAt = new Date();" ;;
        no-data) echo "i._fetchedAt = null; i._error = 'Cannot reach api.anthropic.com';" ;;
        model-scoped-issue|narrow-issue) echo "$(setup_for model-scoped) i._error = 'Usage request failed (HTTP 503)'; i._serviceStatus = 'partial_outage';" ;;
        narrow-*) setup_for model-scoped ;;
        service-*) echo "$(setup_quotas) i._error = 'Usage request failed (HTTP 503)'; i._serviceStatus = '$(service_status "$1")';" ;;
        *) die "unknown scenario $1" ;;
    esac
}

# The filler is dropped before the state is built and re-added after the render,
# because sizing it needs the ladder of the state being rendered, not the last one's.
render_state() {
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        $QUOTA
        $FILLER?.destroy(); $FILLER = null;
        i._quotas = []; i._error = null; i._serviceStatus = null; i._blockedUntil = null; i._refreshing = false; i._fetchedAt = new Date(Date.now() - 360000); i._locale = 'en-US';
        $(setup_for "$1")
        i.menu.open(false); i._render();
        $(squeeze_for "$1")
        'ok'" >/dev/null
}

close_menu() {
    shell_eval "Main.panel.statusArea['$UUID'].menu.close(false); 'ok'" >/dev/null
}

open_menu() {
    shell_eval "Main.panel.statusArea['$UUID'].menu.open(false); 'ok'" >/dev/null
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
