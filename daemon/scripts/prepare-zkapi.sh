#!/usr/bin/env bash
set -euo pipefail

# Fetch immutable upstream commits; the bridge patch is maintained with the daemon.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)
destination=${1:?Usage: prepare-zkapi.sh EMPTY_DESTINATION}
# shellcheck source=daemon/packaging/zkapi-source.env
source "$repo_dir/daemon/packaging/zkapi-source.env"

if [[ -e "$destination" ]]; then
    echo 'Destination already exists; use a fresh build directory.' >&2
    exit 1
fi
git clone --filter=blob:none --no-checkout https://github.com/OpenAnonymity/zkapi.git "$destination"
git -C "$destination" fetch --depth=1 origin "$OA_COMPANION_COMMIT"
git -C "$destination" checkout --detach "$OA_COMPANION_COMMIT"
git -C "$destination" submodule update --init --recursive --depth=1
test "$(git -C "$destination" rev-parse HEAD)" = "$OA_COMPANION_COMMIT"
test "$(git -C "$destination/protocol" rev-parse HEAD)" = "$OA_PROTOCOL_COMMIT"
# Apply to the complete index as well as the working tree. Git 2.43's
# --intent-to-add path can replace the index with only the patched files.
git -C "$destination" apply --check --index "$repo_dir/daemon/internal/zkapi/companion.patch"
git -C "$destination" apply --index "$repo_dir/daemon/internal/zkapi/companion.patch"
git -C "$destination/protocol" apply --check --index "$repo_dir/daemon/internal/zkapi/protocol-transport.patch"
git -C "$destination/protocol" apply --index "$repo_dir/daemon/internal/zkapi/protocol-transport.patch"
python3 "$script_dir/verify-zkapi-source.py" "$destination" "$OA_COMPANION_COMMIT" "$OA_PROTOCOL_COMMIT"
echo "Prepared pinned ZKAPI companion at $destination"
