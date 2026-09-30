# OA Chat command-line daemon

`daemon/` is a standalone Go module exposing an OpenAI-compatible API for
Open WebUI and other server-side clients. Homebrew services/launchd and a
systemd **user** service manage its foreground process.

Supported endpoints are `GET /v1/models` and `POST /v1/chat/completions`,
including SSE streaming, tool calls, multimodal messages, structured outputs,
usage events, and reasoning fields. Responses, Assistants, embeddings,
file-storage, and image-generation endpoints are not implemented.

## Install, configure, and serve

The public commands are **`oa-chat config`** and **`oa-chat serve`**. Install or
update the `0.4.2` prerelease:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.4.2/install.sh | bash
PATH="$HOME/.local/bin:$PATH" oa-chat config
PATH="$HOME/.local/bin:$PATH" oa-chat serve
```

Installation checks and updates both binaries and their proving assets. It
creates no configuration and starts no service. `config` then shows the saved
status and guides setup; `serve` runs the configured local inference API.
For a custom prefix, substitute its `bin` directory in PATH. Keeping that
directory on your shell PATH lets you use the shorter commands below.

Current source starts watching for funding immediately and asks you to press
Enter once funds arrive. It also makes setup independent of models, serves local
inference without an API key by default, and reuses ephemeral keys for a short
window to handle related bursts of requests. zkAPI requests still queue while
earlier inference or settlement is pending. Runtime instructions use `oa-chat`
and hide local file paths. Normal service logs show inference requests and
zkAPI key sessions, including their settled cost and remaining private balance,
without routine companion readiness/retry messages.
These changes postdate the published `0.4.2` bundle; the installer above still
provides that release.

Sepolia requires `0.4.1` or newer, which includes the matching password-capable
client and companion. `0.4.0` predates the password gate and cannot complete
Sepolia readiness or inference. See the
[release validation limitation](docs/CLI_PACKAGING.md#published-040-configserve-validation-2026-09-29).

Run as your normal user on macOS 13+ or Linux with glibc 2.39+, on AMD64 or
ARM64. Linux also needs OpenSSL 3, libgcc, and CA certificates. No `sudo` or
shell-profile changes are needed. Stop the daemon before upgrading, rerun the
installer with the same prefix, and restart afterward. Private configuration,
tickets, wallets, and the previous release are retained. Use `oa-chat --version`
to check the installed version. See [installer options](docs/CLI_PACKAGING.md#one-command-installation)
for version pinning, custom prefixes, and optional `--setup`.

## Configure or edit a profile

```sh
oa-chat config
```

With no configuration, `config` creates the private directory using
**zkAPI on Mainnet with direct HTTPS**. If funding is needed, it prepares a
new deposit by asking for the USD amount; **press Enter to use $20**. It then
displays the ETH address, payment amount, current receiving balance, and a QR code
in the terminal. No initial mode or network answers are needed. Network fees are
extra and shown separately. The CLI immediately waits for incoming ETH, checking
every five seconds and updating the balance and remaining payment. Once enough
ETH covers the principal and required fees, it shows the current fixed principal
and maximum fee and asks you to **press Enter to continue with the deposit**.
It then deposits within those bounds and waits for finality. Enter `cancel` or
press Ctrl+C to stop while keeping saved progress.
Temporary services it starts are stopped when configuration finishes. You then
run `oa-chat serve` separately.

With an existing profile, `config` displays a redacted status and immediately
checks readiness using the saved settings. It guides any missing ticket setup
or funding and preserves your keys, tickets, and wallet files. Use
`config --edit` to edit settings or `config --menu` to manage tickets, withdraw
private credits, return public ETH, update the Sepolia password, show the local
API key, or check setup.
Stop a running daemon before editing settings; saved settings are available
through `oa-chat config --status`.

The editor covers the saved access mode, zkAPI network, loopback listener,
and optional Wisp relay. Both access modes remain available in the same
profile. Mainnet and Sepolia funding and wallet state stay separated; changing
the selected network preserves each network's state. An invalid config or
orphaned recovery state is reported for recovery rather than overwritten.

For an explicit choice, the same command accepts these settings:

```sh
oa-chat config --backend zkapi --network sepolia
oa-chat config --backend ticket
oa-chat config --usd 50
oa-chat config --edit
oa-chat config --menu
oa-chat config --listen 127.0.0.1:8788
oa-chat config --require-api-key
oa-chat config --relay-url wss://YOUR_WISP_RELAY/
```

Replace the example relay URL with your own, or use `--relay-url ''` to disable
it. `--zkapi-binary` and `--proof-setup-dir` select custom companion locations
for source builds. Installed bundles normally discover both automatically.
Changes are saved; `serve --backend ticket|zkapi` can select a runtime mode
without changing the saved default.
`--usd` selects the USD principal for a new deposit and skips the amount prompt;
it is not a saved configuration setting and cannot change the amount of a deposit already in
progress. Saved deposits resume their fixed ETH principal without another
amount prompt. A ready wallet does not receive another deposit merely because
`config` is run again.

zkAPI configuration checks the companion, private wallet balance, pending
settlement, and withdrawal state. It displays the private ETH balance without
selecting a model or fetching model pricing. Any positive available private
balance is enough to finish configuration; each inference request checks the
budget required by the model selected for that request. New deposits accept a
positive USD amount without a model-specific minimum.

Configuration defaults to `~/Library/Application Support/oa-chat` on macOS
and `~/.config/oa-chat` on Linux, respecting `XDG_CONFIG_HOME`.
`OA_CHAT_CONFIG_DIR` or global `--config-dir DIR` selects another directory.
Private directories use `0700`; `config.json` uses `0600`. Back up the entire
private directory, including `funding/` and `zkapi/`. The backup controls public
funds, private notes, and cash-like tickets. Keep legacy ERC-20 wallet profiles
separate from the current native ETH deployment.

### Build and run ticket mode

Run source-build commands from the repository root:

```sh
cd daemon
go build -o oa-chat ./cmd/oa-chat
./oa-chat config --backend ticket
./oa-chat serve
```

The wizard guides import from a private ticket file or redemption of an
invitation code/OA share URL from a private file. No account sign-in is required.
Ticket mode does not require the Rust companion. See
[ticket protocol and recovery](docs/CLI_TICKETS.md).

### Transport and client credentials

The external network proxy is disabled by default: an empty `relay_url` uses
direct HTTPS for ticketing, verification, inference, companion requests, and
funding RPC. Environment proxy variables are ignored. Destination services can
see your source IP and local DNS resolves their names. A configured Wisp relay
resolves destination DNS and hides your source IP from destination services;
it sees connection metadata. A configured relay fails closed without direct
fallback. Editing configuration preserves existing nonempty relay settings
unless you explicitly change them.

The listener defaults to `127.0.0.1:8787` and accepts only loopback addresses.
Local inference requires **no API key by default**, including existing profiles
that omit `require_api_key`. To require a key, stop the service and run
`oa-chat config --require-api-key`; `--require-api-key=false` disables that
requirement again. With key authentication enabled, `oa-chat config --api-key`
prints the local client key. This key never reaches the inference provider.

The daemon still generates a local key for authenticated administration, and
wallet management additionally requires its separate owner credential. Removing
inference authentication does not expose those routes. Other local processes
can use the default inference endpoint, so enable key authentication when that
local access is not intended. Normal status and setup output hide credentials
and filesystem paths; suggested commands use `oa-chat`. Custom profiles continue
to use the selected configuration directory. Keep private recovery files out of
public logs and bug reports.

### Ephemeral key reuse

By default, requests use the same anonymous OpenRouter key for **60 seconds**
after that credential is acquired. The window is fixed: another request does
not extend it, and credential expiry ends it earlier. This applies to ticket and
zkAPI modes. Every request still checks current model policy; reuse requires the
same ticket-price tier in ticket mode or the same reviewed USD bucket in zkAPI
mode. Eligibility is checked when the request gets its turn, so time spent
queueing counts against the window. It is intended to let a chat response and
nearby Open WebUI title, tag, or follow-up requests use one access grant.

Stop the daemon, edit the top-level value in the existing private `config.json`,
and restart `oa-chat serve` to change the window:

```json
"key_reuse_window_seconds": 60
```

Keep the other configuration fields. The value must be an integer from **0 to
300**. An omitted field defaults to 60, including existing profiles; **0 disables
reuse** and obtains fresh access for every request. `oa-chat config --status`
shows the saved window. You can also save it with
`oa-chat config --key-reuse-window-seconds 60`; no additional setup question is
required.

All requests sharing a key are linkable by the inference provider. The window
applies across local clients and unrelated chats because the API carries no
trusted conversation boundary. Set the value to 0 when each call needs a
separate key. Direct HTTPS also exposes the source IP regardless of this setting.
The key remains only in daemon memory and is not restored after a restart.

Requests in a window share the key's existing aggregate spending cap; they do
not receive a fresh cap per call. A provider HTTP error, transport/read error,
canceled request, or interrupted response discards the key for subsequent requests; inference is never
automatically retried. HTTP-200 response bodies and event streams are passed
through without interpreting application-level error events. Ticket requests
may share a key concurrently; zkAPI requests remain serial through the full
response. Once reuse ends, ticket mode redeems new tickets. zkAPI must wait for its previous
lease to settle before obtaining a new key, which can still take minutes.

### Run inference

```sh
oa-chat serve
```

`serve` uses your saved configuration, checks readiness without prompting, and
stays in the foreground for inference and settlement. If configuration,
tickets, funding, or companion prerequisites are missing, it explains the
problem and directs you to `oa-chat config`. It does not begin a funding flow.
Stop it with Ctrl+C before changing settings. To use another configured access
mode for this run, pass `--backend ticket` or `--backend zkapi`.
zkAPI startup checks wallet state and a positive private balance without a model
lookup. Starting the service does not guarantee that the balance covers every
model; the selected model's cap is enforced when an inference request arrives.
A saved note with pending inference settlement can still start serving; new
requests wait for settlement automatically. A missing note or withdrawal
reservation still needs configuration/recovery.

### Foreground activity and logs

`oa-chat serve` writes timestamped activity to standard output. After startup
instructions, normal activity shows:

- Inference API requests on `GET /v1/models` and `POST /v1/chat/completions`,
  with start/completion, HTTP status, elapsed time, and an aborted indication
  when interrupted.
- A locally numbered OpenRouter key session starting in zkAPI mode.
- That session ending after signed settlement, with its actual ETH charge and
  the remaining private ETH balance.

For example, excluding timestamp prefixes:

```text
zkAPI OpenRouter key session 1 started
zkAPI OpenRouter key session 1 ended (settled); cost: 0.000000028 ETH; balance remaining: 0.001121532 ETH
```

A key session may cover several requests within the configured reuse window.
The displayed cost is the settled charge for the entire key session, not the
key's spending cap or an estimate from one response. The reuse window ending
does not immediately settle the key. Its final cost and balance can appear
minutes after the last response. Streaming still flushes immediately.

Routine companion startup, readiness, retry, and pending-settlement checks stay
quiet, as do health/admin requests. Readiness and recovery continue internally.
A companion process exiting is still a service failure; the daemon itself does
not restart that process. An external service manager may restart the daemon.
Missing configuration, fatal failures, and verification warnings remain visible.

Session reporting requires the matching updated `oa-zkapi` binary. If reporting
fails for 12 consecutive polls (about a minute), the CLI prints one warning to
run `oa-chat config` and check that both binaries are up to date. A successful
poll clears that failure count. Brief failures stay quiet; no charge is guessed.
Events are held in a bounded local memory buffer, not an accounting ledger.
A session recovered after restart can produce an end report without its earlier
start, labeled `Previous zkAPI OpenRouter key session`; completed history from
before the restart is not reconstructed. If the buffer overflows between polls,
the CLI warns that some session history is no longer available and shows the
retained events.

Prompts, responses, headers, model names, query strings, provider keys, raw
session identifiers, wallet secrets, proofs, and raw companion/HTTP diagnostics
are excluded. Command failures return a nonzero exit status with a diagnostic
on stderr. Session cost and remaining private balance are intentionally visible
in these logs. For example, `oa-chat serve > oa-chat.log` captures this financial
and activity metadata. The daemon does not create log files itself; shell
redirection or your service manager can retain them. Homebrew services use their
configured log file and systemd captures stdout in the journal.

## Connect Open WebUI

Add an OpenAI-compatible connection in **Admin Panel → Settings → Connections**:

| Setting | Value |
| --- | --- |
| API base URL | `http://127.0.0.1:8787/v1` |
| API key | Leave blank; select no authentication if available |
| Model | Select from the daemon's model list |

