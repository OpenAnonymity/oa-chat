#!/usr/bin/env bash
set -euo pipefail
umask 022 # Release artifacts are public binaries, never profile state.

# Builds oa-clientd for every supported platform, with no companion or proving
# assets: it needs neither. Set OA_CLIENTD_ENV=staging for a staging artifact
# whose setup defaults to OA staging; the default is production.
version=${1:?Usage: build-oa-clientd.sh VERSION OUTPUT_DIRECTORY}
output_dir=${2:?Output directory required}
environment=${OA_CLIENTD_ENV:-production}
case "$environment" in
    production | staging) ;;
    *) echo 'OA_CLIENTD_ENV must be production or staging' >&2; exit 1 ;;
esac
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
    echo 'Version must be MAJOR.MINOR.PATCH with an optional prerelease suffix.' >&2
    exit 1
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd)
cd "$script_dir/.."
stage=$(mktemp -d "${TMPDIR:-/tmp}/oa-clientd-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT
checksum() {
    if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64; do
    os=${target%/*}
    arch=${target#*/}
    name="oa-clientd-$version-$environment-$os-$arch"
    mkdir -p "$stage/$name"
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false \
        -ldflags="-s -w -X main.version=$version -X main.defaultEnvironment=$environment" \
        -o "$stage/$name/oa-clientd" ./cmd/oa-clientd
    cp LICENSE README.md "$stage/$name/"
    if [[ $os == linux ]]; then
        cp packaging/systemd/oa-clientd.service "$stage/$name/"
    fi
    tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$output_dir/$name.tar.gz" "$name" 2>/dev/null \
        || tar -C "$stage" -czf "$output_dir/$name.tar.gz" "$name"
done
(cd "$output_dir" && checksum oa-clientd-"$version"-"$environment"-*.tar.gz > "oa-clientd-$version-$environment.sha256")
echo "Built oa-clientd $version for OA $environment in $output_dir"
