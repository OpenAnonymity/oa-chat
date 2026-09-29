# OA Chat command-line daemon

`daemon/` is a standalone Go module exposing an OpenAI-compatible API for
Open WebUI and other server-side clients. Homebrew services/launchd and a
systemd **user** service manage its foreground process.

Supported endpoints are `GET /v1/models` and `POST /v1/chat/completions`,
including SSE streaming, tool calls, multimodal messages, structured outputs,
usage events, and reasoning fields. Responses, Assistants, embeddings,
file-storage, and image-generation endpoints are not implemented.

## Install and get ready with one command

Guided setup is available in version `0.3.0`. For Sepolia test ETH:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.3.0/install.sh | bash -s -- --setup --network sepolia
```

The installer checks and installs both binaries and proving assets, then runs
`oa-chat start` directly. No separate PATH command, initialization, or funding
terminal is needed for setup. It creates configuration in the default directory
when missing, starts the local API and companion, and checks the wallet against
an available model's automatic request cap.

If funding is needed, choose the USD amount (normally $2), review the fixed ETH
principal and maximum network fee, and confirm once. Send **Sepolia test ETH**
to the displayed funding address. Setup checks automatically, deposits when
the required amount arrives, and waits for finalized activation. A higher fee
ceiling requires another confirmation. When ready, it prints the local API URL
and a command to retrieve the API key; it does not print the key automatically.
Leave the terminal running for inference and settlement.

After installation, follow the installer's PATH guidance for future terminals,
then restart or check an existing setup with:

```sh
oa-chat start --network sepolia
```

New guided configurations default to zkAPI. Existing configuration and its
saved mode are preserved; a compatible running daemon is reused. Use
`--backend zkapi` to explicitly choose zkAPI for an existing ticket profile,
or `--backend ticket` for guided ticket import/redemption. Without `--network`,
a new setup asks which network to use and offers Sepolia. An existing wallet
is never switched to another network or overwritten to repair a load error.
See the [full Sepolia walkthrough](docs/CLI_ZKAPI.md#sepolia-from-installation-to-inference)
for recovery and sending your first request.

For installation or updates only, omit the setup flags:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.3.0/install.sh | bash
```

Run as your normal user on macOS 13+ or Linux with glibc 2.39+, on AMD64 or
ARM64. Linux also needs OpenSSL 3, libgcc, and CA certificates. Binaries go in
`~/.local/bin`; no `sudo` or shell-profile changes are needed. Stop an existing
daemon before upgrading, rerun with the same prefix, and restart afterward.
Both binaries and proof assets update together while preserving configuration,
tickets, wallet state, and the previous release. Legacy ERC-20 notes are not
migrated to the native ETH deployment.

