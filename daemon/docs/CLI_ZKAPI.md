# zkAPI in the Go daemon

The Go gateway supports the prompt-private OA-org key path of zkAPI. It runs
an authenticated local Rust wallet/prover companion, obtains a provider key under the verification policy below without sending a prompt to the companion, and forwards the
original OpenAI JSON and streaming response over direct HTTPS by default.
A nonempty `relay_url` opts in to destination TLS through Wisp.
The Rust companion is needed because the deployed Groth16 wallet and recovery
implementation is Rust; this change does not claim to port those cryptographic
primitives to Go. See [CLI usage](../README.md) and [packaging](CLI_PACKAGING.md).

## Guided first-time setup

The public CLI has two commands: `config` and `serve`. Install or update the
`0.4.2` prerelease with any existing daemon stopped:

```sh
curl -fsSL https://github.com/OpenAnonymity/oa-chat/releases/download/daemon-v0.4.2/install.sh | bash
```

The automatic funding wait and model-independent configuration and startup checks
described below are in current source after `0.4.2`. That published bundle asks
for deposit approval before waiting and still checks the lowest available model
cap during setup; it does not include these adjustments.

Then configure it:

```sh
PATH="$HOME/.local/bin:$PATH" oa-chat config
```

The configuration command shows the saved status first. With no profile, it
creates the normal private directory using **zkAPI on Mainnet
with direct HTTPS** and walks through what is missing. For a new deposit, it asks
for the USD amount, with **$20 as the default when you press Enter**, then
displays the ETH payment address, amount, current receiving balance, and terminal
QR and immediately starts waiting for funds. Use `config --backend ticket` for tickets or
`config --network sepolia` for test ETH. The private
directory is `~/Library/Application Support/oa-chat` on macOS or
`~/.config/oa-chat` on Linux, respecting `XDG_CONFIG_HOME`. Global
`--config-dir` or `OA_CHAT_CONFIG_DIR` selects another directory.

For an existing profile, plain `config` checks readiness immediately using the
saved settings. Use `config --edit` to edit settings or `config --menu` to
manage tickets, withdraw private credits, return public ETH, change the Sepolia
password, show the local API key, or check setup. The editor retains saved values unless you change them.
Stop a running daemon before editing. Mainnet and Sepolia keep separate funding
keys and wallet state in the same profile; selecting one preserves the other. Invalid
configuration or orphaned recovery state is reported for recovery, never
replaced with a fresh wallet. Keep legacy ERC-20 recovery profiles separate.

For zkAPI setup:

1. **Check readiness.** Configuration starts temporary local services or uses
   a compatible existing service. It checks the companion, private wallet and
   ETH balance, pending settlement, and withdrawal reservations. It does not
   select a model or fetch model pricing. Sepolia
   validates its saved access password or asks for one before starting the
   companion or funding. Setup does not acquire inference access or send a test request.
2. **Fund if needed.** Enter a USD deposit amount or press Enter for $20.
   A new deposit accepts a positive amount without a model-specific minimum.
   Review the chosen principal, its fixed ETH amount, network, funding address,
   and maximum network fee. The CLI starts waiting automatically. Send the displayed
   top-up in **ETH on that network**
   to the funding address, not the vault. Scan the terminal QR in a compatible
   Ethereum wallet or copy the address and amount. The recommended transfer
   includes the principal, fee allowance, and an optional fee buffer, less any
   ETH already at the funding address. Leave configuration running: it checks
   every five seconds and updates the receiving balance, shortfall, and payment
   instructions as they change. Once enough ETH covers the principal and required
   fees, it displays the current fixed principal and maximum fee and asks you to
   **press Enter to continue with the deposit**. Enter `cancel` or press Ctrl+C to
   stop. After Enter, it refreshes the quote before signing. If funds are no longer
   sufficient, it resumes waiting and asks for Enter again once funded. A higher
   fee ceiling requires fresh approval only after enough funds are available.
   It deposits within the approved bounds and waits for finalized activation.
   Unused public ETH stays at the funding address.
3. **Run the inference service.** Configuration stops services it started and
   exits when ready. It prints the endpoint, the command for your local API key,
   and the command to serve. An existing service it reused is left running.

To supply the amount without the prompt, run `oa-chat config --usd 50`
with the desired USD amount. This option is not saved and does not replace the
fixed ETH amount of a deposit already in progress. Saved deposits resume that
amount without prompting for it again. An existing ready private
balance is checked without preparing another deposit.

```sh
PATH="$HOME/.local/bin:$PATH" oa-chat serve
```

Leave `serve` running for inference and settlement. It uses your saved settings
and performs noninteractive readiness checks. If something is missing, it
explains what needs attention and directs you to `oa-chat config`.
For a custom installation prefix, substitute its `bin` directory in PATH.

`config --status` shows the redacted saved settings without a menu. `config --api-key`
explicitly prints the local API key for your inference client. The wizard does
not print credentials automatically. Both access modes remain configured;
`serve --backend ticket|zkapi` selects the runtime mode without rewriting the
saved default.

Configuration and service startup require a positive available private balance
and check wallet state without looking up a model or its cap. The terminal shows
the private ETH balance. Each inference request checks the cap for its selected
model, so a configured wallet can still have insufficient funds for a particular
request. An active note cannot be topped up in place; close it before funding a
replacement. Public ETH alone is not private inference credit.

