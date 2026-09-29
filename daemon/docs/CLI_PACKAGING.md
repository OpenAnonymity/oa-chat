# OA Chat daemon packaging and client integration

The Go daemon lives under `daemon/` and presents an OpenAI-compatible API at
`http://127.0.0.1:8787/v1`. It runs in the foreground; Homebrew Services or a
systemd **user** service owns its lifetime. The service runs as the same user
who imported tickets or funded the private balance.

## Local configuration

Run `oa-chat start` for guided creation and readiness checks. For explicit
service-manager setup, run `oa-chat init` before starting the service.
Configuration is stored in
`config.json` under Go's `os.UserConfigDir()/oa-chat`: normally
`~/.config/oa-chat` on Linux and `~/Library/Application Support/oa-chat` on
macOS. `OA_CHAT_CONFIG_DIR` or a global `--config-dir` selects a separate
configuration, for example for staging. Do not run initialization or funding
with `sudo`.

Configure your client with the daemon's local API token and the API base URL.
The local token authenticates clients to this daemon; it is not an OA ticket,
wallet secret, or provider API key. The daemon accepts only loopback listeners.
Withdrawals also require a separate `management-token` in that private directory.
The CLI creates and reads this owner-only credential automatically; do not share
it with inference clients. It is excluded from `config.json` serialization.
Client applications
retain their own transcripts under their own storage/privacy settings.

## One-command installation

The shell installer uses the same native release archives as Homebrew and
AUR. Install or update version `0.3.2`:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.3.2/install.sh | bash
```

Run guided first-time setup separately:

```sh
PATH="$HOME/.local/bin:$PATH" oa-chat start
```

Setup creates missing default configuration, checks readiness, and walks through
funding if needed. For new configuration, Mainnet is the default network and
Sepolia is offered as an option; an existing configuration keeps its saved
network. Select Sepolia in the prompt or pass `start --network sepolia` for test
funds. See the [guided walkthrough](CLI_ZKAPI.md#guided-first-time-setup).

The optional installer `--setup` flag still runs the installed `oa-chat start`
after validation, activation, and cleanup. It places the installed companion
first on PATH for that process. Add `--network sepolia` only when selecting test
funds explicitly. Prompts read your controlling terminal, never the piped
installer script.

The published script is pinned to its own release version. It downloads the
matching archive and `SHA256SUMS` over HTTPS, verifies the archive before
extracting it, and checks both binaries before activating the installation.
The supported targets are macOS 13+ and Linux with glibc 2.39+, each on AMD64
or ARM64. Linux requires OpenSSL 3, libgcc, and CA certificates; install missing
runtime libraries with the distribution's package manager. Bash, `curl`,
`tar`, and either `sha256sum` or `shasum` must be available. No compiler,
Homebrew, Python, or root access is needed to run the installer.

Launchers default to `~/.local/bin`. In a future terminal, run
`PATH="$HOME/.local/bin:$PATH" oa-chat start`, or follow the printed PATH
guidance to use the shorter `oa-chat start` command. For a custom prefix,
substitute its `bin` directory in PATH. This selects both matching binaries. Omit `--network`
with `--setup` to use an existing configuration's network or answer the new
configuration's network prompt. `--network` is accepted only with `--setup`
and must be `mainnet` or `sepolia`; invalid arguments fail before downloading.
The default install-only command does not create configuration, initialize or
fund wallets, start a daemon, register a service, or edit shell startup files.
`--setup` starts a foreground process or attaches to a compatible daemon; it
does not register a background service either.

To select another writable absolute prefix:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.3.2/install.sh | bash -s -- --prefix "$HOME/oa-tools"
```

An exact-tag URL works for either a stable release or a GitHub prerelease and
keeps the installation version pinned. Prerelease status is GitHub release
metadata; the tag and installer version are `daemon-v0.3.2` and `0.3.2`.
GitHub's `latest/download` URL excludes prereleases and is repository-wide.
For a future stable daemon release explicitly marked as latest, this optional
command follows that stable release:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/latest/download/install.sh | bash
```

`--version MAJOR.MINOR.PATCH` can override the script's pinned version;
`--help` lists the options. The source file `daemon/install.sh` requires an
explicit `--version` because its release placeholder is filled only by
`assemble-release.py`. Guided `start` requires version `0.3.0` or newer.

Stop a running daemon before upgrading, rerun the installation command with
the same prefix, and restart afterward (`--setup` runs the guided restart).
The installer does not terminate an existing daemon. An upgrade retains the
previous release directory and activates a fully checked new directory by
switching the managed `current` link. Existing configuration, tickets, and
wallet state remain in the separate private configuration directory.
Reinitializing is unnecessary. `oa-chat version` should print `oa-chat 0.3.2`
after this upgrade. A setup failure leaves the validated installation in place
and returns the CLI's failure status so you can rerun `start` after addressing
it. The installer does not migrate legacy ERC-20 notes to native ETH; retain
their recovery directory and matching old client, and use a fresh config for
the native deployment. Launchers belonging to an unrelated installation are
refused; use its package manager for a Homebrew/package upgrade or choose
another prefix.

The managed layout is:

```text
PREFIX/bin/oa-chat  -> PREFIX/lib/oa-chat/current/bin/oa-chat
PREFIX/bin/oa-zkapi -> PREFIX/lib/oa-chat/current/bin/oa-zkapi
PREFIX/lib/oa-chat/current -> releases/RELEASE_DIRECTORY
PREFIX/lib/oa-chat/releases/RELEASE_DIRECTORY/
  bin/oa-chat
  bin/oa-zkapi
  share/oa-chat/proof-setup/
  share/oa-chat/build-info.json
  share/oa-chat/third-party/
