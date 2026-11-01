#!/usr/bin/env bash
set -euo pipefail

image_tag() {
    echo "${REGISTRY:+$REGISTRY/}${GITHUB_REPOSITORY}-ci:$(sha256sum .github/ci.Dockerfile | cut -c1-16)"
}

resolve() {
    printf 'IMAGE=%s\n' "${GIVEN:-$(image_tag)}"
}

verify() {
    local installed
    installed="$(docker run --rm "${IMAGE:?}" pacman -Q gnome-shell | cut -d' ' -f2)"
    [ -n "$installed" ] || { echo "$IMAGE holds no gnome-shell" >&2; return 1; }
    echo "$IMAGE holds gnome-shell $installed"
}

build() {
    docker build --pull -f .github/ci.Dockerfile -t "$IMAGE" .github
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
