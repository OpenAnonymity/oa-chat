#!/usr/bin/env bash
# Release assembly pins this value before publishing install.sh with the assets.
# Keep execution in main: a truncated curl download must not start installation.
main() {
    set -euo pipefail
    umask 022
    export LC_ALL=C

    local release_version='@@VERSION@@'
    # Keep cleanup state outside main's locals: Bash 5 can unwind those before
    # the EXIT trap when an external command fails under errexit.
    prefix=${HOME:?HOME must be set}/.local
    temporary='' release_dir='' install_root='' activated=0 locked=0 created_links=''
    local platform architecture os_version libc_version
    local archive_name base_url expected actual entry mode
    local executable target current_target=''

    fail() { printf 'oa-chat installer: %s\n' "$*" >&2; exit 1; }
    cleanup() {
        local executable target
        # A signal can arrive after the atomic rename but before activated=1.
        # Never delete the bundle already selected by current in that window.
        if [[ -n "$release_dir" && -L "$install_root/current" ]] &&
            [[ "$(readlink "$install_root/current")" = "releases/${release_dir##*/}" ]]; then
            activated=1
        fi
        if [[ "$activated" = 0 ]]; then
            for executable in $created_links; do
                target="$install_root/current/bin/$executable"
                if [[ -L "$prefix/bin/$executable" && "$(readlink "$prefix/bin/$executable")" = "$target" ]]; then
                    rm -f "$prefix/bin/$executable"
                fi
            done
            [[ -z "$release_dir" ]] || rm -rf "$release_dir"
        fi
        [[ -z "$temporary" ]] || rm -rf "$temporary"
        if [[ "$locked" = 1 ]]; then
            rm -f "$install_root/.install-lock/current"
            rmdir "$install_root/.install-lock"
        fi
    }

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version)
                [[ $# -ge 2 ]] || fail '--version requires MAJOR.MINOR.PATCH.'
                release_version=$2; shift 2 ;;
            --prefix)
                [[ $# -ge 2 ]] || fail '--prefix requires an absolute directory.'
                prefix=$2; shift 2 ;;
            --help|-h)
                cat <<'HELP'
Install the OA Chat CLI and its zkAPI companion for the current user.

Usage: bash install.sh [--version MAJOR.MINOR.PATCH] [--prefix ABSOLUTE_DIR]

The published script defaults to its own release version. The source script
requires --version. The default prefix is $HOME/.local; commands go in its bin/.
Requires macOS 13+ or Linux with glibc 2.39+, curl, tar, and SHA-256 tooling.
Linux also needs OpenSSL 3, libgcc, and CA certificates.
Does not run sudo, edit shell profiles, initialize wallets, or start services.
HELP
                return ;;
            *) fail "Unknown argument: $1 (see --help)." ;;
        esac
    done

    [[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
        fail 'Use a published release installer, or supply --version MAJOR.MINOR.PATCH.'
    [[ "$prefix" = /* && "$prefix" != / && "$prefix" != *:* && "$prefix" != *$'\n'* && "$prefix" != *$'\r'* ]] ||
        fail '--prefix must be an absolute directory without colons or newlines, other than /.'
    [[ "$(id -u)" != 0 ]] || fail 'Run this installer as your normal user, without sudo.'

    for executable in curl tar awk mktemp readlink chmod mkdir mv ln rm rmdir cat uname; do
        command -v "$executable" >/dev/null 2>&1 || fail "Required command is missing: $executable."
    done
    if command -v sha256sum >/dev/null 2>&1; then
        checksum() { sha256sum "$1"; }
    elif command -v shasum >/dev/null 2>&1; then
        checksum() { shasum -a 256 "$1"; }
    else
        fail 'Install sha256sum or shasum before running this installer.'
    fi

    case "$(uname -s)" in
        Darwin)
            platform=darwin
            os_version=$(sw_vers -productVersion) || fail 'Cannot determine the macOS version.'
            [[ "$os_version" =~ ^([0-9]+)\. ]] || fail 'Cannot determine the macOS version.'
            (( BASH_REMATCH[1] >= 13 )) || fail 'The native release requires macOS 13 or newer.' ;;
        Linux)
            platform=linux
            libc_version=$(getconf GNU_LIBC_VERSION 2>/dev/null) ||
                fail 'The native Linux release requires glibc 2.39 or newer (musl/Alpine is unsupported).'
            [[ "$libc_version" =~ ^glibc[[:space:]]([0-9]+)\.([0-9]+)$ ]] || fail 'Cannot determine the glibc version.'
            (( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 39) )) ||
                fail 'The native Linux release requires glibc 2.39 or newer; build from source on older distributions.' ;;
        *) fail 'Supported platforms are macOS and Linux (AMD64 or ARM64).' ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64) architecture=amd64 ;;
        arm64|aarch64) architecture=arm64 ;;
        *) fail 'Supported architectures are AMD64 and ARM64.' ;;
    esac
    # An Intel shell under Rosetta should still receive the Apple Silicon build.
    if [[ "$platform" = darwin && "$architecture" = amd64 ]] &&
        [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]]; then
        architecture=arm64
    fi

    mkdir -p "$prefix"
    prefix=$(cd "$prefix" && pwd -P)
    install_root="$prefix/lib/oa-chat"
    mkdir -p "$install_root/releases" "$prefix/bin"
    mkdir "$install_root/.install-lock" 2>/dev/null ||
        fail "Another install may be running. If it has stopped, remove $install_root/.install-lock and retry."
    locked=1
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP

    # Only replace launchers belonging to this installation, never package-manager files.
    for executable in oa-chat oa-zkapi; do
        target="$install_root/current/bin/$executable"
        if [[ -e "$prefix/bin/$executable" || -L "$prefix/bin/$executable" ]]; then
            [[ -L "$prefix/bin/$executable" && "$(readlink "$prefix/bin/$executable")" = "$target" ]] ||
                fail "$prefix/bin/$executable already exists and is not managed by this installer. Choose another --prefix."
        fi
    done
    if [[ -e "$install_root/current" || -L "$install_root/current" ]]; then
        [[ -L "$install_root/current" ]] || fail "$install_root/current is not an installer symlink."
        current_target=$(readlink "$install_root/current")
        [[ "$current_target" =~ ^releases/[0-9]+\.[0-9]+\.[0-9]+-(darwin|linux)-(amd64|arm64)\.[a-zA-Z0-9]+$ ]] ||
            fail "$install_root/current points outside the managed releases."
    fi

    temporary=$(mktemp -d "${TMPDIR:-/tmp}/oa-chat-install.XXXXXX")
    archive_name="oa-chat_${release_version}_${platform}_${architecture}.tar.gz"
    base_url="https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v${release_version}"
    download() {
        curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error \
            --location --retry 3 --connect-timeout 15 --max-time 1800 --output "$2" "$1"
    }
    printf 'Downloading OA Chat %s for %s/%s…\n' "$release_version" "$platform" "$architecture"
    download "$base_url/SHA256SUMS" "$temporary/SHA256SUMS" ||
        fail "Could not download checksums for daemon-v$release_version. Check that this release is published."
    expected=$(awk -v name="$archive_name" '$2 == name { count++; hash=$1 } END { if (count != 1) exit 1; print hash }' "$temporary/SHA256SUMS") ||
        fail "The checksum manifest must contain exactly one entry for $archive_name."
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || fail 'The release checksum is invalid.'
    download "$base_url/$archive_name" "$temporary/archive.tar.gz" || fail 'The archive download failed; the installed version was not changed.'
    actual=$(checksum "$temporary/archive.tar.gz") || fail 'Could not compute the archive checksum.'
    actual=${actual%% *}
    [[ "$actual" = "$expected" ]] || fail 'SHA-256 checksum mismatch; the installed version was not changed.'

    # Native bundles contain regular files and directories only. Reject unsafe paths
    # and links before extraction, even if a malformed archive has a valid checksum.
    tar -tzf "$temporary/archive.tar.gz" > "$temporary/files" || fail 'Cannot read the release archive.'
    local safe_path='^[A-Za-z0-9._/+@ -]+$'
    while IFS= read -r entry; do
        [[ "$entry" =~ $safe_path ]] || fail 'The release archive contains an invalid path.'
        case "$entry" in
            /*|..|../*|*/../*|*/..) fail 'The release archive contains an unsafe path.' ;;
        esac
    done < "$temporary/files"
    tar -tvzf "$temporary/archive.tar.gz" > "$temporary/types" || fail 'Cannot inspect the release archive.'
    while IFS= read -r mode; do
        case "$mode" in
            -*|d*) ;;
            *) fail 'The release archive contains a link or special file.' ;;
        esac
    done < "$temporary/types"
    mkdir "$temporary/unpacked"
    tar -xzf "$temporary/archive.tar.gz" --no-same-owner --no-same-permissions -C "$temporary/unpacked" || fail 'Cannot extract the release archive.'
    for entry in oa-chat oa-zkapi VERSION LICENSE CLI_PACKAGING.md \
        share/oa-chat/build-info.json share/oa-chat/third-party/dependencies.json \
        share/oa-chat/proof-setup/request.pk share/oa-chat/proof-setup/request.vk \
        share/oa-chat/proof-setup/withdrawal.pk share/oa-chat/proof-setup/withdrawal.vk \
        share/oa-chat/proof-setup/manifest.json; do
        [[ -f "$temporary/unpacked/$entry" && -s "$temporary/unpacked/$entry" ]] || fail "Release archive is missing $entry."
    done
    [[ "$(cat "$temporary/unpacked/VERSION")" = "$release_version" ]] || fail 'The archive version does not match the requested release.'

    release_dir=$(mktemp -d "$install_root/releases/$release_version-$platform-$architecture.XXXXXX")
    chmod 755 "$release_dir"
    mkdir "$release_dir/bin"
    mv "$temporary/unpacked/oa-chat" "$temporary/unpacked/oa-zkapi" "$release_dir/bin/"
    mv "$temporary/unpacked/share" "$temporary/unpacked/LICENSE" "$temporary/unpacked/CLI_PACKAGING.md" "$temporary/unpacked/VERSION" "$release_dir/"
    chmod 755 "$release_dir/bin/oa-chat" "$release_dir/bin/oa-zkapi"
    [[ "$("$release_dir/bin/oa-chat" version)" = "oa-chat $release_version" ]] || fail 'The downloaded oa-chat executable could not report the expected version.'
    "$release_dir/bin/oa-zkapi" --help > "$temporary/companion-help" 2>&1 ||
        fail 'The zkAPI companion could not start. Check OS compatibility and installed OpenSSL 3/libgcc libraries; the installed version was not changed.'

    for executable in oa-chat oa-zkapi; do
        if [[ ! -L "$prefix/bin/$executable" ]]; then
            ln -s "$install_root/current/bin/$executable" "$prefix/bin/$executable"
            created_links="$created_links $executable"
        fi
    done
    ln -s "releases/${release_dir##*/}" "$install_root/.install-lock/current"
    # Rename the symlink itself, rather than following the previous directory link.
    if [[ "$platform" = darwin ]]; then
        mv -fh "$install_root/.install-lock/current" "$install_root/current"
    else
        mv -fT "$install_root/.install-lock/current" "$install_root/current"
    fi
    activated=1
    printf '\nInstalled oa-chat %s to %s/bin\n' "$release_version" "$prefix"
    case ":${PATH:-}:" in
        *":$prefix/bin:"*) ;;
        *)
            # shellcheck disable=SC2016 # Print a command for the user's shell.
            printf 'Add this directory to PATH (and your shell profile to keep it):\n  export PATH=%q:"$PATH"\n' "$prefix/bin" ;;
    esac
    target=$(command -v oa-chat || true)
    if [[ -n "$target" && "$target" != "$prefix/bin/oa-chat" ]]; then
        printf 'Your PATH currently selects %s. Put %s/bin first to use this installation.\n' "$target" "$prefix"
    fi
    printf 'Next: oa-chat init, then oa-chat serve. For zkAPI: oa-chat init --backend zkapi.\n'
    if [[ -n "$current_target" ]]; then
        printf 'Restart any running daemon to use the new version. Previous release retained at %s/%s.\n' "$install_root" "$current_target"
    fi
    cleanup
    trap - EXIT
}

main "$@"
