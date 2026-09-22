# OA Chat daemon packaging and client integration

The Go daemon lives under `daemon/` and presents an OpenAI-compatible API at
`http://127.0.0.1:8787/v1`. It runs in the foreground; Homebrew Services or a
systemd **user** service owns its lifetime. The service runs as the same user
who imported tickets or funded the private balance.

## Local configuration

Run `oa-chat init` before starting the service. Configuration is stored in
`config.json` under Go's `os.UserConfigDir()/oa-chat`: normally
`~/.config/oa-chat` on Linux and `~/Library/Application Support/oa-chat` on
macOS. `OA_CHAT_CONFIG_DIR` or a global `--config-dir` selects a separate
configuration, for example for staging. Do not run initialization or funding
with `sudo`.

Configure your client with the daemon's local API token and the API base URL.
The local token authenticates clients to this daemon; it is not an OA ticket,
wallet secret, or provider API key. The daemon accepts only loopback listeners.
Client applications
retain their own transcripts under their own storage/privacy settings.

## One-command installation

The shell installer uses the same native release archives as Homebrew and
AUR. The first prerelease, `daemon-v0.1.0`, is pending publication. Once it is
published, users can install it with:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.1.0/install.sh | bash
```

The published script is pinned to its own release version. It downloads the
matching archive and `SHA256SUMS` over HTTPS, verifies the archive before
extracting it, and checks both binaries before activating the installation.
The supported targets are macOS 13+ and Linux with glibc 2.39+, each on AMD64
or ARM64. Linux requires OpenSSL 3, libgcc, and CA certificates; install missing
runtime libraries with the distribution's package manager. Bash, `curl`,
`tar`, and either `sha256sum` or `shasum` must be available. No compiler,
Homebrew, Python, or root access is needed to run the installer.

By default, launchers are installed in `~/.local/bin`. If needed, apply the
PATH command printed by the installer to the current shell, then run:

```sh
oa-chat init
oa-chat serve
```

Import/redeem tickets or follow the [zkAPI funding setup](CLI.md#zkapi-and-funding)
before sending inference requests. The installer does not initialize a
configuration, import tickets, fund a wallet, start a daemon/service, or edit
shell startup files.

To select another writable absolute prefix:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.1.0/install.sh | bash -s -- --prefix "$HOME/oa-tools"
```