Ctrl+C preserves progress. Run `config` again to check readiness and continue.
An unsigned deposit retains its fixed amount, resumes waiting immediately, and
asks for Enter again once sufficiently funded;
a signed deposit resumes its saved transaction without authorizing another.
A reverted transaction or withdrawal reservation requires explicit recovery.
Back up the complete private directory, including `funding/` and `zkapi/`;
it controls both public funds and private credits.

## Sepolia: from installation to inference

These steps require `0.4.1` or newer with both matching binaries. The `0.4.0`
release predates Sepolia's testnet password gate; its generic billing-quote
error may mask HTTP 401 `testnet_password_required`. See the historical
[release validation limitation](CLI_PACKAGING.md#published-040-configserve-validation-2026-09-29).

Use the installation command above, then select Sepolia in configuration:

```sh
PATH="$HOME/.local/bin:$PATH" oa-chat config --backend zkapi --network sepolia
PATH="$HOME/.local/bin:$PATH" oa-chat serve
```

Follow the guided funding flow using Sepolia test ETH. Sepolia is optional and
is never selected by installation. Editing the network retains Mainnet wallet
state and vice versa. Use an explicit separate `--config-dir` if you prefer
independent profiles or listeners.

### Sepolia access password

The Sepolia ZKAPI service requires one shared testnet password. Updated
`oa-chat config --backend zkapi --network sepolia` asks for it with terminal echo disabled,
validates it with the pinned server before starting funding, and saves the
accepted password in the owner-only `sepolia-password` file inside your private
configuration directory. A missing or incorrect password cannot authorize
service access. Mainnet and ticket mode do not use it.

`serve` is noninteractive and rejects missing or incorrect access before starting
the companion; it points back to `config`. For unattended `serve`, supply `OA_ZKAPI_TESTNET_PASSWORD_FILE` pointing to a
regular file readable only by its owner, or set `OA_ZKAPI_TESTNET_PASSWORD`
through your service manager's private environment. Environment values take
precedence over an explicit password file, which takes precedence over the saved
file. Environment overrides are never saved. Keep passwords out of command-line
arguments, shell history, screenshots and bug reports.

Stop and restart the daemon after a password change. With no environment
override, `config` asks again when the saved password is rejected. The **password**
action in `config --menu` validates and saves a replacement without starting the companion or
funding, including when the old saved password file needs repair. With an
override, update its value or private file before restarting. Existing wallet
and recovery state stay intact. Upgrade **both binaries together**: companion
bridge version 4 is required, so an older companion cannot silently skip
authentication and continue into funding.

The password travels only over HTTPS to the pinned Sepolia protocol server in
`X-ZKAPI-Testnet-Password`. Redirects cannot forward it. The indexer, Ethereum
RPC, OA identity/ticket services, verifier and inference provider never receive
it. It is a shared access restriction, not a per-user identity or replacement
for proof authorization, and is separate from the local inference API key.

### Optional streaming request

Run this in another terminal while `serve` remains running. Use the printed
API-key command and endpoint instead for a custom prefix, directory, or listener:

```sh
OA_LOCAL_API_KEY=$("$HOME/.local/bin/oa-chat" config --api-key)
printf 'Authorization: Bearer %s\n' "$OA_LOCAL_API_KEY" | \
  curl --fail-with-body --silent --show-error --no-buffer --header @- \
    -H 'Content-Type: application/json' \
    http://127.0.0.1:8787/v1/chat/completions \
    -d '{"model":"openai/gpt-4.1-mini","messages":[{"role":"user","content":"Say hello in one sentence."}],"stream":true,"max_tokens":64}'
unset OA_LOCAL_API_KEY
```

Choose an available model from `GET /v1/models`; each entry includes its
`oa_request_limit_micro_usd` (1,000,000 means a $1 cap). Success streams `data:`
events followed by `data: [DONE]`. The cap is selected automatically and actual
usage is settled afterward. Another request can return `409 settlement_pending`
for up to about five minutes. Keep the daemon running and retry after its
foreground status reports that settlement is no longer pending. `402 funding_required`
means the private balance cannot cover the requested model's cap. An eligible
trusted-station verifier outage may continue as `verifier-unavailable`;
explicit verification refusals still block access.

## Network and funding

Use `oa-chat config` to check readiness and deposit. Select a network with
`config --network mainnet|sepolia`, or use `config --edit` to change saved settings.
The packaged public manifests match the September 28 native ETH deployments used by
[staging Mainnet](https://staging.openanonymity.ai/) and
[Sepolia](https://oa-wallet-eth-sepolia.vercel.app/):

| Network | Manifest | Vault |
| --- | --- | --- |
| Mainnet | `https://54.67.93.98.sslip.io/config.json` | `0x4bDC8718c4F39289455a3C15F8Bd2C345AA51a41` |
| Sepolia | `https://52.52.207.206.sslip.io/config.json` | `0x999F40773e47f7e07f435C0CC69225c409B64329` |

The companion is pinned to source `20aa542ae98e767c0507133fd34b12a56f5ccd3d`
and protocol `8b2d4e3da921f956e1eb6b93afbf722a877c060c`, with the deployed
`zkapi-v2-note-bound-v1` proving assets. Full public manifests are embedded in
the Go binary; a remote manifest change cannot silently redirect an existing
wallet. Companion state is separated by network and deployment ID. A saved
manifest or funding journal from a different deployment fails closed. Preserve
legacy token wallets and use their matching old client with a separate config
directory; this release does not migrate old private notes.

Both deployments use native ETH for principal and gas. Private balances and
protocol amounts are integer **gwei** (1 unit = 1,000,000,000 wei), while the CLI
shows ETH with up to nine decimals. The configuration wizard creates a
persistent local signing key and displays its address and public balance.
Send ETH on the displayed network to that address. Sending directly to the
vault does not fund a private note.

The deposit quote separates principal, expected fees, required fee allowance,
recommended buffer, and exact top-up. Fee quotes expire after 30 seconds;
automatic refresh keeps the USD-selected deposit's original ETH principal
fixed. Waiting and quoting do not authorize signing. Once the address holds enough
ETH, pressing Enter at the deposit prompt authorizes only the displayed operation
and maximum fee. A fresh quote is checked after Enter and before signing; a higher
fee ceiling requires new approval once sufficiently funded. No token approval or
mint is needed. Configuration waits for finalized activation after signing. Canceling
and resuming retains the same signed bytes and nonce. Unused fee allowance
remains at the local address.

The terminal QR is generated locally and encodes an Ethereum payment URI with
the public funding address, selected chain ID, and exact recommended top-up in
wei. It contains no signing key, private-note secret, or local API credential,
and no external QR service receives the payment instructions. The text address,
ETH amount, and URI remain available for wallets that cannot scan terminal QR
codes. An address that already holds enough ETH needs no additional payment.

The selected model automatically determines its inference budget, matching
the web wallet's reviewed ticket-tier map:

| Model ticket tier | Maximum request budget |
| --- | --- |
| 1 or 2 | $1 |
| 3 or 8 | $2 |
| 5 | $3 |
| 25 | $4.50 |
| 100 | $6 |

Before each request, the daemon anonymously fetches `/chat/model-tickets` and
`/chat/pinned-models` from the issuer pinned in the deployment manifest. It
rejects unknown, disabled, malformed, or unreviewed tiers before acquiring a
lease. Explicit OA pricing takes precedence. A model confirmed in the provider's
public catalog but absent from the OA map uses the web wallet's reviewed
fallback policy. A metadata fetch failure never authorizes from stale policy. Only the
trailing `:online` suffix is normalized; `:free` and `:batch` remain exact model
identifiers. `/v1/models` lists eligible models and their integer
`oa_request_limit_micro_usd` budgets. Legacy `zkapi.request_limit_micro_usd`
config fields remain readable but no longer control new requests.

The server's native minimum still applies. The companion obtains a frozen
billing quote, independently checks its finalized Chainlink round through the
pinned chain/RPC, and rounds the USD limit upward to native units before
proving. A balance at least equal to this bound can obtain access, subject to
pending settlement. Lease and settlement must retain that quote. A recovered
prepared request keeps its original bound and rejects a different requested
tier while pending. The cap is spending authority, not an immediate full-cap
charge. Only the coarse USD bucket reaches the companion; model selection and
prompts remain in the Go inference path. Bridge version 4 is required so an
older companion cannot silently ignore the per-request limit.

Funding is command-line only. Reading an address or requesting a quote never
broadcasts a transaction. The **return** action in `config --menu` quotes a transfer
of unused public ETH to a destination you enter. Choose a partial amount or
return the available balance after reserving gas, then approve the quote.
This is separate from withdrawing private inference credits.

The daemon refreshes the vault's empty-leaf Merkle witness, and signs the exact
`deposit(bytes32,uint128,uint256[32])` call. Network, deployment and denomination checks,
gas simulation, gas/fee limits, and receipt checks fail closed. Signed bytes,
hash and nonce are saved durably **before** broadcast. Ambiguous submission
replays those same bytes, rather than allocating another nonce. Confirmation
must bind the vault event to the saved private-note commitment and amount.
Deposit activation waits for Ethereum's finalized block,
[typically around 15 minutes](https://ethereum.org/roadmap/single-slot-finality)
after mining; an unsupported finality response does not activate
credits. Gas limits use the current simulation with bounded padding. New
transactions use the web wallet's Low EIP-1559 fee policy and the approved quote's
fee allowance rather than fixed 300-gwei/0.02-ETH ceilings. Fees are additional
to the ETH deposit principal; the optional reserve buffer is not a minimum
funding requirement. Previously signed legacy transactions are replayed with
their original bytes and fee settings. After canonical finality, status shows
the actual network fee derived from the receipt.

Version `0.2.0` includes this terminal flow. The older `daemon-v0.1.0` bundle
used MetaMask; install both matching binaries from `0.4.1` or newer together. The acceptance
records below distinguish the current terminal quote flow from earlier implementations.

## Terminal quote validation (2026-09-29)

The current Go/Rust build was exercised against the same Sepolia deployment as
the web wallet. A $2 deposit selected exactly 731583 gwei, retained its principal
through quote refresh, and produced a type-2 deposit transaction. Switching the
same configuration to ticket mode and back preserved the signed transaction;
`fund --resume` recovered it without a second nonce. Ticket mode rejected wallet
management, and the saved default stayed unchanged.

After finalized activation, a $6 model was rejected with `402 funding_required`
without preparing a proof. A $1 `openai/gpt-4.1-mini` request streamed 40 content
events and `[DONE]` (first content 15.235 seconds, total 15.668 seconds). The live
verifier outage exercised `verifier-unavailable` / `recently_attested_outage`.
The proof used exactly 365658 gwei under the frozen oracle quote. An immediate
second request returned `409 settlement_pending`; signed settlement charged
28 gwei and left 731555 gwei.

The full remaining private balance was quoted and explicitly approved for
withdrawal to the local funding address. Independent canonical receipt and
block-balance checks confirmed its exact payout, 28-gwei treasury share, closed
note, consumed nullifier, and fees within both approved ceilings. This live check
caught a quote-simulation edge case: a synthetic maximum sender balance overflows
when that sender also receives the withdrawal. Quotes now reserve the exact
payout headroom; signing still checks the real balance. A regression test covers
both simulation calls and the signing boundary.

Withdrawal finalized at checkpoint 11808017. After restarting and waiting for
companion readiness, `withdraw --resume` returned the saved completed result;
the chain nonce stayed 4, signed bytes were unchanged, and no active private
note or pending transaction remained. Both actual receipt fees survived restart.
The test daemon was stopped and its private configuration backed up locally.
Exactly 0.020387670172247908 Sepolia ETH remains at the local funding address.

The full Go race suite and vet, 45 Rust clientd tests, 21 Rust CLI tests,
all-target compilation, exact source/patch checks, and native package
installation/reinstallation passed. GitHub's Linux/macOS installer workflow
also passed for the implementation commit. Independent adversarial review
approved the final code. See the [sanitized receipt and recovery record](../packaging/validation/sepolia-cli-quotes-20260929.json).
Mainnet was checked read-only; public ETH return has automated coverage but no
live broadcast in this run. This validates the local source and native test
package, without publishing a new release.

## Earlier native Sepolia acceptance (2026-09-29)

The local Go/Rust build matches both current frontend profiles. Mainnet was
checked read-only: companion identity and asset checks passed and the public
model catalog returned HTTP 200. No Mainnet transaction was sent.

This historical native run predates dual-mode selection, model-selected
budgets, and command-line quote approval. It used direct HTTPS, a 0.00075 ETH
principal, and a fixed $1 request cap. Deposit
[`0xecedf3…f5848`](https://sepolia.etherscan.io/tx/0xecedf3ddf3f37639180422538ffd2d1f6cb04b3621806ea44c7be3ad9b3f5848)
created note 10. Restart while waiting for finality preserved the exact signed
bytes and nonce. Finalized activation produced 750000 gwei.

One `openai/gpt-4.1-mini` request returned HTTP 200 with 40 incremental content
events and `[DONE]`; first content arrived at 14.599 seconds and completion at
15.117 seconds. The actual verifier outage exercised the recently-attested
exception: headers reported `verifier-unavailable` /
`recently_attested_outage`, and foreground logs emitted the fixed warning.
An immediate independent request returned `409 settlement_pending`.

The proof bound was 374611 gwei under frozen oracle round
`18446744073709588031`. Automatic signed settlement charged 28 gwei and saved
749972 gwei, with the pending journal removed. Restart preserved that reduced
balance. Withdrawal
[`0x0b3ad1…575e1`](https://sepolia.etherscan.io/tx/0x0b3ad15dce79ced74d1d4fc31aeb558021ea05250d54302caa99a3ddf6a575e1)
mined successfully: independent receipt and block-balance checks matched the
749972-gwei recipient payout and 28-gwei treasury charge; on-chain note state
was closed and its nullifier consumed. Restart retained the same withdrawal
bytes and nonce. Withdrawal finalized at checkpoint 11805799. A final restart
and repeat returned the saved completed withdrawal without another transaction:
chain nonce stayed 2, the journal contained exactly one deposit and one
withdrawal, and no private note or pending settlement remained. The receiving
address was unchanged. The test daemon was stopped and its completed wallet
backed up locally; 0.035705078831276256 Sepolia ETH remains at that address.

Two external timing conditions were observed without relaxing policy. A fresh
oracle round existed at latest but not finalized, causing
`native_quote_expired` until finality advanced; the quote recovered naturally.
The withdrawal's fixed legacy gas price was briefly below the base fee, then
mined when eligible. Pending signed transactions retain their bytes and nonce;
this client does not automatically replace them with a higher-fee transaction.

The full Go suite, race checks, vet, 41 funding UI tests, 43 Rust clientd tests,
21 Rust CLI tests, workspace/all-target compilation, exact pinned-source checks,
and macOS ARM64 package install/reinstall checks passed. The
[sanitized validation record](../packaging/validation/sepolia-native-cli-20260929.json)
contains exact transaction and accounting evidence. Independent adversarial
review approved the source after verifier-refusal and proof-asset startup
hardening. This is a local source/build validation, not a published release.

## Privacy boundaries

The local inference API bearer key and owner-only `management-token` are
distinct. All wallet management routes, including quotes and public-fund
returns, require both credentials. The safe `/admin/status` mode metadata
requires only the API key. Browser-origin requests are rejected and there is
no wildcard CORS. The companion creates a fresh HTTP client for each remote call so neither
pooled connections nor a previous client's TLS state group independent
proof/lease requests. The companion authenticates every
route, including reset, health, and its upstream funding UI.

Every companion HTTP path, including manifest discovery, indexer reads, ZK
proof submission, lease issuance, and verifier submission, always uses the
daemon's authenticated loopback CONNECT bridge. The bridge rejects plaintext
HTTP, including HTTPS-to-HTTP redirects. With an empty or omitted `relay_url`,
it connects directly to destination TCP; with a nonempty value, it carries the
companion's destination TLS through Wisp. The local HTTPS enforcement bridge
remains active when the external network relay is disabled. Inference and all
funding RPC calls use the same external transport choice in Go. Environment
proxy variables are ignored. A configured relay fails closed without direct
fallback. See [transport configuration](../README.md#build-and-run-ticket-mode).

Direct mode exposes the source IP to destination services and uses local DNS;
fresh ephemeral keys do not prevent source-IP or timing correlation. HTTPS
certificate validation and the same station/key verification policy apply in
either mode. The configured RPC and public chain can observe the funding address,
incoming transfers and deposit. Generating the address locally does
not make public funding anonymous; the private-note proof and ephemeral
inference-key boundaries remain unchanged.

The companion requires `direct_openrouter` and `require_oa_org_key_source`.
Each key is submitted to the independently configured verifier. A matching
`verified` result must bind the exact station and the first 16 lowercase hex
characters of SHA-256(key), or a matching full 64-character digest.

The daemon also implements the web client's explicit outage policy. Transport
timeouts and HTTP 408/500/502/503/504 permit continuation only when issuance
reports `recentlyAttested: true`. HTTP 429 and the exact HTTP 503
`unverified` / `ownership_check_error` result are eligible without that flag,
matching the browser policy. Keys remain **unverified** under this exception.
Malformed responses, certificate failures, cancellation, explicit rejection,
known banned stations, station/hash mismatches, expired keys, missing signatures
and unexpected inference origins fail closed. Bans observed by a running
process remain sticky for that process.

Both ticket and zkAPI responses expose `X-OA-Verification-Status: verified` or
`verifier-unavailable`; the latter has a fixed allowlisted
`X-OA-Verification-Detail` reason and emits a fixed warning in foreground logs.
Provider-supplied and caller-supplied verification headers cannot override this
local decision. The CLI does one bounded check per single-use key and has no
browser-style retained session/background retry queue. Outage continuation
accepts the browser's documented risk of temporarily proceeding without a
current per-key station ownership/privacy check; it never claims verification.

The signed key validity must cover the advertised lease expiry by zero to
60 seconds, matching the working browser SDK. The server deliberately subtracts
a 30-second safety margin from the key's expiry when advertising a usable lease.
Strict equality rejected an otherwise valid live lease after successful proof
and key issuance. The original signed expiry is still sent to the verifier;
the Go gateway receives and enforces the shorter lease expiry. This does not
extend either lifetime or loosen station, signature, origin, or key binding.

The wallet secret is written to a mode-0600 recovery file before a deposit is
sent. Receipt validation binds the successful transaction
to the configured vault, commitment, amount, note ID, and expiry. The secret is
sent only to the authenticated loopback companion when activating the note.

Historical browser deposits could wrap a deposit in a transaction whose outer recipient is its
execution contract. The receipt must be successful and contain the exact
`NoteDeposited` event emitted by the configured vault, matching the pending
commitment and amount; the outer transaction recipient is not the deposit
authority. Requiring that recipient to equal the vault incorrectly rejected
a successful live Sepolia deposit. Recover such a deposit using its existing
transaction hash and private recovery record.

## Current lease limitation and operator prerequisite

**The current deployed lease protocol does not provide immediate independent
requests from one funded wallet.** A generic OpenAI request carries no trusted
conversation boundary, so the Go daemon must not reuse a provider key across
API calls. Each eligible lease is durably marked as handed out once before its
key is returned. A repeated or concurrent call receives HTTP 409 until the
previous private-state transition settles. This also prevents key reuse after
a crash or a lost local HTTP reply.

The successful September 10 request had approximately 4.5 minutes of usable
lease lifetime, followed by a five-second settlement grace period. The next
independent request waits for that signed private-state transition, even if
inference finishes much earlier. Open WebUI background title/tag/follow-up
requests also consume separate access and can encounter this limit. Immediate
repeat requests remain an unresolved deployment requirement.

**Historical ERC-20 validation (September 10), not native-release evidence.** The successful streamed request settled
with `usage_usd: 0.000723` and `charge_applied: 723`, reducing the private balance
from 100000 to 99277 microcredits (0.100000 to 0.099277 test USDC). The pending
flag cleared automatically. Its advertised 0.05-USDC key limit was a cap, not
the debit. The earlier lease rejected by the local expiry check settled with
no balance reduction. These observations describe the tested Sepolia deployment;
do not infer another deployment's accounting from its key limit or source label.

The standalone, **not deployed**
[`server-early-settlement.patch`](../internal/zkapi/server-early-settlement.patch)
is a historical proposal against the pinned upstream commit. It assumes each
OA-org key is charged its entire proof-bound cap at issuance and signs the next
state immediately. **It is unsuitable for this metered Sepolia deployment and
must not be deployed there as written.** Doing so would change actual-usage
billing into full-cap charging. Its focused tests validate the assumed policy;
they do not establish compatibility with the deployed server.

An early-settlement design for this deployment must preserve actual-usage
accounting, safely end or otherwise account for the previous key's remaining
spending authority, and finalize the signed state exactly once. It requires
server/protocol work and separate live validation. The companion can recover
an early finalized state, but that capability alone does not solve those
accounting requirements. Streaming delivery itself does not wait for settlement.

The live proof and inference test used the public Sepolia zkAPI deployment.
Its backing OA-org URL is not exposed in the public manifest or health response;
whether it uses the staging OA-org remains unverified. Ticket staging validation
is separate. The public Wisp relay failed during this test session, so the live
flow used an owned temporary Wisp helper on the staging host through SSH.
That helper has a four-hour runtime limit and depends on its SSH forward; the
production relay was not changed and there was no direct-transport fallback.

## Recovery and refilling

The Go recovery record is under `funding/<network>/pending-deposit.json` in the
private configuration directory. It survives a terminal close, service restart,
and an ambiguous on-chain response. The local signer also retains its key and
signed transaction journal in `funding/<network>/address-funding.json`. Resume
through the readiness check in `oa-chat config`. Back up the complete private config
directory before sending funds; neither OA nor the sender can recover a lost
local key. Never copy its secrets into support logs.

Legacy browser funding pages are no longer exposed. A legacy pending record
is never silently replaced with a new local-signer deposit. Preserve its
recovery files and use its matching old client where necessary; the current
native deployment cannot import an older vault's private note.

Confirmation retries never reinitialize an already active note to its original
balance. Activated recovery records are retained and are archived with a
`.completed-<hash>` suffix once the companion has no active note and a new note
is prepared. Keep both the companion wallet directory and these recovery
records private and backed up.

The address-funding journal retains one authorized deposit. A finalized revert
can be retried explicitly with the same note secret and refreshed witness;
ambiguous transactions always retain their original signed bytes and nonce.
An activated journal whose companion note is missing requires recovery, not a
second deposit. After a confirmed CLI withdrawal the journal retains the
signing key and transaction history, archives the completed deposit recovery
file, and permits a new deposit through `config`. Excess public ETH remains
controlled by the saved Ethereum key. The **return** menu action quotes a
public transfer with gas reserved, or lets you choose a fixed amount. Review
and approve the displayed quote before it signs.
This moves only public address funds; withdrawing private credits is separate.

The current upstream wallet has one active note. Deposits do not increase an
active note in place. The CLI therefore refuses to overwrite an
active note. Close it with the **withdraw** menu action before funding another note.
Preserve its wallet state when changing to a separate funded state directory.

## Withdraw without connecting a wallet

Run `oa-chat config --menu` with the same configuration directory and choose the
**withdraw** menu action. Configuration starts temporary services if needed.
The action shows status, asks for the receiving address, and displays a fee
quote. Approval authorizes withdrawal of the **entire remaining private
balance** to that saved destination; there is no partial private withdrawal.
The daemon generates the withdrawal proof and uses its existing local Ethereum
key to submit `mutualClose` only after quote approval. No browser extension, wallet connection, seed
phrase, or imported key is needed. ETH for gas must be available at the displayed
local signing address, on the configured network. The displayed Low EIP-1559
quote fixes the maximum approved fee allowance, expires after 30 seconds, and
must be refreshed when stale. Finalized status shows the actual network fee.

An outstanding inference must settle first. Preparing a withdrawal saves a
reservation before requesting clearance and blocks further inference on that note. The
destination cannot change after starting; there is no cancellation that resumes
spending a reserved note. Proof preparation can take several minutes. Ctrl+C
stops waiting; rerun `config --menu` and choose **withdraw** to recover saved signed progress.
An uncertain broadcast reuses the identical signed transaction. Only a finalized
revert permits a fresh transaction, following a new quote and approval, with
the same note, destination, balance, and nullifier.

Every request is bound to the originally selected note ID. A suspended terminal
cannot resume against a later deposit, and concurrent polling cannot authorize
a retry: only a new command that observes the failed transaction sends its exact
hash as retry authorization. All wallet management requires the
owner-only `management-token` file, automatically retained in the private config
directory. The inference API key shared with an OpenAI-compatible client is
insufficient to initiate or inspect wallet operations; the CLI supplies both credentials.
An unsuccessful retry preserves the previous failed transaction until a
replacement has been durably signed, so an already-relayed payout can still be
confirmed after proof, simulation, or gas errors.

Both the daemon and companion validate the finalized canonical receipt and the
exact vault `MutualClose` event before completing recovery. The companion keeps
a private archive of the closed note; the funding record is archived with a
`.withdrawn-<transaction-hash>` suffix. Repeating a completed command does not
send another transaction. A successful withdrawal permits a new deposit using
the same local address. A missing note without this verified closure still
requires recovery and never authorizes a replacement deposit.

If another party relays the same valid withdrawal first, the requested recipient
still receives the payout but the local transaction can revert. After the local
revert is finalized, confirm the successful payout instead of sending another
withdrawal. The **withdraw** recovery prompts accept the successful
transaction hash for this case.

The supplied receipt must be finalized and match the exact saved vault, note,
nullifier, amount, and destination. Both processes verify it before completing
recovery; this command cannot substitute a different payout. The local failed
transaction must also be finalized so its signing nonce is safely retired.

This command implements cooperative withdrawal, which requires the zkAPI
server to issue clearance. The delayed escape/challenge workflow is not exposed
by the CLI. Public tokens or ETH left at the local address are separate
from the private balance and are not swept by withdrawal; use the **return**
menu action for public ETH. Withdrawal amount,
destination, and transaction are public Ethereum data.

Install both binaries from the same `0.4.1` or newer bundle: the companion must advertise
`bridge_version: 4` and `withdrawal_bridge_version: 1`. The older `daemon-v0.1.0`
bundle predates the command and cannot run it with only a replaced Go executable.

## Historical address-funding verification (2026-09-22)

This section records the older ERC-20 flow and its browser tests. It does not
validate the current native quote/approval commands.

Withdrawal coverage includes exact ABI/signature binding, gas shortage, frozen
note/destination/amount, concurrent polling, explicit failed-hash retries,
canonical finality and event matching, direct and wrapped competing payouts,
lost replies/restart, zero-balance closure, legacy refill followed by a second
withdrawal, and separate management authorization. Rust regressions cover
durable reservations, mutation/lease exclusion, event/finality rejection, archive
ordering, and old-completion/new-note isolation.

The [live withdrawal acceptance record](../packaging/validation/sepolia-cli-withdrawal.json)
completed on September 23 UTC (September 22 Pacific). After safely stopping for
insufficient gas, the same saved command resumed when test ETH arrived. It
withdrew note 58's remaining **0.099971 test tokens**, using the locally generated
funding key, in [this Sepolia transaction](https://sepolia.etherscan.io/tx/0x0854712a98b32c420aa5f9a012674b057ea9e0e69541e6aa4a553f7e0b8bdf1a).
Independent receipt and historical balance checks verified the exact recipient
payout, 29-unit treasury payment, consumed nullifier, closed note, and canonical
Ethereum finality. Gas cost was 0.007434784766264632 Sepolia ETH.

Restarting while awaiting finality retained the identical signed transaction.
After finality, both processes reported completion, archived recovery material,
and cleared the active note and pending transaction. Another daemon restart,
repeated CLI command, and repeated management request returned the same result:
the signer nonce remained 3, with only approval, deposit, and withdrawal signed.
The same funding address reported `ready`; a second live deposit was not made.
Temporary test services were stopped, with private state and backups retained.
This verifies cooperative withdrawal on the pinned legacy Sepolia deployment;
it does not imply a mainnet run or a newly published native release.

That change was covered by mocked JSON-RPC/companion integration tests:
address persistence and file permissions, wrong-chain/token checks, exact
signed calldata, approval/deposit ambiguity, restart and nonce rollback,
canonical/finalized receipt checks, reorg recovery, explicit reverted retries,
concurrent callers, and missing-note refusal. CLI tests exercise integer
amount parsing, read-only address display, explicit deposits and cancellation;
37 browser-script tests cover address-only loading, explicit authorization,
recovery, session expiry and balances without any injected wallet provider.

Current Go checks run from `daemon/` with a patched Go toolchain:

```sh
GOTOOLCHAIN=go1.26.6 go test -race ./...
GOTOOLCHAIN=go1.26.6 go vet ./...
GOTOOLCHAIN=go1.26.6 go build ./cmd/oa-chat
```

The initial local Go 1.26.5 vulnerability scan reported fixed standard-library
issues; use Go 1.26.6 or a newer patched release for native builds.
`govulncheck` with Go 1.26.6 reports no reachable vulnerabilities (one advisory
in an unused required module). Signing uses pinned `go-ethereum` v1.17.5.
The subsequent live acceptance below verifies the local signer on Sepolia.
The historical optional browser page had script coverage but was not visually tested;
its implementation and test script have since been removed.

## Live address-funding acceptance (2026-09-22)

The manual terminal flow passed on the pinned Sepolia deployment, with the
final observations on September 23 UTC. See the
[sanitized acceptance record](../packaging/validation/sepolia-address-funding.json).
The Go daemon was built with Go 1.26.6. The published companion's two patch
hashes matched this source, and all four proving/verifying assets matched the
live deployment manifest. This tests the existing `d33l4w2z2nh4cg` deployment;
the newer note-bound deployment uses different assets and was not substituted.

- `fund` created a fresh address with no external wallet connection. A separate
  test account minted and transferred exactly 0.100000 configured demo tokens
  to it; existing test accounts supplied 0.009 Sepolia ETH. The CLI waited for
  incoming funds and, after approval, correctly waited for additional gas funds.
- The local signer sent exactly one approval and one
  [deposit](https://sepolia.etherscan.io/tx/0x1a62f4d827a20db2876c2bb99a391d0572b82ed8b249564ec7c816493e656ee3).
  The receipt created note 58 for 100000 microcredits. Credits stayed inactive
  until the deposit's canonical block was finalized, then activated in full.
- Stopping both the funding command and daemon before finality, restarting,
  and rerunning the same command preserved the address, nonce, transaction hash
  and signed bytes. A conflicting amount was rejected. Unauthenticated address
  and catalog requests returned HTTP 401.
- One `openai/gpt-4o-mini` inference request passed through the required OA
  verified-lease path: HTTP 200, 40 content SSE events, first content at 6.595
  seconds, and `[DONE]` at 6.874 seconds. These are observed test timings, not
  latency guarantees. Exactly one durable key-handoff marker was created.
- Automatic settlement charged 29 microcredits, leaving 99971 (0.099971 test
  USDC). The pending flag cleared and the signed next state was saved. Another
  daemon restart and the same funding command preserved that reduced balance;
  the funding address still had exactly two outgoing transactions.

The default public relay failed its TLS handshake. This acceptance used a
temporary remote Wisp helper through loopback SSH forwarding, preserving
destination TLS without direct fallback. The helper and daemon were stopped
after validation; private funding/note state was retained outside the repository.
This is not a successful default-relay availability check. The existing wait
between independent leases remains; no mainnet, browser, withdrawal, or new
native-release validation was performed.

The run also exposed misleading Ctrl+C copy during an in-flight HTTP request.
Cancellation now says to rerun the same command, including for read-only address
lookups, without claiming the daemon or transaction stopped. GET/POST
cancellation and actual connection failures have regression coverage; all Go
race tests, vet and build passed, followed by a fresh review. The existing
flush-and-cancel test is timing-dependent for the response-body cancellation
branch; that narrow coverage limitation is accepted without adding a production
test-only injection seam.

## Reproducible companion and verification

The companion source is pinned to
[`OpenAnonymity/zkapi` at `20aa542ae98e767c0507133fd34b12a56f5ccd3d`](https://github.com/OpenAnonymity/zkapi/tree/20aa542ae98e767c0507133fd34b12a56f5ccd3d),
with protocol submodule `8b2d4e3da921f956e1eb6b93afbf722a877c060c`.
[`companion.patch`](../internal/zkapi/companion.patch) adds authenticated
bridge routes, single-use reservations, the verifier’s exact fingerprint contract, network pinning,
and installed proving-setup path support.
[`protocol-transport.patch`](../internal/zkapi/protocol-transport.patch)
removes persistent HTTP clients in the pinned protocol wallet. Both patches
are required and are verified separately against their exact source commits. Package `protocol/setup/v2` intact;
do not generate new proving keys for an existing deployment.

Validation performed on 2026-09-09 and 2026-09-10:

- Go race tests cover live SSE delivery before EOF, request preservation,
  cookie/header boundaries, origin and verifier-policy rejection, key nonreuse,
  funding capability/CSRF/rebinding checks, recovery file permissions, private
  secret minimization, receipt binding, and confirmation retries. Node tests
  exercise the MetaMask EIP-1193 flow, exact approval/deposit ABI, refreshed
  Merkle witness, and a network change during the final witness refresh.
- The patched Rust companion builds with `cargo build --release --locked --bin
  zkapi`; all 17 active library tests pass, including the verifier's fingerprint
  and bounded expiry contracts, original signed-expiry HTTP submission, shorter
  bridge lease deadline, demo-mint gating, bridge auth, and durable single-use
  reservations.
- The standalone server patch's focused tests preserve metered expiry/grace,
  prevent unactivated leases from becoming due, preserve the hard cap and key
  expiry, and verify idempotent finalized lease accounting. A processor-level test runs
  the real commitment update and Schnorr signer while a concurrent retry
  worker waits on the issuance lock; repeated settlement recovers the identical
  signed next state and charges the cap once under the proposal's assumed
  full-cap policy. This proposal is not suitable for the observed metered server.
- An isolated empty Sepolia wallet started with the real public manifest and
  pinned proving assets through the staging Wisp relay. The live Go status
  reported the correct chain and an unfunded, ready companion. Chrome displayed
  the local funding page with Sepolia, the configured deployment, and the
  MetaMask funding entry point.

The real Sepolia preparation endpoint also successfully created an isolated
private note recovery record. On September 10, computer use of the local page
progressed through MetaMask connection to the exact 0.100000 test-USDC allowance
prompt. The user approved an attempt, but Infura rejected its 21-million-gas
limit before broadcast. The corrected build now applies the gas preflight
described above. Browser security policy blocked control of the extension page
and prohibited alternate control paths; wallet confirmation remains manual.

The real Sepolia deposit succeeded and its existing transaction was recovered
after fixing wrapped-receipt validation. Activation initially reported a
0.100000-token private balance in both the local funding page and daemon.
Subsequent inference charges are recorded below. No second deposit was sent
during recovery.

An earlier end-to-end attempt after the gas fix connected Open WebUI to the running
Sepolia daemon, discovered all eight models, and made one unfunded request.
The browser correctly displayed “The private balance needs funding. Run
oa-chat fund.” The daemon still reported `funded: false`; this checks the
integration and funding-required error, not successful private inference.
See the [readiness record](../packaging/validation/openwebui-sepolia-unfunded.json).
The first funded Open WebUI attempt generated a valid proof and obtained an
active OA-backed lease, but native verification rejected the server's safety
margin between lease and signed-key expiry. No key was handed to Go, and the
lease settled with the private balance unchanged. That attempt is historical;
the bounded expiry fix was rebuilt and the funded retry succeeded.

**Funded end-to-end validation passed on September 10.** Open WebUI 0.11.3 used
`oa-sepolia.openai/gpt-4o-mini` through the Go daemon. The request started at
`2026-09-10T20:50:48.081Z`; first visible content arrived after 13.815 seconds,
with eight observed partial-content frames before completion at 15.277 seconds.
These browser timings include access preparation; they demonstrate incremental
delivery rather than buffering the complete response. See the
[successful streaming record](../packaging/validation/openwebui-sepolia-stream.json).

Independent read-only checks then followed the same lease. At
`2026-09-10T20:56:01Z`, the server reported `status: finalized`, usage 0.000723 USD,
and a 723-microcredit charge. The local balance matched exactly (100000 to 99277),
`pending` was false, and exactly one durable key-handoff marker existed. This
completes the tested funding → proof → verified key → streamed inference →
automatic settlement flow without an additional lease or inference request.

After that lease settled, one fresh independent API request also passed:
HTTP 200, 100 content events, first content at 7.081 seconds, and `[DONE]` at
7.843 seconds. Model catalog and local authentication checks passed as well.
See the [direct SSE record](../packaging/validation/sepolia-direct-stream.json).
This confirms raw SSE framing and completion separately from the browser's
visible-content observations; it does not remove the wait between leases.
At `2026-09-10T21:03:36Z`, this second lease was finalized with 0.000065 USD
usage and a 65-microcredit charge. The wallet balance changed 99277 → 99212,
pending cleared automatically, and the durable handoff count was two. Both
successful requests therefore completed their own issuance and settlement.

Mocked receipt tests remain unit coverage, distinct from this live chain result.
Rapid independent requests still require the settlement redesign above, the
ZKAPI deployment's OA-org staging status remains unknown. Withdrawal was not
implemented in the Go CLI at this September 10 revision; see the current
[CLI withdrawal flow](#withdraw-without-connecting-a-wallet) above. The deployed
verifier's 16-character fingerprint and signed-expiry safety margin are supported.
