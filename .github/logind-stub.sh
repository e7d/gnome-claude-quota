#!/usr/bin/env bash
set -euo pipefail

install -d /run/dbus
dbus-daemon --system --fork
python -m dbusmock --system org.freedesktop.login1 /org/freedesktop/login1 \
    org.freedesktop.login1.Manager >/var/log/logind-stub.log 2>&1 &

python - <<'PY'
import time

import dbus

for attempt in range(40):
    try:
        proxy = dbus.SystemBus().get_object('org.freedesktop.login1', '/org/freedesktop/login1')
        dbus.Interface(proxy, 'org.freedesktop.DBus.Mock').AddTemplate('logind', dbus.Dictionary({}, signature='sv'))
        raise SystemExit(0)
    except dbus.DBusException:
        time.sleep(0.5)
raise SystemExit('logind stub never took its name on the system bus')
PY