An exact-tag URL works for either a stable release or a GitHub prerelease and
keeps the installation version pinned. Prerelease status is GitHub release
metadata; the tag and installer version remain `daemon-v0.1.0` and `0.1.0`.
GitHub's `latest/download` URL excludes prereleases and is repository-wide.
For a future stable daemon release explicitly marked as latest, this optional
command follows that stable release:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/latest/download/install.sh | bash
```

`--version MAJOR.MINOR.PATCH` can override the script's pinned version;
`--help` lists the options. The source file `daemon/install.sh` requires an
explicit `--version` because its release placeholder is filled only by
`assemble-release.py`.

Stop a running daemon before upgrading, rerun the installation command with
the same prefix, and restart the daemon afterward. An upgrade retains the
previous release directory and activates a fully checked new directory by
switching the managed `current` link. Existing configuration, tickets, and
wallet balances remain in the separate private configuration directory.
Launchers belonging to an unrelated installation are refused; use the existing
package manager for a Homebrew/package upgrade or choose another prefix.

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
The shell installer does not install the package's systemd unit, whose
`ExecStart` uses `/usr/bin/oa-chat`; use foreground `oa-chat serve` or configure
a user service with the chosen prefix and PATH.

Availability: the installer is implemented, but the first daemon prerelease
and public package repositories have not yet been published. Publishing the
reviewed `daemon-v0.1.0` prerelease with its generated `install.sh` asset enables
the exact-tag commands above; it does not enable `latest/download`. An exact
daemon-tag URL remains usable independently of other release types in this
repository.

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
prefix. Funding opens the browser so the user approves MetaMask transactions;
service startup never submits a wallet transaction. User-facing configuration
uses Ethereum mainnet; Sepolia must be selected explicitly for testing.

## Building a release

Use a clean, reviewed checkout and a fresh companion directory:

```sh
daemon/scripts/prepare-zkapi.sh /tmp/oa-zkapi-source
daemon/scripts/build-native.sh 0.1.0 /tmp/oa-chat-release /tmp/oa-zkapi-source
```

Run the native build on each of Linux/macOS and AMD64/ARM64, collect all four
archives in one directory, then generate the pinned installer and installable
manifests:

```sh
python3 daemon/scripts/assemble-release.py 0.1.0 /tmp/oa-chat-release
```

The build requires Go matching `daemon/go.mod`, Rust/Cargo, Python 3,
`pkg-config`, C/C++ build tools, OpenSSL headers, and CMake. Linux packaging
uses nFPM pinned to `v2.47.0`. The native build verifies both source revisions
and both complete source diffs against their maintained patches; unexpected
source edits or missing proof keys fail the build. Archive order, timestamps, ownership, and gzip
headers are normalized; `SOURCE_DATE_EPOCH` sets the archive timestamp. Cargo
and Go toolchain versions, source commits, dirty-source status, and patch hashes
are recorded in `share/oa-chat/build-info.json`. Dependency license declarations
and available notice/license texts are retained under
`share/oa-chat/third-party`. No script invents a release version or checksum, uploads a tap,
submits an AUR package, or publishes a release.

The [release workflow](../.github/workflows/oa-daemon-release.yml) builds a four-platform matrix from a
`daemon-vMAJOR.MINOR.PATCH` tag and creates a **draft** GitHub release. It
attaches the generated `install.sh` alongside native archives, Linux packages,
packaging metadata, and `SHA256SUMS`. The installer and formula URLs point to
that exact tag. Publish the reviewed release before installing its generated
installer or Homebrew/AUR manifests. The first release is planned as a GitHub
prerelease at `daemon-v0.1.0`; its exact-tag installer URL works once published.
Only a stable daemon release marked as latest enables the optional
`latest/download` command.

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

## Installer validation (2026-09-21)

All 18 installer tests passed on macOS with system Bash 3.2/BSD tools and on
Linux with Bash 5/GNU tools in a disposable, network-disabled ARM64 container.
The fixtures cover all four platform selections, actual release assembly,
checksum/archive failures, runtime rejection, upgrades, launcher conflicts,
state preservation, failed activation, and interruption after activation.
Bash syntax and ShellCheck passed. A fresh adversarial review approved the
final implementation after fixes to interrupted/failed-install cleanup.
These are installer and packaging checks with fixture executables; new native
release binaries and live public download URLs were not built or tested.

## Validation record (2026-09-10)

Both deterministic integration checks and live staging inference were run.
The [fixture timing record](../daemon/packaging/validation/openwebui-fixture.json)
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
  [direct streaming record](../daemon/packaging/validation/staging-direct-stream.json)
  contains the sanitized measurements. Organization, verifier, and inference
  requests used the temporary encrypted Wisp relay, without direct fallback.
- Open WebUI was then connected to that running staging daemon. Two real
  browser requests succeeded; the measured request showed 38 visible content
  updates, first text at 3.329 seconds, final content at 6.006 seconds, and
  completion at 6.095 seconds. The Stop control remained active during the
  updates. See the [browser timing record](../daemon/packaging/validation/openwebui-staging-stream.json),
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
  while requiring the matching vault event. See the [funding record](../daemon/packaging/validation/sepolia-gas-preflight.json).
- Funded Sepolia inference passed in Open WebUI: first content at 13.815
  seconds, eight partial content frames, and completion at 15.277 seconds.
  The lease settled automatically with a 0.000723 USDC charge and a remaining
  private balance of 0.099277 USDC. A fresh independent API request after
  settlement returned HTTP 200, 100 content events, and `[DONE]`; first content
  arrived at 7.081 seconds and completion at 7.843 seconds. See the
  [browser/settlement record](../daemon/packaging/validation/openwebui-sepolia-stream.json)
  and [direct SSE record](../daemon/packaging/validation/sepolia-direct-stream.json).
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
generation remain disabled. The [sanitized readiness record](../daemon/packaging/validation/openwebui-sepolia-unfunded.json)
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
repeating it. Mainnet funding, Linux service boot, and AUR installation remain
unverified; release artifacts and package repositories have not been published.
