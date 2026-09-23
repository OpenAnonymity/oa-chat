# zkAPI in the Go daemon

The Go gateway supports the prompt-private OA-org key path of zkAPI. It runs
an authenticated local Rust wallet/prover companion, obtains a verifier-backed
provider key without sending a prompt to the companion, and forwards the
original OpenAI JSON and streaming response over destination TLS through Wisp.
The Rust companion is needed because the deployed Groth16 wallet and recovery
implementation is Rust; this change does not claim to port those cryptographic
primitives to Go. See [CLI usage](CLI.md) and [packaging](CLI_PACKAGING.md).

## Network and funding

`oa-chat init --backend zkapi` selects Ethereum mainnet. Sepolia requires
`--network sepolia`; a chain mismatch fails before the companion starts. The
manifests are the existing deployment URLs:

- Mainnet: <https://d27v1dvkaxfc09.cloudfront.net/config.json>
- Sepolia: <https://d33l4w2z2nh4cg.cloudfront.net/config.json>

Both use their configured six-decimal ERC-20 billing token, not native ETH for
credits. ETH pays gas. The daemon verifies token decimals and the selected
network. Sepolia address funding requires the configured test-token transfer;
it does not automatically mint test tokens.

Run `oa-chat fund` while the daemon is running. It creates a local Ethereum
signing key once and prints its address, network, token contract and balances.
No external wallet, browser, Foundry installation, private-key input, or wallet
connection is needed. The key is internal client state; this does not remove
Ethereum's need for a signer or ETH for gas.

Send the displayed billing token (mainnet USDC, or the configured Sepolia test
token) and ETH on the displayed network to that same address. A transfer to the
vault itself does not fund a private note. Only the configured token counts;
tokens on another network do not become credits.

Run `oa-chat fund --amount 0.10` to authorize a 0.10-USDC private deposit. The
amount parser uses exact integer microcredits, accepts at most six decimal
places, and rejects zero/negative amounts and amounts over 1,000,000 USDC.
The command waits for funds and advances approval, deposit and activation;
Ctrl+C stops waiting without deleting state. Repeat the same command and
`--config-dir` to recover. Amounts cannot change while an attempt is saved.

The optional `fund --browser` page uses the same local signer. `--no-open`
continues to print a short-lived page URL. Opening/reloading/checking the page
and reading the address do not submit transactions. The deposit button is the
explicit authorization. The page never needs `window.ethereum` and never
receives the signing key or private-note secret.

