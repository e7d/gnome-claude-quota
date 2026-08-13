#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN=claude-quota
POT="$ROOT/po/$DOMAIN.pot"
LANGS=(fr)

KEYWORDS=('--keyword=_' '--keyword=N_' '--keyword=n_:1,2' '--keyword=p_:1c,2'
    '--keyword=describe:1' '--keyword=fail:1')

extract() {
    (cd "$ROOT" && xgettext --language=JavaScript --from-code=UTF-8 \
        "${KEYWORDS[@]}" \
        --package-name="$DOMAIN" \
        --copyright-holder='e7d' \
        --msgid-bugs-address='michael@e7d.io' \
        --output="$1" \
        extension.js lib/*.js)
}

merge() {
    local lang
    for lang in "${LANGS[@]}"; do
        msgmerge --quiet --update --backup=none "$ROOT/po/$lang.po" "$1"
    done
}

compile() {
    local lang dir
    for lang in "${LANGS[@]}"; do
        dir="$ROOT/locale/$lang/LC_MESSAGES"
        mkdir -p "$dir"
        msgfmt --check --output-file="$dir/$DOMAIN.mo" "$ROOT/po/$lang.po"
    done
}

# A msgid added in code and never extracted falls back to English silently, which
# reads exactly like a translation nobody has written yet.
check() {
    local tmp lang status=0
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN
    extract "$tmp/$DOMAIN.pot"
    if ! diff -q <(grep -v '^"POT-Creation-Date' "$POT") \
                 <(grep -v '^"POT-Creation-Date' "$tmp/$DOMAIN.pot") >/dev/null; then
        echo "po/$DOMAIN.pot is stale — run npm run i18n" >&2
        status=1
    fi
    for lang in "${LANGS[@]}"; do
        msgfmt --check --output-file="$tmp/$lang.mo" "$ROOT/po/$lang.po"
        cmp -s "$tmp/$lang.mo" "$ROOT/locale/$lang/LC_MESSAGES/$DOMAIN.mo" || {
            echo "locale/$lang/LC_MESSAGES/$DOMAIN.mo is stale — run npm run i18n" >&2
            status=1
        }
    done
    return "$status"
}

case "${1:---all}" in
    --check) check ;;
    --all) extract "$POT"; merge "$POT"; compile ;;
    *) echo "usage: i18n.sh [--all|--check]" >&2; exit 2 ;;
esac
