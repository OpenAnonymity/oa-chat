# OA Chat command-line daemon

`daemon/` is a standalone Go module exposing an OpenAI-compatible API for
Open WebUI and other server-side clients. Homebrew services/launchd and a
systemd **user** service manage its foreground process.

Supported endpoints are `GET /v1/models` and `POST /v1/chat/completions`,
including SSE streaming, tool calls, multimodal messages, structured outputs,
usage events, and reasoning fields. Responses, Assistants, embeddings,
file-storage, and image-generation endpoints are not implemented.

## Install with one command

Install the native binaries and proving assets from the published
[`daemon-v0.1.0` prerelease](https://github.com/OpenAnonymity/oa-chat/releases/tag/daemon-v0.1.0):

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.1.0/install.sh | bash
```

This installs `oa-chat` and `oa-zkapi` under `~/.local/bin` on macOS 13+ or
Linux with glibc 2.39+, for AMD64 or ARM64. Follow the installer's PATH guidance
if that directory is not on your PATH. Linux also requires OpenSSL 3, libgcc,
and CA certificates. The installer checks the archive's SHA-256 checksum and
both executables before activating the installation. Run it as your normal
user; it does not need `sudo`, change your shell configuration, or start a
service.

Then initialize the daemon and import/redeem tickets before starting it:

```sh
oa-chat init
oa-chat tickets redeem
oa-chat serve
```

For zkAPI access, use the [funding setup](#zkapi-and-funding) instead.
[Installer options and upgrades](CLI_PACKAGING.md#one-command-installation)
cover version pinning and custom installation directories.

The exact-tag installer URL works for stable releases and GitHub prereleases.
GitHub's `latest/download` URL excludes prereleases, so use the command above
for this preview. Public installation passed on macOS ARM64 and Ubuntu 24.04
ARM64; see the [release validation record](CLI_PACKAGING.md#published-prerelease-validation-2026-09-22).
A Homebrew tap and an AUR package have not yet been published.

## Build and run ticket mode

```sh
cd daemon
go build -o oa-chat ./cmd/oa-chat
./oa-chat init
./oa-chat tickets redeem --code-file /path/to/private-invite.txt
# Alternatively:
./oa-chat tickets import /path/to/tickets.json
./oa-chat serve
```

Imports also work while the service runs. `tickets redeem` without a file
reads an invitation code or OA ticket-share URL from stdin. No account sign-in
is required. See [ticket protocol and recovery](CLI_TICKETS.md).

Configuration defaults to `~/Library/Application Support/oa-chat` on macOS
and `~/.config/oa-chat` on Linux, respecting `XDG_CONFIG_HOME`.
`OA_CHAT_CONFIG_DIR` or global `--config-dir DIR` selects another directory.
The directory must be `0700`; `config.json` is `0600`. `init` never overwrites
existing configuration. Use separate directories for staging and production.

`oa-chat status` shows service and wallet readiness. `oa-chat api-key`
explicitly prints the random **local** API key for configuring your client.
It is not an inference-provider key. Keep keys, ticket codes, wallet files,
and funding capability URLs out of public logs and bug reports.

## Connect Open WebUI

Add an OpenAI-compatible connection in **Admin Panel → Settings → Connections**:

| Setting | Value |
| --- | --- |
| API base URL | `http://127.0.0.1:8787/v1` |
| API key | Output of `oa-chat api-key` |
| Model | Select from the daemon's model list |

The endpoint must be reachable from the **Open WebUI backend process**.
The daemon binds only to numeric loopback addresses. Container loopback and
host loopback differ: use a shared container network namespace, Linux host
networking, or an SSH tunnel. Do not expose the daemon on `0.0.0.0` to work
around this. The integration test ran both processes in the same container
namespace on a separate Docker host, with only the UI forwarded locally.

Automatic titles, tags, and follow-up suggestions cause extra API requests,
each consuming separate anonymous access. Disable these tasks for one paid
request per send, and with zkAPI servers awaiting lease settlement.
Browser JavaScript connects through its UI backend; the daemon's inference
API rejects browser Origins and does not enable arbitrary CORS access.

## zkAPI and funding

The API daemon is Go. The existing Rust zkAPI wallet/prover is packaged as
`oa-zkapi`, with real circuit setup assets and an authenticated lease bridge.
Go supervises the companion and owns inference streaming. Neither prompts
nor responses enter the proof companion.

Build it with `daemon/scripts/prepare-zkapi.sh` followed by
`daemon/scripts/build-native.sh`; see [packaging](CLI_PACKAGING.md).
Installed native bundles include both binaries and proving assets.

```sh
oa-chat init --backend zkapi
oa-chat serve
# In another terminal:
oa-chat fund
```

`fund` prints a persistent Ethereum address and its public USDC/ETH balances.
Send USDC and ETH for gas to that address on the displayed network, then run:

```sh
oa-chat fund --amount 0.10
```

Choose the amount of USDC to turn into private inference credits. This command
waits for incoming funds, signs the approval and vault deposit locally, and
waits for the confirmed deposit to activate. Ctrl+C stops waiting; rerunning
the same command resumes the saved transaction. Keep the same `--config-dir`
when using a nondefault directory. Starting the service or running plain
`fund` never submits a transaction.

No browser extension, wallet connection, seed phrase, or imported private key
is required. The daemon creates a signing key and keeps it in its owner-only
configuration directory. Back up the entire directory, including `funding/`
and `zkapi/`; that backup controls public funds and private credits.
Public address balances are not private inference credits until deposited.

`fund --browser` opens an optional local page showing the same address and
controls; `fund --no-open` prints its expiring capability URL. Reloading the
page only checks status. Its explicit deposit button authorizes local signing;
no signing key enters the page. See [funding, recovery, and limitations](CLI_ZKAPI.md).
The published `daemon-v0.1.0` binary predates this change; build this revision to
use address funding until an updated native release is published.

Ethereum mainnet is the default. Sepolia requires an explicit selection:

```sh
oa-chat --config-dir /path/to/private-sepolia-state init \
  --backend zkapi --network sepolia --listen 127.0.0.1:8788
oa-chat --config-dir /path/to/private-sepolia-state serve
oa-chat --config-dir /path/to/private-sepolia-state fund
```

The companion checks the manifest chain against the selected network, and
state is separated by network. Its HTTPS requests use an authenticated local
CONNECT proxy over Wisp; Go inference uses the same anonymous transport.
No direct fallback is allowed. The advanced `zkapi.external_companion` option
requires an operator-managed, patched companion with equivalent anonymous
transport, bridge authentication, and verification policy.

The deployed zkAPI protocol may keep one private-wallet lease outstanding
until expiry and settlement (currently up to five minutes on Sepolia). A lease
is handed to the API only once, including across restarts. Another request
returns `409 settlement_pending` until a fresh key is available, avoiding
cross-chat key reuse. See [zkAPI integration and server prerequisites](CLI_ZKAPI.md)
for the settlement limitation and the undeployed server proposal, which requires
a different billing policy and is unsuitable for the tested metered deployment.

## Services and packaging

After installing a generated release formula/package:

```sh
# Homebrew, as your normal user:
oa-chat init
brew services start oa-chat
brew services stop oa-chat

# Linux, as your normal user:
oa-chat init
systemctl --user daemon-reload
systemctl --user enable --now oa-chat.service
systemctl --user stop oa-chat.service
```

For service availability after logout, enable lingering with
`loginctl enable-linger USER`. Services do not automatically fund wallets.
SIGTERM cancels active requests and stops the supervised companion. A process
lock prevents two daemons sharing a config directory.

`.github/workflows/oa-daemon-release.yml` builds native macOS/Linux ARM64 and
AMD64 bundles, Debian/RPM packages, a version-pinned shell installer, and
checksum-pinned Homebrew/AUR metadata
for `daemon-vMAJOR.MINOR.PATCH` tags. It creates a draft GitHub release.
Publishing a tap, AUR package, or distribution repository is a separate
release action; none has been published by this implementation.

## Privacy and stream handling

- Tickets are blinded locally with CIRCL's RFC-compatible Blind RSA. Every
  request obtains a fresh provider key, activated only after explicit verifier
  approval bound to its station and the verifier's SHA-256 key identifier.
  Like the browser, the daemon accepts the deployed 16-hex identifier; it also
  accepts a matching full 64-hex digest. This check applies to the authenticated
  HTTPS response to that key's submission, never a generic broadcast result.
- Wisp resolves destination DNS and forwards encrypted TCP. TLS validation
  remains in Go/the companion. The relay sees timing and connection metadata,
  not HTTP content. Each HTTP request uses a separate destination TLS
  connection, with no persistent connection/session-cache grouping of keys.
- Client authorization, cookies, forwarding headers, request IDs, and referrers
  are never copied upstream. Top-level identity/storage fields (`user`,
  `metadata`, `safety_identifier`, `prompt_cache_key`, `store`) and arbitrary
  transport/provider overrides are removed; supported inference inputs remain.
- Prompts/responses are held only in request memory, never service logs or
  daemon storage. The connected UI and provider may retain content. The UI
  and daemon host are inside the user's trust boundary.
- Every upstream chunk is flushed immediately, including partial SSE frames.
  There is no event/token batching, compression, synthetic stream, or wait for
  a final response. Disconnects cancel inference. Provider latency and access
  preparation still contribute to the time to first token.
- Request bodies are limited to 16 MiB, concurrency defaults to four, slow
  uploads/writes are bounded, and inference has a thirty-minute lifetime.
  Arbitrary remote errors and credential-bearing URLs remain redacted.

## Validation and remaining checks (2026-09-10)

Passed: Go race tests and `go vet`; browser/Go Blind RSA interoperability;
durable ticket/replay behavior; strict verifier mismatch rejection; TLS/Wisp
flow control; cancellation and immediate streaming; local authentication;
funding origin/capability and recovery fixtures.

A native macOS ARM64 bundle passed Homebrew install, version test, service
start, health response, and stop. Debian/RPM payloads were built and inspected.
Linux service boot and AUR installation were not tested.

Open WebUI 0.11.3 was installed in an isolated Docker environment. With the
real Go HTTP server and a deterministic test backend, the browser showed
incremental content at 0.893 seconds and completed at 6.814 seconds. Models,
non-streaming, auth, and error paths also passed. This verifies UI/API behavior,
separately from the following live test.

Open WebUI also passed with real staging tickets and OpenRouter inference
through the production Go daemon. Its browser rendered 38 content updates:
first content at 3.329 seconds, the full response at 6.006 seconds, and the Stop
control disappeared at 6.095 seconds. These measurements include ticket/key
preparation and browser rendering, not just model generation. See the
[live timing record](../daemon/packaging/validation/openwebui-staging-stream.json)
and [partial-response screenshot](images/cli-openwebui-staging-streaming.png).

The compiled CLI imported twelve real staging tickets through a temporary
SSH-forwarded Wisp helper on the staging host. Real keys were issued. An initial
daemon error incorrectly required a full 64-hex verifier digest; the deployed
verifier and browser intentionally use 16 hex. The corrected client retains
exact station/status and key-identifier checks, with regression tests for
wrong prefixes, arbitrary lengths, and mismatched full-digest suffixes.
The correct staging org is `https://org-staging.openanonymity.ai` (hyphenated).
The same real TLS-over-Wisp transport fetched OpenRouter's public model catalog
successfully. After correcting verifier compatibility, live staging ticket
redemption, verification, and `openai/gpt-4.1-mini` streaming passed: HTTP 200,
114 content events, first content at 3.329 seconds, and `[DONE]` at 4.183 seconds.
The timing includes access preparation. See the
[recorded stream timing](../daemon/packaging/validation/staging-direct-stream.json).
The Sepolia flow passed with real proving assets and a 0.100000 test-USDC
MetaMask deposit. The funding flow now follows the working web SDK's gas
preflight, reuses existing allowance, and mints only the permitted Sepolia demo
token shortfall. Receipt validation accepts MetaMask wrappers while requiring
the exact vault event and private-note commitment. The successful deposit was
recovered without sending another transaction. Signed key expiry validation
also now accepts the server's bounded lease safety margin, as the SDK does.

Open WebUI then completed a real proof-backed `openai/gpt-4o-mini` chat: first
visible text at 13.815 seconds, eight partial content frames, and completion
at 15.277 seconds. Settlement cleared automatically and charged 0.000723 USDC,
leaving 0.099277 USDC. See the [browser and settlement record](../daemon/packaging/validation/openwebui-sepolia-stream.json).
A fresh independent request after settlement passed HTTP 200 with 100 content
events, first content at 7.081 seconds, and `[DONE]` at 7.843 seconds. See the
[direct SSE record](../daemon/packaging/validation/sepolia-direct-stream.json).
That second lease also settled automatically, charging 0.000065 USDC and
leaving 0.099212 USDC with no pending request.
These timings include access preparation. The public Sepolia manifest does
not expose its OA-org issuer environment, so this ZKAPI test does not establish
that its issuer is staging; the ticket test above explicitly uses staging.

Additional screenshots: [Open WebUI completed live response](images/cli-openwebui-staging.png),
[streaming fixture](images/cli-openwebui-stream.png), and
[live Sepolia funding page](images/cli-sepolia-funding.png).

The default public OA relay closed before its Wisp handshake. The helper proves
the transport but does not repair that external relay. No verifier server
upgrade is required. The deployed Sepolia server still makes independent
requests wait for lease expiry and settlement (about 4½ minutes in this test).
Browser automation policy blocks extension-page interaction, so the user
confirmed MetaMask prompts directly while computer use exercised the funding
page and Open WebUI. Ethereum mainnet remains the user-facing default; no
mainnet transactions were performed in these tests.

Re-run `daemon/scripts/verify-openai.py --base-url URL/v1 --token-file PRIVATE_FILE --model MODEL`
against a funded daemon; it sends two model requests. Add `--stream-only` for
one streaming request when testing zkAPI, and wait for settlement before
running another independent request. The deterministic
`daemon/scripts/e2e-fixture` is a separate test executable. No production
configuration enables fake keys or a verifier bypass.