If the client requires a nonempty key field, use a placeholder such as `local`;
default inference ignores it. If you enabled `--require-api-key`, use the output
of `oa-chat config --api-key` instead.

The endpoint must be reachable from the **Open WebUI backend process**.
The daemon binds only to numeric loopback addresses. Container loopback and
host loopback differ: use a shared container network namespace, Linux host
networking, or an SSH tunnel. Do not expose the daemon on `0.0.0.0` to work
around this. The integration test ran both processes in the same container
namespace on a separate Docker host, with only the UI forwarded locally.

Open WebUI may send extra requests for titles, tags, and other background tasks.
The daemon handles zkAPI requests one at a time. Requests using the same reviewed
USD bucket can reuse one key during the default 60-second window, so nearby tasks can
run after the previous response without waiting for settlement. The provider can
link those calls and they share one aggregate cap. A bucket change, window expiry,
or discarded key requires fresh access and can still wait minutes for the
previous lease to settle. Stopping a queued request cancels its wait. See
[key reuse configuration](#ephemeral-key-reuse) to adjust the window or disable
reuse. Optionally disable background tasks or route them to a separate local task
model to reduce paid requests. See
[Open WebUI's background-task explanation](https://docs.openwebui.com/faq/#q-why-am-i-seeing-multiple-api-requests-when-i-only-send-one-message-why-is-my-token-usage-higher-than-expected).

Open WebUI's current `AIOHTTP_CLIENT_TIMEOUT` defaults to no timeout, and
`AIOHTTP_CLIENT_STREAM_IDLE_TIMEOUT` is unset by default. If you configured
finite limits, allow for the queued settlement waits plus inference, including
the wait before the first response chunk. Reverse-proxy timeouts can also limit
that wait. See [Open WebUI's client timeout settings](https://docs.openwebui.com/reference/env-configuration/#aiohttp-client).
The daemon's own 30-minute request limit includes queueing, settlement, and
inference. It admits up to 64 waiting requests beyond the configured concurrency;
larger bursts receive a queue-full response.
Browser JavaScript connects through its UI backend; the daemon rejects browser
Origins and does not enable arbitrary CORS access. Key-free inference also
checks the loopback peer and rejects unexpected Host headers.

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

Run `oa-chat config` to check readiness and fund the selected network. New
profiles use zkAPI on Mainnet without a proxy. The guided flow follows the web
wallet's send-to-address experience: it asks for a USD deposit amount with $20
as the default, then shows the fixed ETH principal, maximum network fee, payment
QR, and current receiving balance. It starts waiting automatically and updates
the balance and remaining payment every five seconds. Send ETH to the displayed
funding address. Once enough ETH arrives, review the current principal and fee
ceiling and press Enter to deposit. The wizard refreshes the quote before signing
and waits for finalized activation. If the balance becomes insufficient, it waits
again and requires another Enter when funded. A higher fee ceiling requires fresh
approval once enough ETH covers the revised quote.
It checks the private ETH balance and wallet state without fetching model
pricing, acquiring inference access, or sending a test request.

Ctrl+C keeps saved progress. Rerun `config` and check readiness to continue:
unsigned deposits require Enter again once sufficiently funded; signed deposits recover the same
transaction without a new authorization or nonce. Public address ETH becomes
private inference credit only after deposit activation. No browser extension,
wallet connection, seed phrase, or imported private key is required.

Sepolia requires the shared testnet password. `config` asks for it with input
hidden and verifies it before starting the companion or funding. It saves the
accepted password in an owner-only local file. Use the **password** action in
`config --menu` to change it without funding, then restart any running daemon.
Unattended services can set `OA_ZKAPI_TESTNET_PASSWORD_FILE` to a private password
file. Mainnet and ticket mode are unaffected. See
[Sepolia authentication](docs/CLI_ZKAPI.md#sepolia-access-password).

Use `config --menu` and its **withdraw** action to close the full remaining
private balance, or **return** to send unused public ETH elsewhere. Both ask for a destination,
show the quote, and require explicit approval before signing. The withdrawal
signer needs public ETH for gas. See [funding and recovery](docs/CLI_ZKAPI.md)
for reservations, restart behavior, and current protocol limits.

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
is handed from the companion to Go only once, including across restarts. Go may
reuse that credential in memory within the configured window and matching bucket,
without another companion handoff. It serializes requests and waits through known
pending settlement when fresh access is needed. Insufficient funds or refused
verification still return an error; a canceled request stops waiting. See [zkAPI integration and server prerequisites](docs/CLI_ZKAPI.md)
for the settlement limitation and the undeployed server proposal, which requires
a different billing policy and is unsuitable for the tested metered deployment.

## Services and packaging

After installing a generated release formula/package:

```sh
# Homebrew, as your normal user:
oa-chat config
brew services start oa-chat
brew services stop oa-chat

# Linux, as your normal user:
oa-chat config
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

- Tickets are blinded locally with CIRCL's RFC-compatible Blind RSA. Requests
  can share a provider key within the [configured window](#ephemeral-key-reuse),
  including across chats and local clients. Matching verifier approval binds its
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
