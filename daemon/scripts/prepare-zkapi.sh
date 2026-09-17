#!/usr/bin/env bash
set -euo pipefail

# Fetch immutable upstream commits; the bridge patch is maintained with the daemon.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)
destination=${1:?Usage: prepare-zkapi.sh EMPTY_DESTINATION}
source "$repo_dir/daemon/packaging/zkapi-source.env"

if [[ -e "$destination" ]]; then
    echo 'Destination already exists; use a fresh build directory.' >&2
    exit 1
fi
git clone --filter=blob:none --no-checkout https://github.com/OpenAnonymity/zkapi-EF-collab.git "$destination"
git -C "$destination" fetch --depth=1 origin "$OA_COMPANION_COMMIT"
git -C "$destination" checkout --detach "$OA_COMPANION_COMMIT"
git -C "$destination" submodule update --init --recursive --depth=1
test "$(git -C "$destination" rev-parse HEAD)" = "$OA_COMPANION_COMMIT"
test "$(git -C "$destination/protocol" rev-parse HEAD)" = "$OA_PROTOCOL_COMMIT"
git -C "$destination" apply --check "$repo_dir/daemon/internal/zkapi/companion.patch"
git -C "$destination" apply "$repo_dir/daemon/internal/zkapi/companion.patch"
git -C "$destination/protocol" apply --check "$repo_dir/daemon/internal/zkapi/protocol-transport.patch"
git -C "$destination/protocol" apply "$repo_dir/daemon/internal/zkapi/protocol-transport.patch"
echo "Prepared pinned ZKAPI companion at $destination"