The daemon reuses a sufficient token allowance or approves only the selected
amount, refreshes the vault's empty-leaf Merkle witness, and signs the exact
`deposit(bytes32,uint128,uint256[32])` call. Network and token-decimal checks,
gas simulation, gas/fee limits, and receipt checks fail closed. Signed bytes,
hash and nonce are saved durably **before** broadcast. Ambiguous submission
replays those same bytes, rather than allocating another nonce. Confirmation
must bind the vault event to the saved private-note commitment and amount.
Deposit activation waits for Ethereum's finalized block,
[typically around 15 minutes](https://ethereum.org/roadmap/single-slot-finality)
after mining; an unsupported finality response does not activate
credits. Approval can progress from a canonical mined receipt. Gas limits use
120% of the estimate plus 50,000 units, bounded by 16,777,216 units; legacy
EIP-155 transaction fees are capped at 300 gwei and 0.02 ETH per transaction.
These fees are additional to the token deposit amount.

Address funding is a source change after `daemon-v0.1.0`; that published release
still uses MetaMask. Historical funded Sepolia checks below describe that
older flow, not live validation of the new local signer.

## Privacy boundaries

The local API bearer key and the browser funding capability are distinct.
Funding capabilities expire after 30 minutes and travel in a URL fragment,
which the page removes before further navigation. API calls use an
Authorization header. Funding routes enforce the literal loopback host and
exact same origin; there is no wildcard CORS. The companion creates a fresh HTTP client for each remote call so neither
pooled connections nor a previous client's TLS state group independent
proof/lease requests. The companion authenticates every
route, including reset, health, and its upstream funding UI.

Every companion HTTP path, including manifest discovery, indexer reads, ZK
proof submission, lease issuance, and verifier submission, uses the daemon's
mandatory authenticated loopback CONNECT proxy. That proxy carries the
companion's destination TLS inside Wisp. Inference and all funding RPC calls
use the Go Wisp HTTP client. There is no direct transport fallback. The configured RPC and public chain can observe the
funding address, incoming transfers, approval, and deposit. Generating the
address locally does not make public funding anonymous; the private-note proof
and ephemeral inference-key boundaries remain unchanged.

The companion requires `direct_openrouter` and `require_oa_org_key_source`.
Before any key leaves the companion, the independently configured verifier
must return `status: verified`, the exact station ID, and a matching SHA-256
key fingerprint. The deployed verifier and OA Chat browser use the exact first
16 lowercase hexadecimal characters (eight bytes); a full 64-character lowercase
hash is also accepted and must match in full. Arbitrary truncation, a wrong full-hash suffix,
pending status, a mismatched origin, a wrong chain, and missing evidence fail
closed. The verifier validates the submitted raw key and signatures before
returning this response; its intentional 16-character fingerprint is compatible
with this daemon.

The signed key validity must cover the advertised lease expiry by zero to
60 seconds, matching the working browser SDK. The server deliberately subtracts
a 30-second safety margin from the key's expiry when advertising a usable lease.
Strict equality rejected an otherwise valid live lease after successful proof
and key issuance. The original signed expiry is still sent to the verifier;
the Go gateway receives and enforces the shorter lease expiry. This does not
extend either lifetime or loosen station, signature, origin, or key binding.

The wallet secret is written to a mode-0600 recovery file before a deposit is
sent. It never enters browser JavaScript. The browser receives the public
commitment and Merkle path; receipt validation binds the successful transaction
to the configured vault, commitment, amount, note ID, and expiry. The secret is
sent only to the authenticated loopback companion when activating the note.

MetaMask can wrap a deposit in a transaction whose outer recipient is its
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
API calls. Each verified lease is durably marked as handed out once before its
key is returned. A repeated or concurrent call receives HTTP 409 until the
previous private-state transition settles. This also prevents key reuse after
a crash or a lost local HTTP reply.

The successful September 10 request had approximately 4.5 minutes of usable
lease lifetime, followed by a five-second settlement grace period. The next
independent request waits for that signed private-state transition, even if
inference finishes much earlier. Open WebUI background title/tag/follow-up
requests also consume separate access and can encounter this limit. Immediate
repeat requests remain an unresolved deployment requirement.

**Observed billing is actual usage.** The successful streamed request settled
with `usage_usd: 0.000723` and `charge_applied: 723`, reducing the private balance
from 100000 to 99277 microcredits (0.100000 to 0.099277 test USDC). The pending
flag cleared automatically. Its advertised 0.05-USDC key limit was a cap, not
the debit. The earlier lease rejected by the local expiry check settled with
no balance reduction. These observations describe the tested Sepolia deployment;
do not infer another deployment's accounting from its key limit or source label.

The standalone, **not deployed**
[`server-early-settlement.patch`](../daemon/internal/zkapi/server-early-settlement.patch)
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
private configuration directory. It survives a browser close, service restart,
and an ambiguous on-chain response. The local signer also retains its key and
signed transaction journal in `funding/<network>/address-funding.json`. Resume
with the same `fund --amount` command. Back up the complete private config
directory before sending funds; neither OA nor the sender can recover a lost
local key. Never copy its secrets into support logs.

Legacy browser-funded deposits can still be confirmed with their saved
transaction hash in the optional funding page. A legacy pending record is
never silently replaced with a new local-signer deposit. A mistyped pending
hash can be replaced by a receipt that matches the private note; a mined reverted or unrelated transaction clears its retry
hint without deleting the secret.

Confirmation retries never reinitialize an already active note to its original
balance. Activated recovery records are retained and are archived with a
`.completed-<hash>` suffix once the companion has no active note and a new note
is prepared. Keep both the companion wallet directory and these recovery
records private and backed up.

The address-funding journal retains one authorized deposit. A finalized revert
can be retried explicitly with the same note secret and refreshed witness;
ambiguous transactions always retain their original signed bytes and nonce.
An activated journal whose companion note is missing requires recovery, not a
second deposit. This version does not provide a public-asset sweep command or
private-note withdrawal/refill workflow. Excess public USDC and ETH remain
controlled by the saved Ethereum key; preserve the full backup for recovery.

The current upstream wallet has one active note. Deposits do not increase an
active note in place. The Go funding page therefore refuses to overwrite an
active note. Withdrawing/closing an old note currently requires the upstream
zkAPI tooling; the Go daemon does not yet expose a withdrawal command. Preserve
its wallet state when changing to a separate funded state directory.

## Address-funding verification (2026-09-22)

The current change is covered by mocked JSON-RPC/companion integration tests:
address persistence and file permissions, wrong-chain/token checks, exact
signed calldata, approval/deposit ambiguity, restart and nonce rollback,
canonical/finalized receipt checks, reorg recovery, explicit reverted retries,
concurrent callers, and missing-note refusal. CLI tests exercise integer
amount parsing, read-only address display, explicit deposits and cancellation;
37 browser-script tests cover address-only loading, explicit authorization,
recovery, session expiry and balances without any injected wallet provider.

Run from `daemon/` with a patched Go toolchain:

```sh
GOTOOLCHAIN=go1.26.6 go test -race ./...
GOTOOLCHAIN=go1.26.6 go vet ./...
GOTOOLCHAIN=go1.26.6 go build ./cmd/oa-chat
node --test internal/zkapi/funding-ui.test.mjs
```

The initial local Go 1.26.5 vulnerability scan reported fixed standard-library
issues; use Go 1.26.6 or a newer patched release for native builds.
`govulncheck` with Go 1.26.6 reports no reachable vulnerabilities (one advisory
in an unused required module). Signing uses pinned `go-ethereum` v1.17.5. This change has not sent live Ethereum
transactions. Browser visual tooling was unavailable; script behavior was
verified automatically. Existing live-chain evidence below remains historical.

## Reproducible companion and verification

The companion source is pinned to
[`OpenAnonymity/zkapi-EF-collab` at `b89365f7050e376f55e489c4d60b623cf224a4d8`](https://github.com/OpenAnonymity/zkapi-EF-collab/tree/b89365f7050e376f55e489c4d60b623cf224a4d8),
with protocol submodule `e4efda23e6d416ee132938e4e67924fb0f7d4fe2`.
[`companion.patch`](../daemon/internal/zkapi/companion.patch) adds authenticated
bridge routes, single-use reservations, the verifier’s exact fingerprint contract, network pinning,
and installed proving-setup path support.
[`protocol-transport.patch`](../daemon/internal/zkapi/protocol-transport.patch)
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
See the [readiness record](../daemon/packaging/validation/openwebui-sepolia-unfunded.json).
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
[successful streaming record](../daemon/packaging/validation/openwebui-sepolia-stream.json).

Independent read-only checks then followed the same lease. At
`2026-09-10T20:56:01Z`, the server reported `status: finalized`, usage 0.000723 USD,
and a 723-microcredit charge. The local balance matched exactly (100000 to 99277),
`pending` was false, and exactly one durable key-handoff marker existed. This
completes the tested funding → proof → verified key → streamed inference →
automatic settlement flow without an additional lease or inference request.

After that lease settled, one fresh independent API request also passed:
HTTP 200, 100 content events, first content at 7.081 seconds, and `[DONE]` at
7.843 seconds. Model catalog and local authentication checks passed as well.
See the [direct SSE record](../daemon/packaging/validation/sepolia-direct-stream.json).
This confirms raw SSE framing and completion separately from the browser's
visible-content observations; it does not remove the wait between leases.
At `2026-09-10T21:03:36Z`, this second lease was finalized with 0.000065 USD
usage and a 65-microcredit charge. The wallet balance changed 99277 → 99212,
pending cleared automatically, and the durable handoff count was two. Both
successful requests therefore completed their own issuance and settlement.

Mocked receipt tests remain unit coverage, distinct from this live chain result.
Rapid independent requests still require the settlement redesign above, the
ZKAPI deployment's OA-org staging status remains unknown, and withdrawal is
not implemented in the Go CLI. The deployed verifier's 16-character fingerprint
and signed-expiry safety margin are supported.