```

The companion resolves symlinks and finds proving assets relative to its real
`bin` directory. Keep binaries and `share` together. Launcher links use the
absolute prefix; reinstall with `--prefix` to change the installation location.
The shell installer retains the package's systemd unit as release metadata but
does not register it with systemd. Its
`ExecStart` uses `/usr/bin/oa-chat`; use foreground `oa-chat serve` or configure
a user service with the chosen prefix and PATH.

Use the exact-tag commands for this prerelease; GitHub's `latest/download`
does not select it. The September 22 `0.1.0` publication record below is
historical evidence. Public package repositories, including a Homebrew tap
and an AUR package, have not yet been published.

## Homebrew

Each release generates `homebrew/oa-chat.rb` with actual SHA-256 hashes for
macOS and Linux on both Apple/ARM64 and AMD64 architectures. A maintainer
copies that generated formula to a Homebrew tap; no tap is published by the
build scripts. Once installed from that tap:

```sh
oa-chat init
brew services start oa-chat
brew services list
brew services stop oa-chat
```

Homebrew runs the process as your login user and retains your configuration
across upgrades. The service log is `$(brew --prefix)/var/log/oa-chat.log`.
Restart after changing configuration with `brew services restart oa-chat`.
If a custom configuration is required for a managed service, use the service
manager's environment configuration; shell exports are not automatically
inherited by a login service.

The formula includes the matching Rust companion, proof assets, and dependency
notices. macOS requires Ventura (13) or newer. Linux uses the release's glibc
2.39 baseline and adds the brewed OpenSSL 3 library directory to the companion's
runtime search path; `patchelf` is needed only during installation. `brew test`
checks both executables and all five proof assets.

## Debian, Ubuntu, Fedora, and other RPM distributions

Release `.deb` and `.rpm` files contain the binaries, proof setup data, license,
documentation, and `/usr/lib/systemd/user/oa-chat.service`. Install the package
matching your architecture with your distribution package manager. Packages
do not start a funded service automatically.
The release workflow uses Ubuntu 24.04 and declares glibc 2.39 or newer;
older distributions need a native source build on their own baseline.

```sh
oa-chat init
systemctl --user daemon-reload
systemctl --user enable --now oa-chat.service
systemctl --user status oa-chat.service
journalctl --user -u oa-chat.service
systemctl --user stop oa-chat.service
```

To stop starting it at login, run `systemctl --user disable --now
oa-chat.service`. For operation after logout, a machine administrator may
enable lingering for your user with `loginctl enable-linger USERNAME`.
For a custom config directory, use `systemctl --user edit oa-chat.service`:

```ini
[Service]
Environment=OA_CHAT_CONFIG_DIR=/absolute/private/directory
```

Then restart the user service. Configuration and cash-like tickets remain in
your private directory when a package is removed; package hooks never delete
wallets. Stop the service before removing the package.

## Arch Linux / AUR

Releases generate `aur/PKGBUILD` and `aur/.SRCINFO` for `oa-chat-bin`, with
separate verified archive hashes for `x86_64` and `aarch64`. A maintainer can
publish those files to AUR after review. To build locally, unpack the release
packaging archive, enter its `aur` directory, inspect `PKGBUILD`, and run
`makepkg -si`. Manage the installed service with the same systemd user commands.
The repository does not claim an AUR package already exists.

The binary package declares OpenSSL 3 and glibc 2.39 runtime requirements and
disables stripping so makepkg retains the reviewed executable payloads.
The generated `.SRCINFO` is checked against both `PKGBUILD` and native
`makepkg --printsrcinfo` before a draft release is created.

## Nix / NixOS

Release assembly generates `nix/package.nix` from the same four native archive
URLs and SHA-256 hashes. It includes a locked flake, overlay, NixOS user-service
module, and Linux Home Manager user-service module. The standalone
`oa-chat-nix.tar.gz` flake and combined packaging archive contain the complete
Nix sources. Nixpkgs and Home Manager inputs are pinned in `flake.lock`.

For the `0.3.2` release, select its exact version:

```sh
release_version=0.3.2
oa_flake="https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v${release_version}/oa-chat-nix.tar.gz"
nix profile install "$oa_flake"
oa-chat start
```

The published `daemon-v0.1.0` predates this packaging and has no Nix flake asset.
Do not use the template directory in the source checkout as an installable
flake; its archive hashes are filled only during release assembly.
Linux binaries are patched to Nix's ELF interpreter and OpenSSL/libgcc paths.
The daemon wrapper supplies the bundled companion on PATH and Nix CA
certificates; the companion stays unwrapped so its symlink-resolved proof path
remains `../share/oa-chat/proof-setup`. Nix installs public binaries/assets only.
Configuration, local API/management tokens, tickets, and wallets stay in the
user's private runtime directory, outside the Nix store.

For a NixOS flake configuration, add the exact release URL as an `oa-chat`
input, then import its module:

```nix
imports = [ inputs.oa-chat.nixosModules.default ];
services.oa-chat = {
  enable = true;
  users = [ "alice" ]; # Select existing non-root login users explicitly.
  startAtLogin = false;
};
```

For Home Manager on Linux, import `inputs.oa-chat.homeManagerModules.default`
and enable `services.oa-chat`; it runs as that Home Manager user. Both modules
default to manual startup, require separately initialized `config.json`, and
use `UMask=0077`. After applying NixOS configuration, run
`oa-chat --config-dir "$HOME/.config/oa-chat" init`, then
`systemctl --user start oa-chat`. Home Manager uses its configured XDG directory.
Set `startAtLogin = true` to opt into login startup. A custom `configDir` must
be an absolute runtime path (NixOS also accepts `%h/`); use the same directory
with `oa-chat --config-dir PATH init`. Never put credentials or wallet contents
in declarative Nix configuration. On macOS, the Nix package supports foreground
`oa-chat serve`; use Homebrew for managed launchd services.

## ZKAPI companion and proof assets

The daemon uses the existing ZKAPI Rust cryptographic implementation in a
separate `oa-zkapi` executable, with the daemon bridge patch applied. Release
builds pin both upstream Git commits and apply the patch maintained in
`daemon/internal/zkapi/companion.patch` and the protocol submodule patch
`daemon/internal/zkapi/protocol-transport.patch` before compiling with Cargo's lockfile.
The Go API daemon owns incoming API requests and streaming responses.

The companion and `share/oa-chat/proof-setup` are included in every native
archive. Linux packages install them as `/usr/bin/oa-zkapi` and
`/usr/share/oa-chat/proof-setup`. Homebrew installs them under its formula
prefix. One `init` configures both modes; `serve --backend ticket|zkapi` selects
the running backend. Funding is command-line only. The Go daemon generates
its own local signing key; no external wallet is required. `fund --amount ETH`
or `fund --usd USD` prepares a deposit quote. `withdraw --to ADDRESS` prepares
a quote for the full private balance after reserving it in the companion.
`fund return --to ADDRESS [--amount ETH]` quotes a return of unused public ETH.
These explicit commands sign only after the corresponding `--approve QUOTE_ID`;
`--resume` recovers saved signed bytes without granting new authority. Guided
`start` also supports deposits: after confirming a fixed principal and fee
ceiling, it refreshes quotes and authorizes that same deposit automatically
when funds arrive. Withdrawals and public returns retain explicit approvals.
The companion must advertise `bridge_version: 3` for model-selected budgets
and `withdrawal_bridge_version: 1`; ship both binaries together. `serve`, address
checks, and quote preparation never broadcast a transaction. Version
`0.2.0` introduced the explicit terminal quote flow; `0.3.0` adds guided
startup and bounded automatic deposits. The historical `0.1.0` release used
MetaMask.
Advanced `init` defaults to Ethereum mainnet. Guided `start` asks for the
network on first use with Mainnet as the default; use `--network sepolia`
to select test ETH explicitly. Existing configurations retain their network.

## Building a release

Use a clean, reviewed checkout and a fresh companion directory. Run these
commands from the repository root:

```sh
daemon/scripts/prepare-zkapi.sh /tmp/oa-zkapi-source
release_version=MAJOR.MINOR.PATCH # Select a new, unused daemon release version.
daemon/scripts/build-native.sh "$release_version" /tmp/oa-chat-release /tmp/oa-zkapi-source
```

Run the native build on each of Linux/macOS and AMD64/ARM64, collect all four
archives in one directory, then generate the pinned installer and installable
manifests:

```sh
python3 daemon/scripts/assemble-release.py "$release_version" /tmp/oa-chat-release
python3 daemon/scripts/test-packages.py --artifacts /tmp/oa-chat-release
```

The build requires Go matching `daemon/go.mod`, Rust/Cargo, Python 3,
`pkg-config`, C/C++ build tools, OpenSSL headers, and CMake. Linux packaging
uses nFPM pinned to `v2.47.0`. The native build verifies both source revisions
and both complete source diffs against their maintained patches; unexpected
source edits or missing proof keys fail the build. Preparation applies both
patches to the index and working tree with `git apply --index`; this preserves
unchanged tracked files on Ubuntu 24.04's Git 2.43 as well as tracking the
patch-added withdrawal source. Exact-source verification still compares the
complete working tree with the pinned revisions and maintained patches.
Archive order, timestamps, ownership, and gzip
headers are normalized; `SOURCE_DATE_EPOCH` sets the archive timestamp. Cargo
and Go toolchain versions, source commits, dirty-source status, and patch hashes
are recorded in `share/oa-chat/build-info.json`. Dependency license declarations
and available notice/license texts are retained under
`share/oa-chat/third-party`. No script invents a release version or checksum, uploads a tap,
submits an AUR package, or publishes a release.

The [release workflow](../../.github/workflows/oa-daemon-release.yml) builds a four-platform matrix from a
`daemon-vMAJOR.MINOR.PATCH` tag and creates a **draft** GitHub release. It
attaches the generated `install.sh` alongside native archives, Linux packages,
packaging metadata, and `SHA256SUMS`. The installer and formula URLs point to
that exact tag. Publish the reviewed release before installing its generated
installer or Homebrew/AUR manifests. The first release was published as a
GitHub prerelease at `daemon-v0.1.0`; its exact-tag installer URL is available.
Only a stable daemon release marked as latest enables the optional
`latest/download` command.

The workflow can also be dispatched with an explicit version to build and
validate artifacts without creating a release. Tag-triggered runs create a
draft only after native piped install/reinstall checks, generated-manifest and
package-payload checks, native Homebrew checks, a native Arch makepkg build,
and Nix package/module checks pass. Local native checks are available as:

```sh
python3 daemon/scripts/test-native-install.py /tmp/oa-chat-release/oa-chat_VERSION_OS_ARCH.tar.gz
python3 daemon/scripts/test-packages.py --artifacts /tmp/oa-chat-release --homebrew
python3 daemon/scripts/test-packages.py --artifacts /tmp/oa-chat-release --homebrew-install
python3 daemon/scripts/test-packages.py --artifacts /tmp/oa-chat-release --makepkg
python3 daemon/scripts/test-nix.py /tmp/oa-chat-release
```

Use the archive's native host for executable checks. The Homebrew checks
refuse an existing `oa-chat` installation and use a temporary local tap and
private configuration. `--homebrew` checks the actual user-service lifecycle;
`--homebrew-install` checks Linux installation/linkage and foreground startup
without requiring a user systemd manager. `--makepkg` requires a non-root Arch
builder and compares the packaged binaries/assets with the native archive.
Nix checks use checksum-verified local archives so draft-release URLs are not
required. These checks never import tickets or fund a wallet.

When a test-harness incompatibility blocks otherwise successful native builds
and assembly, the read-only [package revalidation workflow](../../.github/workflows/oa-daemon-package-check.yml)
can check the original artifacts with the corrected harness. Dispatch it with
the completed release run ID and its existing `daemon-vMAJOR.MINOR.PATCH` tag.
It verifies the source workflow, tag commit, all four successful native jobs,
and assembly, then checks every downloaded checksum and each native bundle's
clean source commit before repeating the complete package matrix. It does not
rebuild, retag, or publish anything. After all checks pass, a maintainer can
create and publish the release with those original assembled assets. Keep
both run URLs in the release evidence. Nix 2.35 requires `nix flake archive`
before external tools read a source path returned by lazy flake metadata.

After reviewing the successful build, publish the GitHub draft so all pinned
download URLs become available. Copy `homebrew/oa-chat.rb` to `Formula/oa-chat.rb`
in the intended Homebrew tap, and copy `aur/PKGBUILD` plus `aur/.SRCINFO` to the
`oa-chat-bin` AUR repository. Publish those repositories separately; release
CI never pushes them. The standalone Nix flake is installable directly from
the published GitHub asset; a Nixpkgs submission is a separate optional step.
Stop running services before upgrades and restart them afterward; keep the
existing private configuration directory. Do not reuse or replace the
published `daemon-v0.1.0` tag/assets to distribute newer source changes.

Run `python3 daemon/scripts/test-install.py` for deterministic installer tests
against local release fixtures. The installer workflow runs these checks on
Linux and macOS; the release workflow also runs them before building native
artifacts. These fixture checks do not publish releases or exercise funded
inference.

## Open WebUI

Open WebUI accepts OpenAI-compatible base URLs in its Admin Settings →
Connections screen. Set the URL to `http://127.0.0.1:8787/v1` and provide the
daemon's local API token. Keep Open WebUI's own authentication enabled for
shared deployments. The daemon forwards each upstream streaming chunk when
it arrives; it does not wait for the completion to finish.

