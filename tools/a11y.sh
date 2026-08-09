#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='a11y'
# shellcheck source=tools/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/devkit.sh"

main() {
    require_commands magick node
    node "$ROOT/tools/a11y.js" "$@"
}

main "$@"
