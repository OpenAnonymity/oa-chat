#!/usr/bin/env bash
set -euo pipefail
umask 022 # Release artifacts are public binaries, never profile state.

# Builds oa-clientd for every supported platform, with no companion or proving
# assets: it needs neither. Set OA_CLIENTD_ENV=staging for a staging artifact
# whose setup defaults to OA staging; the default is production.
#
# Archives carry README.md and DEVELOPMENT.md. Their links into the rest of the
# repository are rewritten to the published source at OA_CLIENTD_SOURCE_REV,
# by default this checkout's HEAD commit, which must be pushed for them to open.
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
revision=${OA_CLIENTD_SOURCE_REV:-}
if [[ -z $revision ]]; then
    revision=$(git rev-parse --verify -q HEAD 2>/dev/null || true)
fi
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'Set OA_CLIENTD_SOURCE_REV to the full commit the archive documents link to.' >&2
    exit 1
fi
if [[ -z ${OA_CLIENTD_SOURCE_REV:-} ]] && [[ -n $(git status --porcelain -- . ../docs 2>/dev/null) ]]; then
    echo "Warning: uncommitted changes; archive links point at $revision." >&2
fi
source_url="https://github.com/OpenAnonymity/oa-chat/blob/$revision"
stage=$(mktemp -d "${TMPDIR:-/tmp}/oa-clientd-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT
# Links to files the archive ships stay relative; links to source files or to
# the web app's docs point at the same paths in the published repository.
archive_doc() {
    sed -E \
        -e "s#\]\(\.\./([^)]*)\)#]($source_url/\1)#g" \
        -e "s#\]\(((cmd|internal|pkg|scripts|packaging)/[^)]*)\)#]($source_url/oa-clientd/\1)#g" \
        "$1" > "$2"
}
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
    cp LICENSE "$stage/$name/"
    archive_doc README.md "$stage/$name/README.md"
    archive_doc DEVELOPMENT.md "$stage/$name/DEVELOPMENT.md"
    if [[ $os == linux ]]; then
        cp packaging/systemd/oa-clientd.service "$stage/$name/"
    fi
    tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$output_dir/$name.tar.gz" "$name" 2>/dev/null \
        || tar -C "$stage" -czf "$output_dir/$name.tar.gz" "$name"
done
(cd "$output_dir" && checksum oa-clientd-"$version"-"$environment"-*.tar.gz > "oa-clientd-$version-$environment.sha256")
echo "Built oa-clientd $version for OA $environment in $output_dir"
