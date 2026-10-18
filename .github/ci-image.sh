#!/usr/bin/env bash
set -euo pipefail

gnome_version() {
    local package
    package="$(curl -fsS --max-time 20 --retry 5 --retry-all-errors --retry-delay 3 \
        https://archlinux.org/packages/extra/x86_64/gnome-shell/json/)"
    jq -r '(if .epoch == 0 then "" else "\(.epoch):" end) + .pkgver + "-" + .pkgrel' <<< "$package"
}

image_tag() {
    echo "${REGISTRY:+$REGISTRY/}${GITHUB_REPOSITORY}-ci:$(sha256sum .github/ci.Dockerfile | cut -c1-16)-gnome-${1//:/_}"
}

resolve() {
    local gnome image
    if [ -n "${GIVEN:-}" ]; then
        image="$GIVEN"
        gnome="${GIVEN##*-gnome-}"
        gnome="${gnome//_/:}"
    else
        gnome="$(gnome_version)"
        case "$gnome" in
            ''|*null*) echo "cannot tell which gnome-shell Arch ships today" >&2; return 1 ;;
        esac
        image="$(image_tag "$gnome")"
    fi
    printf 'IMAGE=%s\nGNOME=%s\n' "$image" "$gnome"
}

verify() {
    local installed
    installed="$(docker run --rm "${IMAGE:?}" pacman -Q gnome-shell | cut -d' ' -f2)"
    [ "$installed" = "${GNOME:?}" ] || { echo "$IMAGE holds gnome-shell $installed, not $GNOME" >&2; return 1; }
}

build() {
    docker build --pull --build-arg "GNOME_VERSION=$GNOME" -f .github/ci.Dockerfile -t "$IMAGE" .github
}

retry() {
    local attempt
    for attempt in 1 2 3; do
        "$@" && return 0
        echo "$1 attempt $attempt failed" >&2
        sleep $((attempt * 15))
    done
    return 1
}

publish() {
    if [ -z "${REGISTRY:-}" ]; then
        echo "no registry to share an image through: each job builds its own"
        return 0
    fi
    if docker manifest inspect "$IMAGE" > /dev/null 2>&1; then
        echo "$IMAGE is already published"
        return 0
    fi
    build
    verify
    retry docker push "$IMAGE"
}

use() {
    if [ -n "${REGISTRY:-}" ]; then
        retry docker pull "$IMAGE"
    else
        build
    fi
    verify
}

case "${1:-}" in
    resolve) resolve ;;
    publish) publish ;;
    use) use ;;
    *) echo "usage: ci-image.sh resolve|publish|use" >&2; exit 2 ;;
esac