Version `0.3.0` adds this guided flow to the shared initialization, runtime mode
selection, automatic model budgets, and terminal quotes introduced in `0.2.0`.
[Installer options and upgrades](docs/CLI_PACKAGING.md#one-command-installation)
cover version pinning and custom installation directories. Exact-tag URLs
support prereleases; GitHub's `latest/download` URL excludes them. A Homebrew
tap and an AUR package have not yet been published.

## Build and run ticket mode

Run source-build commands from the repository root:

```sh
cd daemon
go build -o oa-chat ./cmd/oa-chat
./oa-chat init
./oa-chat tickets redeem --code-file /path/to/private-invite.txt
# Alternatively:
./oa-chat tickets import /path/to/tickets.json
./oa-chat serve --backend ticket
```

Imports also work while the service runs. `tickets redeem` without a file
reads an invitation code or OA ticket-share URL from stdin. No account sign-in
is required. See [ticket protocol and recovery](docs/CLI_TICKETS.md).

Configuration defaults to `~/Library/Application Support/oa-chat` on macOS
and `~/.config/oa-chat` on Linux, respecting `XDG_CONFIG_HOME`.
`OA_CHAT_CONFIG_DIR` or global `--config-dir DIR` selects another directory.
The directory must be `0700`; `config.json` is `0600`. `init` never overwrites
existing configuration. Use separate directories for staging and production.

One initialization configures both ticket and zkAPI modes. Stop the current
daemon, then choose `serve --backend ticket` or `serve --backend zkapi` using
the same directory. `init --backend` sets the saved default used when `serve`
omits the flag; it does not disable the other mode. Existing configurations
need no reinitialization. The local API key and transport settings are shared;
tickets and private notes remain separate. Ticket mode does not start or require
the Rust companion. Ticket import and redemption work in either mode.

The external network proxy is disabled by default: an empty or omitted `relay_url` uses
direct HTTPS, including ticketing, verification, inference, companion requests,
and funding RPC. Environment proxy variables are ignored. Destination services
can see your source IP, and destination DNS uses your local resolver.
To opt in to the encrypted Wisp relay when initializing a new configuration:

```sh
oa-chat init --relay-url wss://YOUR_WISP_RELAY/
```

Replace the example URL with your Wisp relay URL. For an existing configuration,
set `relay_url` in `config.json` to the desired Wisp URL, or to `""` to disable
the proxy, then restart the daemon. Existing
nonempty relay settings stay enabled after upgrading. Wisp resolves destination
DNS and hides your source IP from destination services; it still sees connection
metadata. A configured relay fails closed without falling back to direct HTTPS.
Version `0.2.0` defaults new configurations to direct HTTPS; upgrading preserves
an existing relay setting.

`oa-chat status` shows the authenticated running mode, saved default, and wallet
readiness. `oa-chat api-key`
explicitly prints the random **local** API key for configuring your client.
It is not an inference-provider key. Keep keys, ticket codes, wallet files,
and recovery files out of public logs and bug reports.

### Foreground status and logs

`oa-chat serve` writes timestamped status and operational logs to standard
output. It shows the API address, backend, transport mode, and startup/shutdown
events. It checks wallet readiness immediately and every five seconds, printing
only changes: available ticket count, or zkAPI companion readiness, whether a
private balance is loaded, and whether settlement is pending. These checks do
not acquire inference access or spend funds; they do not establish upstream
availability or guarantee that a balance covers a request.

Requests produce start and completion lines with an allowlisted method/route,
HTTP status, elapsed time, and an aborted indication for interrupted requests.
Health probes are silent. Streaming output continues to flush immediately.
Prompts, responses, headers, model names, query strings, wallet
secrets, and raw companion/HTTP diagnostics are excluded. Command failures
still return a nonzero exit status with a diagnostic on stderr.

For example, `oa-chat serve > oa-chat.log` captures operational output. The
daemon does not create log files itself; shell redirection or your service
manager can retain this activity metadata. Homebrew services use their
configured log file and systemd captures stdout in the journal.

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

Version `0.2.0` bundles both matching binaries and proving assets; no source
build is needed. The September 29 implementation passed a funded native ETH
Sepolia run through quoted deposit approval, automatic model budgets, streamed
inference, verifier-outage continuation, metered settlement, finalized withdrawal,
and restart recovery. See the [terminal-flow validation](docs/CLI_ZKAPI.md#terminal-quote-validation-2026-09-29).
For source builds, use `daemon/scripts/prepare-zkapi.sh` followed by
`daemon/scripts/build-native.sh`; see [packaging](docs/CLI_PACKAGING.md).

Use `oa-chat start --backend zkapi` for guided readiness and funding with your
saved network. For a new Sepolia configuration, use
`oa-chat start --backend zkapi --network sepolia`. The advanced manual flow
remains available:

```sh
oa-chat init                 # once, for both modes; mainnet unless --network is supplied
oa-chat serve --backend zkapi
# In another terminal:
oa-chat fund
```

`fund` prints a persistent Ethereum address and its public ETH balance.
The command-line flow follows the web wallet's send-to-address flow: choose a
private deposit amount, review principal and network fees, send enough ETH to
the displayed address, and approve the exact quote:

```sh
oa-chat fund --amount 0.00075
# Alternatively, choose a USD value converted to ETH with the verified quote:
oa-chat fund --usd 2
# After reviewing the returned quote and funding address:
oa-chat fund --approve QUOTE_ID
```

Choose the amount of ETH to turn into private inference credits (up to nine
decimals, integer gwei), or an exact USD amount. The quote shows the fixed
principal, required fee allowance, recommended fee buffer, current balance,
and remaining top-up. Approving its ID authorizes local signing within the
quoted bounds; stale or changed quotes require a new review. Unused fee
allowance stays at the local address. After submission, the command waits for
Ethereum finality before activating the private note.

Ctrl+C stops waiting without deleting saved state. `oa-chat fund --resume`
recovers a saved transaction; it cannot authorize a new deposit or fee increase.
Use the same `--config-dir` throughout. `serve`, showing an address, and preparing
a quote never broadcast a transaction. Guided `start` asks before authorizing
a new deposit; after that confirmation, it refreshes bounded quotes and deposits
automatically when the funds arrive.

No browser extension, wallet connection, seed phrase, or imported private key
is required. The daemon creates a signing key and keeps it in its owner-only
configuration directory. Back up the entire directory, including `funding/`
and `zkapi/`; that backup controls public funds and private credits.
Public address balances are not private inference credits until deposited.

To return the remaining private balance to an Ethereum address:

```sh
oa-chat withdraw                 # status only
oa-chat withdraw --to 0xYOUR_ETHEREUM_DESTINATION
oa-chat withdraw --approve QUOTE_ID
```

Replace the placeholder with the receiving address. This closes the entire
private balance after reviewing and approving its destination and fee quote;
the local signer pays ETH gas. Withdrawal preparation reserves the note, so
finish any outstanding inference settlement first. No wallet connection is
needed. Resume an interrupted withdrawal with `oa-chat withdraw --resume`
and the same configuration directory. Once completed, `fund --amount` can
prepare a new private balance.
See [withdrawal and recovery details](docs/CLI_ZKAPI.md#withdraw-without-connecting-a-wallet).

Return public ETH left at the funding address separately:

```sh
oa-chat fund return --to 0xYOUR_ETHEREUM_DESTINATION
# Add --amount ETH to choose a partial return; otherwise reserve gas and return the rest.
oa-chat fund return --approve QUOTE_ID
```

These commands use the same quote/approval boundary. They do not withdraw a
private note. Browser funding pages and the `--browser`/`--no-open` flags have
been removed. See [funding, recovery, and limitations](docs/CLI_ZKAPI.md).
Upgrade both binaries together with the one-command installer before using
these commands; `daemon-v0.1.0` predates them.

The advanced `init` command defaults to Ethereum mainnet; new guided `start`
asks for the network with Sepolia offered as the default. For an explicit,
separate Sepolia profile using the manual commands:

```sh
oa-chat --config-dir /path/to/private-sepolia-state init \
  --network sepolia --listen 127.0.0.1:8788
oa-chat --config-dir /path/to/private-sepolia-state serve --backend zkapi
oa-chat --config-dir /path/to/private-sepolia-state fund
```

The companion checks the manifest chain against the selected network, and
state is separated by network and deployment ID. Version `0.2.0` targets the fresh
September 28 native ETH deployments, not the older ERC-20 wallets. Preserve
old recovery directories; they cannot be rebound to the new vault. Each model
automatically selects the same reviewed budget bucket as the web wallet: $1,
$2, $3, $4.50, or $6. `/v1/models` includes `oa_request_limit_micro_usd` for each
available model. The daemon loads current issuer model policy before issuing
access. Explicit OA model tiers take precedence; otherwise, confirmed provider
catalog models use the web wallet's reviewed fallback policy. Disabled,
unknown, or unreviewed models are rejected. The companion
converts the coarse USD budget to gwei using an independently checked frozen
billing quote. A private balance at least equal to that bound can obtain access,
subject to any outstanding settlement. The budget is a cap; settlement charges
actual usage. Legacy fixed-limit settings are accepted but ignored.
Its HTTPS requests always use the daemon's
authenticated loopback CONNECT bridge, which rejects plaintext HTTP. The bridge
connects directly to destination TCP by default, or carries destination TLS
through Wisp when `relay_url` is set. Go inference uses the same external
transport choice. A configured relay has no direct fallback. The advanced
`zkapi.external_companion` option requires an operator-managed, patched
companion with the matching transport mode, HTTPS enforcement, bridge
authentication, and verification policy.

The deployed zkAPI protocol may keep one private-wallet lease outstanding
until expiry and settlement (currently up to five minutes on Sepolia). A lease
is handed to the API only once, including across restarts. Another request
returns `409 settlement_pending` until a fresh key is available, avoiding
cross-chat key reuse. See [zkAPI integration and server prerequisites](docs/CLI_ZKAPI.md)
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
checksum-pinned Homebrew/AUR/Nix metadata
for `daemon-vMAJOR.MINOR.PATCH` tags. It creates a draft GitHub release.
The generated Nix release flake includes its pinned inputs and NixOS/Home
Manager user-service modules. Release validation checks the installer,
package manifests/payloads, native Homebrew and Arch packaging, and Nix
packages/modules before creating the draft. A manual workflow dispatch builds
and validates without creating a release. Publishing a tap, AUR package, or
distribution repository is a separate release action; none has been published
by this implementation. See the [publication handoff](docs/CLI_PACKAGING.md#building-a-release).

## Privacy and stream handling

- Tickets are blinded locally with CIRCL's RFC-compatible Blind RSA. Every
  request obtains a fresh provider key. Matching verifier approval binds its
  station and SHA-256 key identifier. Like the web client, a narrowly eligible
  verifier outage can continue with explicitly unverified access; see the
  [outage policy](docs/CLI_ZKAPI.md#privacy-boundaries). Response headers and a
  fixed foreground warning distinguish this state from verified access.
  Like the browser, the daemon accepts the deployed 16-hex identifier; it also
  accepts a matching full 64-hex digest. This check applies to the authenticated
  HTTPS response to that key's submission, never a generic broadcast result.
- HTTPS validates destination certificates in Go/the companion in both
  transport modes. Direct mode exposes your source IP to destination services
  and uses local DNS. Opt-in Wisp resolves destination DNS and forwards encrypted
  TCP; the relay sees timing and connection metadata, not HTTP content. Each
  HTTP request uses a separate destination TLS connection, with no persistent
  connection/session-cache grouping of keys. Ephemeral keys do not prevent
  source-IP or timing correlation in direct mode.
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
[live timing record](packaging/validation/openwebui-staging-stream.json)
and [partial-response screenshot](docs/images/cli-openwebui-staging-streaming.png).

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
[recorded stream timing](packaging/validation/staging-direct-stream.json).
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
leaving 0.099277 USDC. See the [browser and settlement record](packaging/validation/openwebui-sepolia-stream.json).
A fresh independent request after settlement passed HTTP 200 with 100 content
events, first content at 7.081 seconds, and `[DONE]` at 7.843 seconds. See the
[direct SSE record](packaging/validation/sepolia-direct-stream.json).
That second lease also settled automatically, charging 0.000065 USDC and
leaving 0.099212 USDC with no pending request.
These timings include access preparation. The public Sepolia manifest does
not expose its OA-org issuer environment, so this ZKAPI test does not establish
that its issuer is staging; the ticket test above explicitly uses staging.

Additional screenshots: [Open WebUI completed live response](docs/images/cli-openwebui-staging.png),
[streaming fixture](docs/images/cli-openwebui-stream.png), and
[live Sepolia funding page](docs/images/cli-sepolia-funding.png).

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