For Docker, `127.0.0.1` inside a container addresses that container, so a
normal bridged container cannot reach a loopback-only host daemon. On Linux,
use host networking or run both services in the same container network
namespace. On macOS, a native Python Open WebUI install can use host loopback;
a Docker deployment needs a shared network namespace or a deliberate tunnel
that terminates on loopback. The daemon does not provide a private-network
listener option.

References: [Open WebUI quick start](https://docs.openwebui.com/getting-started/quick-start/),
[Open WebUI environment settings](https://docs.openwebui.com/reference/env-configuration/),
[Homebrew service configuration](https://docs.brew.sh/Formula-Cookbook#service-files),
and [nFPM configuration](https://nfpm.goreleaser.com/docs/configuration/).

## Published 0.3.1 prompt-cancellation validation (2026-09-29)

[daemon-v0.3.1](https://github.com/OpenAnonymity/oa-chat/releases/tag/daemon-v0.3.1)
was published from `dba6cefd8fd60e235c0a9fc0283d1f05ab491778`, the latest
main when tagged.
All ten [release jobs](https://github.com/OpenAnonymity/oa-chat/actions/runs/36629581649)
passed, including native builds and Nix/package service checks on all four
platforms. All 12 uploaded assets match the independently verified assembled
artifact. The 0.3.0 tag and assets were preserved.

The public HTTPS one-command installer upgraded 0.3.0 to 0.3.1 and entered
setup with the matching companion despite an older global binary on PATH.
Existing configuration bytes and private permissions were unchanged; the prior
bundle remained executable. The saved unsigned amount returned with fresh
consent required. Ctrl+C at that prompt stopped setup without another keystroke
or a signed transaction. The outer interrupted shell pipeline returned a
nonzero status; direct CLI cancellation tests returned zero.

Real terminal regressions cover Ctrl+C with empty or partially typed input,
explicit yes/no, EOF, rejection of piped consent, and bounded idle retries.
The original macOS ARM64 CI binary also canceled the live funding confirmation
prompt without another keystroke, stopped its owned services, and preserved the
unsigned intent. The full Go race suite and vet passed, followed by independent
adversarial review.

The same CI bundle reused the funded Sepolia profile, reached ready without
another deposit, and streamed a new request with HTTP 200 and `[DONE]`. The
recently-attested verifier-outage policy was exercised again. Automatic signed
settlement charged 4 gwei; attached guided setup waited for settlement and then
reported ready while leaving the original daemon running. The companion binary
is byte-identical to 0.3.0, whose deposit validation is recorded below. Setup
itself sent no test prompt. Test daemons were stopped and recovery state retained
in private backups. See the [sanitized patch release record](../packaging/validation/daemon-0.3.1-release-20260929.json).

## Published 0.3.0 guided-setup validation (2026-09-29)

[daemon-v0.3.0](https://github.com/OpenAnonymity/oa-chat/releases/tag/daemon-v0.3.0)
was published with 12 verified assets from main commit
`081f1b49e70bea28f3f9e2a6be9aeaeeab9acae6`. All ten jobs in the
[release workflow](https://github.com/OpenAnonymity/oa-chat/actions/runs/36593398164)
passed: four native builds, assembly, four platform package checks, and draft
creation. All uploaded sizes and digests match the original assembled artifact.

The public HTTPS installer upgraded 0.2.0 to 0.3.0 on macOS ARM64, preserved
private configuration bytes and permissions and the prior bundle, and entered
guided Sepolia setup. Its matching companion took precedence over an older
global installation. The live guide displayed a funding address, required
consent, prompted again for increased fees, and stopped without signing when
that increase was declined. Restarting retained the unsigned principal and
asked for consent again. The final macOS cancellation check exposed a terminal
read that needed Enter after Ctrl+C at a prompt; the follow-up patch fixes it.

A dedicated funded Sepolia profile deposited 743,028 gwei through the guided
flow. Restarting with the original CI binary pair resumed the identical signed
transaction and reached ready after finality. One explicit streamed request
returned HTTP 200 and `[DONE]`, exercised the recently-attested verifier-outage
policy, and automatically settled for 9 gwei. An attached `start` waited for
settlement, reported ready, and left the original daemon running. Test processes
were then stopped and private recovery state was backed up. Setup itself sent
no inference request. See the [sanitized validation record](../packaging/validation/daemon-0.3.0-release-20260929.json).

## Published 0.2.0 prerelease validation (2026-09-29)

[daemon-v0.2.0](https://github.com/OpenAnonymity/oa-chat/releases/tag/daemon-v0.2.0)
was published at 14:58 UTC with 12 assets from main commit
`ef888242c36860ccf8ec176b2b1eb724cee77456`. The [native build and assembly](https://github.com/OpenAnonymity/oa-chat/actions/runs/36582999421)
passed on all four targets. Its package stage exposed the Nix 2.35 lazy-source
test assumption described above; [corrected package revalidation](https://github.com/OpenAnonymity/oa-chat/actions/runs/36585685844)
passed every original Nix/Homebrew/Arch check against the same immutable
artifacts. All 12 uploaded asset digests match the assembled files.

The public exact-tag `curl | bash` command upgraded a real 0.1.0 macOS ARM64
installation to 0.2.0 and reinstalled 0.2.0. It preserved private configuration
bytes and permissions, all prior bundles, and the complete binary/proof pair.
A fresh profile started the packaged Sepolia companion without custom binary
or proof paths, returned 393 models with automatic budgets, enforced local
authentication boundaries, and prepared a live $2 deposit quote. It stopped
cleanly. This release check did not send funds or approve a transaction; the
funded acceptance earlier on September 29 covered the unchanged daemon runtime
and companion patches. See the [sanitized release record](../packaging/validation/daemon-0.2.0-release-20260929.json)
and [installation-to-inference walkthrough](CLI_ZKAPI.md#sepolia-from-installation-to-inference).

## Distribution preparation validation (2026-09-28)

- All 21 installer regressions passed on macOS (Bash 3.2/BSD tools) and
  Ubuntu 24.04 x86_64 (Bash/GNU tools). All 11 package-generation/handoff
  regressions and the offline companion-preparation regression passed.
  Bash syntax, ShellCheck, workflow actionlint, the Go race suite, `go vet`,
  and diff checks passed. Fresh adversarial review approved the final diff.
- Fresh pinned companion preparation exposed and fixed the patch-added
  withdrawal source tracking issue. Current source then built a real macOS
  ARM64 bundle with both binaries and proof assets. Its validation-only
  version `0.0.0` passed piped installation/reinstallation with a prefix
  containing spaces and retained complete metadata without modifying private
  state. A temporary Homebrew tap passed installation, expanded formula tests,
  isolated user-service health, shutdown, and cleanup on that current bundle.
- Real published Linux AMD64 `0.1.0` archives were used to test the new package
  mechanics separately from current-source builds. Native Arch makepkg passed
  metadata parity, exact executable/proof/notice preservation, both executable
  checks, and static systemd unit verification. Linux Homebrew on Ubuntu 24.04
  passed install, formula tests, library-linkage checks, isolated foreground
  health, and shutdown. Nix built/executed on x86_64 Linux with ELF interpreter
  and library patching, checked all four archive URLs/hashes and standalone
  flake contents, and evaluated real NixOS/Home Manager modules and private
  state restrictions. Package smoke checks did not create wallet state.

These checks prepare the source and release workflow for publication; they do
not publish a release, tap, or AUR package. The complete new four-platform CI
matrix must pass for the selected version before its draft is publishable.
At that preparation checkpoint, current-source Linux builds and Linux
user-service boot had not been rerun. The supplemental Docker trials below
cover those paths on Linux AMD64. Native macOS/ARM64 Linux builds and funded
inference still require separate checks. The historical `0.1.0` Linux checks
certify packaging mechanics only.

## Rockypika Docker package trials (2026-09-28)

Fresh Linux AMD64 binaries from daemon source `d22c80d`, with the reviewed
Git 2.43 preparation fix, were built in Ubuntu 24.04 with Go 1.26.1 and
Rust 1.97.1. Exact pinned companion/protocol patch verification passed before
and after compilation, as did the Linux Go race suite. The test version was
`0.0.0`; nothing was published. See the [sanitized trial record](../packaging/validation/rockypika-packages-20260928.json).

- Arch: native makepkg and `.SRCINFO` parity, exact binary/proof/notice
  preservation, real pacman installation (713 files, zero alterations), and
  the original systemd user unit passed. The service ran as UID 1000 with its
  declared hardening, returned health, required API authentication, and stopped
  cleanly. Reinstallation and removal preserved private state; restart after
  reinstallation passed. The official Docker image's documentation exclusion
  was removed inside the disposable container for the full integrity check.
- Homebrew on Ubuntu 24.04: actual formula installation, expanded `brew test`,
  OpenSSL linkage, foreground startup/shutdown, and real Homebrew systemd
  user-service startup/shutdown passed. Private configuration modes passed.
  Actual `brew reinstall` state preservation was not exercised.
- Nix: the locked generated flake passed native autoPatchelf build, both
  executable/proof checks, and real NixOS/Home Manager module evaluation.
  Non-root profile installation, a same-release generation refresh, removal
  with private-state preservation, and foreground startup/shutdown passed.
  Unmodified module-generated units also passed in a minimal systemd container:
  skipped before initialization, accepted spaced private paths, enforced the
  NixOS user allowlist, applied hardening/private modes, and stopped cleanly.
  Home Manager login enable/disable passed. This validates the generated user
  services; it is not a full NixOS distribution boot.
- One-command installer: real native piped install/reinstall passed. A second
  trial used real curl over HTTPS to a local TLS test server with test-only
  connection routing and a private test CA. It retained private configuration,
  checked the installed executables/assets, passed health and unauthenticated
  API rejection, and shut down cleanly. Published GitHub download availability
  was not part of this local transport test.
- All four installation routes found their bundled companion/proving setup
  without binary/setup overrides, started an unfunded Sepolia companion,
  preserved private permissions, and stopped the daemon and companion together.
  There were no funding, withdrawal, or inference calls.

Only Linux AMD64 was executed. The four-slot assembly included explicitly
non-executable metadata fixtures for Darwin AMD64/Linux ARM64 and a cached real
Darwin ARM64 archive; their URL/hash checks do not provide native runtime
coverage. The complete native release matrix must still pass before publication.
Systemd containers used private cgroup namespaces and no host filesystem mounts
or published ports; all trial containers and derived images were removed.

## Published prerelease validation (2026-09-22)

[`daemon-v0.1.0`](https://github.com/OpenAnonymity/oa-chat/releases/tag/daemon-v0.1.0)
was published at 14:41 UTC as a prerelease with 11 assets. The
[native release run](https://github.com/OpenAnonymity/oa-chat/actions/runs/35740027874)
passed Go tests, installer tests, native builds, and executable smoke checks
on macOS and Linux for both AMD64 and ARM64, followed by release assembly.

- GitHub's SHA-256 digests for the installer, archives, and packages matched
  `SHA256SUMS`. Both macOS companions linked only system libraries; Linux
  companion linkage matched the declared OpenSSL 3, libgcc, and glibc dependencies.
- The public installer URL passed on macOS ARM64 using an isolated custom
  prefix containing spaces. `oa-chat version` reported `0.1.0`, the companion's
  help command worked, and all five proof assets were present under the
  expected resolved symlink layout.
- The documented public `curl | bash` command passed twice with `pipefail` as
  an unprivileged user in a clean Ubuntu 24.04 ARM64 container, using the
  default `~/.local` prefix. Version, companion help, and all five proof
  assets passed. Reinstallation switched `current` to a new complete release
  and retained the previous release. No daemon configuration or stale install
  lock remained; the disposable container and image were removed afterward.

These checks validate public download and installation. They do not fund a
wallet, perform inference, or validate service startup; the separate records
below cover earlier application and service checks.

## Installer validation (2026-09-21)

All 18 installer tests passed on macOS with system Bash 3.2/BSD tools and on
Linux with Bash 5/GNU tools in a disposable, network-disabled ARM64 container.
The fixtures cover all four platform selections, actual release assembly,
checksum/archive failures, runtime rejection, upgrades, launcher conflicts,
state preservation, failed activation, and interruption after activation.
Bash syntax and ShellCheck passed. A fresh adversarial review approved the
final implementation after fixes to interrupted/failed-install cleanup.
These September 21 checks used fixture executables; native release binaries
and public download URLs were validated separately on September 22 above.

## Validation record (2026-09-10)

Both deterministic integration checks and live staging inference were run.
The [fixture timing record](../packaging/validation/openwebui-fixture.json)
and [fixture screenshot](images/cli-openwebui-stream.png) cover controlled
streaming and error cases; the separate live records below cover real tickets
and inference.

- Open WebUI **0.11.3**, image digest
  `sha256:7b9979b1c481b1562c1abe85af350e1cfd23c7737b0705bf4dbf0d2325168c75`,
  was installed in an isolated Docker container on the configured Office Mac
  Docker context. The browser reached it through a loopback SSH forward.
- The real daemon HTTP server was linked to the deterministic backend in
  `daemon/scripts/e2e-fixture`. The Open WebUI browser selected
  `oa-e2e-streaming`, submitted a prompt, and displayed incremental words while
  its Stop control was active. A DOM observer recorded the initial two-word
  fragment at 0.893 seconds, successive updates about 450 ms apart, the full
  text at 6.343 seconds, and completion at 6.814 seconds. These include browser
  and test-driver timing; they are **not** production model-latency claims.
- Open WebUI's nonstream API returned HTTP 200 with the assistant role and
  expected text; an unknown model returned HTTP 404. No uncaught browser
  errors were observed.
- Live staging model discovery returned 382 models. A real ticket-backed
  `openai/gpt-4.1-mini` request produced 114 content SSE events, with first
  content at 3.329 seconds and `[DONE]` at 4.183 seconds. The
  [direct streaming record](../packaging/validation/staging-direct-stream.json)
  contains the sanitized measurements. Organization, verifier, and inference
  requests used the temporary encrypted Wisp relay, without direct fallback.
- Open WebUI was then connected to that running staging daemon. Two real
  browser requests succeeded; the measured request showed 38 visible content
  updates, first text at 3.329 seconds, final content at 6.006 seconds, and
  completion at 6.095 seconds. The Stop control remained active during the
  updates. See the [browser timing record](../packaging/validation/openwebui-staging-stream.json),
  [in-progress screenshot](images/cli-openwebui-staging-streaming.png), and
  [completed response](images/cli-openwebui-staging.png). No uncaught browser
  errors were observed. The three live requests consumed three tickets;
  these observed test timings are not a production latency guarantee.
- Packaging smoke checks generated all four archive manifests, Homebrew and
  AUR hashes, and real `.deb`/`.rpm` packages using fixture executables. The
  Debian payload was inspected for binaries, the user service, and all proof
  setup files. Ruby/shell syntax checks passed. These checks establish package
  structure, not successful native installation on every supported OS.
- A real macOS ARM64 bundle was then built with both executables and proof
  data. A temporary local Homebrew tap installed it, `brew test` verified the
  version, and `brew services start` launched it using an isolated config on
  port 38878. The health endpoint responded successfully and Homebrew reported
  the service running; `brew services stop` terminated it successfully. The
  temporary package and tap were removed after verification. Fresh pinned
  companion source checkout, recursive submodules, and bridge patch application
  were also exercised successfully.
- A [Sepolia funding screenshot](images/cli-sepolia-funding.png) captures the
  real local funding page after its one-time capability was removed from the
  URL. A September 10 follow-up progressed through wallet connection to the
  exact 0.100000 test-USDC allowance prompt. A user-reported submission
  was rejected before broadcast for a 21-million-gas limit; the rebuilt daemon
  now includes the web SDK's explicit gas estimation and cap. The later
  allowance, demo mint, deposit, and private-note activation succeeded. The
  receipt validator was corrected to accept the wallet's transaction wrapper
  while requiring the matching vault event. See the [funding record](../packaging/validation/sepolia-gas-preflight.json).
- Funded Sepolia inference passed in Open WebUI: first content at 13.815
  seconds, eight partial content frames, and completion at 15.277 seconds.
  The lease settled automatically with a 0.000723 USDC charge and a remaining
  private balance of 0.099277 USDC. A fresh independent API request after
  settlement returned HTTP 200, 100 content events, and `[DONE]`; first content
  arrived at 7.081 seconds and completion at 7.843 seconds. See the
  [browser/settlement record](../packaging/validation/openwebui-sepolia-stream.json)
  and [direct SSE record](../packaging/validation/sepolia-direct-stream.json).
  The second lease also finalized automatically with a 0.000065-USDC charge,
  leaving 0.099212 USDC and no pending request.
  This uses the public Sepolia ZKAPI deployment; its manifest does not identify
  whether the OA-org issuer is staging.
- The release source validator accepted both exact pinned source repositories
  plus their maintained patches and rejected an additional unrelated source
  edit in each repository independently. A final native
  archive inspection found all five required proof assets, both pinned source
  revisions and both patch hashes in provenance, and preserved license declarations/notices for 256
  resolved build dependencies. This packaging check is separate from later application
  behavior fixes and the earlier Homebrew service lifecycle check. The native
  macOS ARM64 bundle was rebuilt after the final receipt and expiry fixes:
  `oa-chat_0.1.0_darwin_arm64.tar.gz`, SHA-256
  `43701072ee071acb39290f917fb66bed2dc38e6387cd144ece9dba790e6d09fd`.

The isolated Open WebUI installation is retained **running** in the
`oa-chat-e2e-webui` container on Docker context `officemac`, with its named
data volume. Open `http://127.0.0.1:33080` to inspect the live staging and
Sepolia chats. It uses `http://host.docker.internal:18762/v1` for tickets and
`http://host.docker.internal:18763/v1` for Sepolia through reverse SSH forwards
to the local daemons. Their bearer credentials were configured
privately and is not included in these records. This disposable UI has
authentication disabled and is exposed only through loopback bindings;
enable Open WebUI authentication before using a shared deployment.

For this retained test installation, the detached SSH control socket is
`/tmp/oa-cli-live-webui-20260909.sock`. If the tunnel has stopped, restore both
directions with:

```sh
docker --context officemac start oa-chat-e2e-webui
ssh -fNM -S /tmp/oa-cli-live-webui-20260909.sock \
  -L 127.0.0.1:33080:127.0.0.1:33080 \
  -R 127.0.0.1:18762:127.0.0.1:18762 \
  -R 127.0.0.1:18763:127.0.0.1:18763 \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 officemac
```

The temporary staging daemon is managed by the local launchd label
`ai.openanonymity.cli-staging-e2e-20260909`, using
`/tmp/oa-cli-staging-20260909-state` and listening on `127.0.0.1:18762`.
Its relay forward is retained separately at
`/tmp/oa-cli-live-relay-20260909.sock`; both staging ticketing and the
Sepolia test rely on that temporary relay. The Sepolia daemon runs under
`ai.openanonymity.cli-sepolia-e2e-20260910`, uses
`/tmp/oa-chat-sepolia-staging-20260909`, and listens on `127.0.0.1:18763`.
The remote relay helper has a four-hour runtime limit; these retained
development services are not permanent hosting. They are separate from the
packaged Homebrew service. Keep the private
configuration and ticket files out of published evidence. The mock fixture
process is stopped and only its owned local token files were removed.

On September 10, the retained UI gained a separate Sepolia ZKAPI connection
at `http://host.docker.internal:18763/v1`, with `oa-sepolia.` prefixed model
names to distinguish it from the existing ticket connection. Authenticated
model discovery returned eight models; unauthenticated discovery returned
HTTP 401. One unfunded browser request to
`oa-sepolia.openai/gpt-4o-mini` displayed “The private balance needs funding.
Run oa-chat fund.” Automatic title, tag, follow-up, autocomplete, and query
generation remain disabled. The [sanitized readiness record](../packaging/validation/openwebui-sepolia-unfunded.json)
covers this earlier error path. The later funded browser and direct API
tests above passed with separate keys, with automatic settlement between them.

The fixture never spends tickets or submits wallet transactions, and has no
production CLI enable switch. Live staging redemption and streaming, Sepolia
funding, proof-backed inference, and settlement passed. The deployed Sepolia
lease still prevents another independent request until expiry and settlement,
about 4½ minutes in the observed flow. For a configured daemon,
`daemon/scripts/verify-openai.py --token-file /private/token --model MODEL`
checks authentication, model discovery, nonstream responses, and incremental
SSE timing; it sends two inference requests using that environment's balance.
Use `--stream-only` for one paid request on ZKAPI and allow settlement before
repeating it. As of this September 10 validation, mainnet funding, Linux service
boot, and AUR installation were unverified, and release artifacts and package
repositories had not been published. The September 22 prerelease publication
and installer checks are recorded above.
