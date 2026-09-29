## 2026-09-29: Ask source links and malformed math labels

- Ask answers now use the same inline-link chip renderer as full replies, including streaming updates. Only links present in the answer are enhanced; plain domain names are not assigned guessed URLs. Structured sources still use the existing Ask sources footer. The screenshot alone cannot establish whether the original model returned linked or bare source names.
- Shared KaTeX rendering escapes otherwise-invalid ampersands inside balanced, plain `\text{...}` groups. Groups containing commands or embedded math, and expressions containing verbatim commands, are left untouched. Matrix alignment ampersands outside text groups and already escaped characters remain intact. The reported Gemini flow is covered with the actual bundled KaTeX parser; this is narrow recovery for malformed model output, not support for arbitrary invalid LaTeX. Trusted HTML remains disabled.
- The proxy retry control uses the same two-arrow SVG as Regenerate response. Its larger hit area is centered under the globe; the status text aligns with Network Proxy. Existing retry transitions and reduced-motion support remain, as does the orange unavailable globe. No proxy routing or fallback policy changed in this UI work.

## 2026-09-29: Verifier outage policy and send-path recovery

- Integration review: ban-shaped responses are rejected before all HTTP-status and advisory recovery paths, including HTTP 200. Page navigation preserves pending rows on `pagehide`; `pageshow` clears that state on Back/Forward restoration. A canceled `beforeunload` does not disable future error handling.

- `OA_VERIFIER_OUTAGE_POLICY` (build-time; `strict`, `tolerant`, `advisory`; the build default is `advisory`, unbuilt sources and tests default to `strict`) decides what happens when the verifier cannot approve a freshly issued key. `strict` is the previous behavior. `tolerant` continues on any outage (unreachable, timeout, 5xx, 429, pending or malformed reply) whatever the org's recently-attested flag, with the same bounded background re-verification; an explicit `unverified` verdict from a reachable verifier still blocks. `advisory` also continues on an explicit `unverified` verdict, without a retry queue (the verdict is final); the Activity Timeline says "Station not verified" and the key details say the verifier did not approve the key. A banned station (verdict or cached ban list), an expired key and a station/key mismatch block under every policy. Keys admitted this way are still never shared. Set `OA_VERIFIER_OUTAGE_POLICY=strict` on a deployment to restore blocking without a code change. See `chat/config.js` and `test/services/verifierOutagePolicy.test.js`.
- `fetchRetryJson` and the account JSON helper now keep the request deadline armed until the body has been read. A server that sends headers and then stalls fails with a `TimeoutError` (`isBodyTimeout`) at the configured timeout instead of holding the caller, and the ticket lock, indefinitely; a stalled `request_key` is not retried because the org may already have acted. Raw `fetchRetry` (streams) is unchanged. A stalled key request now reads "The key request timed out before the org finished replying. Please try again."
- A plain Enter while a send is in flight is ignored unless the composer holds text that differs from the submission in flight; an empty composer, or one still showing the just-sent text, never stops the request. Stop stays on the button and Escape. `chat/domain/composerKeys.js` holds the rule; `getPendingSend` is on the component facade for it.
- The relay `HTTPSession` is shared by every proxied request. A request's own abort (a fetch timeout, Stop, a session switch) no longer closes it while another relayed request is in flight, and no longer marks the relay as failed; a guard timeout (`PROXY_TIMEOUT`) still recycles the session. Before this, any aborted relayed request ended a concurrent completion stream with "The operation was aborted" and flipped the System Panel to "Unavailable". An interrupted stream that nobody stopped now reads "The request was interrupted before the model replied: the connection to the relay or the provider closed. Retry sends a new request."
- The assistant row for a turn is persisted (local-only, `pendingTurn: true`) before key acquisition and reused by the streaming placeholder. A reload before the first chunk therefore shows an interrupted reply with Retry rather than an unanswered user message; the row never enters model context, shares, memory or search. The first chunk clears the marker; an error, cancel or a turn that ends without a chunk removes the row (except during page unload, which keeps it for the next load). Retry sends a new request and may spend a new ticket.

## 2026-09-29: Guided CLI setup and automatic funding

- `oa-chat start` creates a missing configuration in the normal private OS
  directory and keeps existing valid configuration and wallet state. New
  guided configurations use zkAPI and ask for the network, offering Sepolia;
  advanced `init` still defaults to Mainnet. Explicit network flags must match
  an existing profile. Invalid or orphaned wallet state is never overwritten.
- `install.sh --setup --network sepolia` installs/updates the native pair and
  then runs the installed absolute CLI with its companion directory first on
  PATH. It needs no separate PATH/init/serve/funding terminal for the first run.
  Ordinary installation remains install-only. Active instructions target the
  follow-up `daemon-v0.3.0`; publication is pending at this checkpoint.
- Setup authenticates an existing daemon or starts and owns a foreground
  daemon. It never stops a foreign process. Without an explicit backend flag,
  an authenticated compatible running mode wins; otherwise the saved default
  is used. `--backend` selects a mode without rewriting the saved configuration.
  Startup waits through slow proof-file verification before declaring failure.
- Funding asks for a USD principal and one interactive authorization for the
  displayed fixed ETH amount and maximum fee. The terminal prompt reads
  `/dev/tty`; piped scripts, EOF, and blank confirmation cannot approve spending.
  Exact-amount quote refreshes retain wallet/network/deployment/commitment/nonce
  bindings. Setup checks for arriving ETH, approves a fresh quote only within
  the accepted fee ceiling, and waits for finalized activation. A fee increase
  requires renewed consent. Unsigned restarts ask again; signed restarts only
  recover the saved transaction. Lost responses require a successful journal
  read before any further recovery call; reverts never trigger a new deposit.
- Readiness checks model availability and its current native spending bound,
  settlement, and both local and companion-only withdrawal reservations. An
  existing note below the selected cap cannot be topped up in place. Setup
  prefers `openai/gpt-4.1-mini`, then the cheapest available model; `--model`
  overrides the readiness target. No test inference is sent or charged during
  setup. Ticket mode guides private-file import/redemption and checks models.
- The ready screen prints the API URL and an absolute, shell-quoted command
  to retrieve the local API key, without printing the credential. Owned services
  remain in the terminal; attaching to an existing service returns after checks.
  See [the guided walkthrough](../daemon/docs/CLI_ZKAPI.md#sepolia-from-installation-to-inference).
- Validation: full Go race suite/vet, Linux command cross-compilation, 26
  installer regressions, and fresh adversarial review pass. Review fixes cover
  companion PATH selection, slow-start readiness, and ambiguous recovery.
  Live Sepolia acceptance and release publication are being recorded separately.

## 2026-09-29: CLI 0.2.0 prerelease published

- [daemon-v0.2.0](https://github.com/OpenAnonymity/oa-chat/releases/tag/daemon-v0.2.0)
  was published at 14:58 UTC as a prerelease with 12 assets. Its source is
  `ef888242c36860ccf8ec176b2b1eb724cee77456`, the latest main when tagged.
  Subsequent main changes correct packaging validation and record evidence;
  the tag and original native artifacts were not moved or rebuilt.
- Original native builds and assembly passed; corrected package revalidation
  `36585685844` passed Nix on all four platforms, both macOS Homebrew services,
  Linux AMD64 Homebrew installation, and Arch makepkg. Every uploaded asset's
  digest matches the assembled artifact. The exact-tag one-command installer
  is now public and the active documentation points to it.
- Public HTTPS installation on macOS ARM64 passed real 0.1.0 → 0.2.0 → 0.2.0
  upgrade/reinstallation, preserving private configuration bytes/permissions
  and all prior bundles. Fresh Sepolia startup used the packaged companion and
  proofs without source-build overrides; 393 budgeted models, authentication
  boundaries, and a live $2 deposit quote passed. No additional funds were sent.
  The funded acceptance earlier today uses the unchanged runtime/patches.
- [Release evidence](../daemon/packaging/validation/daemon-0.2.0-release-20260929.json)
  distinguishes published-binary checks from the funded acceptance and links
  both CI runs. All temporary test services stopped cleanly.

## 2026-09-29: Release package revalidation

- The `daemon-v0.2.0` tag at `ef888242c36860ccf8ec176b2b1eb724cee77456`
  remains immutable. Its original release run `36582999421` passed all four
  native builds/installations and release assembly, but all package jobs hit
  a Nix 2.35 test-harness assumption: flake metadata can name a source path
  before materializing it. The harness now explicitly archives the flake
  before comparing its files; lock and payload checks remain intact.
- The read-only package revalidation workflow checks the original run/tag,
  successful build jobs, complete checksums, and all native source commits,
  then repeats the original four-runner Nix/Homebrew/Arch checks. It never
  builds, retags, or publishes. Publication remains gated on those checks.
  See [packaging](../daemon/docs/CLI_PACKAGING.md#building-a-release).

## 2026-09-29: CLI 0.2.0 prerelease preparation

- Selected `daemon-v0.2.0` for the native CLI prerelease. Current install links
  use its exact-tag `install.sh`; GitHub prerelease status is release metadata,
  while the binary and installer version remain plain `0.2.0`. Publication and
  public-download validation are pending at this checkpoint.
- The same one-command installer updates a prior managed installation under
  the same prefix, atomically switches the checked binary/proof bundle, and
  retains the prior release and separate private state. Stop the daemon before
  upgrading and restart it afterward. Existing compatible configs need no
  reinitialization. An old ERC-20 note cannot be migrated to the native vault;
  retain its matching client/recovery state separately.
- [The Sepolia walkthrough](../daemon/docs/CLI_ZKAPI.md#sepolia-from-installation-to-inference)
  now covers install/PATH/version, explicit Sepolia initialization, consistent
  `OA_CHAT_CONFIG_DIR` across terminals, quote/send/refresh/approve/finality,
  status, model budget discovery, and streaming inference. API credentials go
  to curl through stdin, and the guide distinguishes public ETH from private
  credit and documents the settlement wait before another independent request.
- Removed stale source-build-only guidance for the capabilities included in
  this release; earlier validation records remain historical. Release evidence
  must be added after the new native matrix and public installation checks.

## 2026-09-29: Compact Send Ethereum funding view

- Restored the compact deposit layout: Send total, address, QR, short funding
  status and Deposit button. A numeric Deposit / Fee allowance line uses USD
  estimates with exact ETH fallback. Fee allowance is the full `feeReserveWei`,
  including the optional buffer; it does not claim an actual fee was charged.
- The inline Transaction breakdown chevron replaces the deposit question mark.
  It starts closed and contains the transfer instructions, network, saved-deposit
  explanation, full balance progress bar and exact costs. The bar retains its
  continuous balance fill, required-total marker and optional-buffer hatch.
  Quote details keep their existing state across refresh/reload and remain open
  on outside clicks; withdrawal receipt question-mark help keeps its own behavior.
- The QR caption is Scan to pay. Waiting for ETH, the exact required shortfall,
  and Funds received provide compact status. Existing fresh-quote checks,
  optional-buffer readiness, cancellation reset and reload restoration remain
  intact. See [funding presentation](ZKAPI_PAYMENTS.md#payment-flow-feedback-2026-09-28).
- Validation: 162 focused tests and independent final-diff review pass. A 375px
  browser preview with a live Sepolia quote confirmed the compact closed view
  and the restored bar, required marker and optional-buffer hatch when expanded.

## 2026-09-29: Shared CLI setup, automatic budgets, and terminal funding

- One `oa-chat init` configures ticket and zkAPI capability. `serve --backend
  ticket|zkapi` selects the running mode without rewriting the saved default or
  touching the other wallet. Ticket commands remain usable in either mode.
  CLI status and wallet commands discover the authenticated running mode,
  including its network; an old saved default cannot redirect funding.
- zkAPI chooses the same reviewed coarse model buckets as the web: ticket tiers
  1/2 → $1, 3/8 → $2, 5 → $3, 25 → $4.50, 100 → $6. It requires the anonymous
  live model map and excludes disabled/unreviewed tiers. Untiered models in the
  public provider catalog use the web's fallback: opus/image names receive $2;
  thinking/instant/default/reasoning fallbacks all map to $1. Exact live
  assignments always win. Only the budget
  crosses companion bridge v3, never a model ID or prompt. An existing pending
  proof retains its original frozen quote and cap; switching models cannot
  reinterpret it. Legacy configured global caps are ignored.
- Funding is terminal-only; browser assets, capability routes, `--browser`, and
  `--no-open` are removed. `fund --amount ETH` or `fund --usd USD` prepares a
  durable fixed-principal quote. `fund --approve ID` authorizes that displayed
  quote; `fund --resume` recovers saved signed bytes. A USD refresh retains the
  original principal until the input is edited. ETH deposits use nine decimal
  places; public returns can use all 18.
- Low EIP-1559 fees match the web: pinned recent block/fee-history data, exact
  payable simulation with a balance override, required allowance, optional
  buffer, and exact remaining top-up after existing funds. Approval rechecks
  the operation, balance, and fees against its displayed ceiling. There is no
  fixed 0.02 ETH fee reserve. Optional buffer does not prevent proceeding when
  the actual required allowance fits. Quoting never signs or broadcasts.
  Withdrawal simulation must reserve headroom for the payout when the receiving
  address is the local signer: overriding it with the maximum uint256 balance
  makes the vault transfer overflow. Approval and signing use the real balance.
- `withdraw --to ADDRESS` prepares a full private-balance quote;
  `withdraw --approve ID` signs it. `fund return --to ADDRESS [--amount ETH]`
  prepares a public ETH return; omit amount only for an EOA sweep. Private notes
  and unsettled transactions must be resolved before returning their gas funds.
  Management operations require the owner credential, separate from the API key
  shared with inference clients. Back up the whole private config directory.
- See [CLI zkAPI](../daemon/docs/CLI_ZKAPI.md) for current commands and
  recovery. Earlier sections below describe historical implementations and
  acceptance runs; the previous native-flow result does not itself validate the
  new fee-quote flow.
- The new quoted flow passed live Sepolia acceptance: $2 fixed-principal deposit,
  runtime mode switching and signed-transaction recovery, a blocked $6 model,
  $1 model streaming during the verifier outage, signed 28-gwei settlement,
  and finalized 731555-gwei withdrawal. Restart/resume retained completion with
  no new nonce or active private note. Both actual fees fit the approved limits.
  The full Go race suite/vet, Rust checks, native installation and Linux/macOS
  installer CI passed. Public ETH return has automated coverage but was not
  broadcast in this run. See the [sanitized evidence](../daemon/packaging/validation/sepolia-cli-quotes-20260929.json).

## 2026-09-29: Payment feedback published to staging and Sepolia

- Both public apps now include the reviewed payment fixes from core
  `0e99a12e45aeac73539a335f9fb7a30f1f009bc2`.
- [Staging](https://staging.openanonymity.ai) uses Commercial
  `a84fb399ec3bfbc62644b902a0e28837382df0f2`, build `UVQ2UL6V`, deployment
  `dpl_7UaSuvpWUfhHsd7LS5ZN5bjoQuYa`. Its Git release and live verification
  workflows passed, including all nine public route/provenance checks.
- [Sepolia](https://oa-wallet-eth-sepolia.vercel.app) uses build `3V62H6JR`,
  deployment `dpl_4KV5LypB3hT63yjXBZbtxXzswiMC`. The Node 24 Vercel prebuilt
  output matched all 489 manifest hashes. An independent authenticated check
  matched ten deployed assets, including both proving keys and WASM, before
  promotion. The canonical URL then reported the same build and healthy API.
  An unfunded browser smoke test showed the new instructions, live fee/QR,
  disabled Deposit, and the restored address, open details and scrolled view
  after reload.
- Both retain `fresh-20260928`, their respective Mainnet/Sepolia vaults, the
  existing staging organization routes, and the pinned SDK/verifier policy.
  Sepolia's deployment error-log scan was empty. Release verification did not
  perform funded wallet transactions.


## 2026-09-29: CLI native ETH deployment and verifier outage parity

- The CLI source now embeds the fresh Mainnet/Sepolia manifests used by staging
  and the Sepolia wallet frontend. Companion source is `20aa542`, protocol
  `8b2d4e3`, and the circuit is `zkapi-v2-note-bound-v1`. Native principal and
  private balances are integer gwei; public ETH remains exact wei. Local
  funding submits one payable deposit, with no token approval.
- Companion state includes deployment ID; funding journals bind vault, asset,
  unit and scale. Legacy private notes are not migrated. Preserve old config
  directories and use their matching release. Prepared requests preserve the
  frozen quote and original cap across restart; settlement checks the same
  quote. That revision defaulted new requests to a $1 cap; the automatic
  model policy above now selects $1/$2/$3/$4.50/$6. Full details: [CLI zkAPI](../daemon/docs/CLI_ZKAPI.md).
- Both CLI backends support the browser's eligible verifier outage behavior.
  Recent attestation permits transport/gateway outage continuation; 429 and
  exact ownership-check errors follow the existing browser exception. Explicit
  refusal, bad bindings/signatures/origins and malformed responses fail closed.
  Outage keys remain unverified and produce fixed response headers and a safe
  foreground warning. Single-use CLI keys have no retained-session retry queue.
- Native macOS build/install/reinstall and independent source review passed.
  Live Sepolia finalized deposit, real SSE (40 content events), actual
  `verifier-unavailable` continuation, 409 key-reuse prevention, and signed
  28-gwei settlement passed. The 749972-gwei withdrawal mined with exact payout,
  treasury share, closed note and consumed nullifier. Withdrawal finalized at
  checkpoint 11805799; restart/repeat retained completion with no new transaction
  (chain nonce 2). No private note or pending settlement remains. Exact evidence:
  [native CLI validation](../daemon/packaging/validation/sepolia-native-cli-20260929.json).
  Deposit/withdrawal restart checks preserve signed bytes and nonce. Mainnet
  passed read-only startup/catalog checks; no Mainnet transaction was sent.
- Sepolia briefly returned `native_quote_expired` while a newer oracle round
  awaited finality. It recovered naturally without changing the 4500-second
  limit. A briefly underpriced saved withdrawal also mined without replacing
  its bytes. Preserve pending journals through both timing conditions.

## 2026-09-28: Payment feedback and reload continuity

- Funding choices are MetaMask / Send Ethereum. Manual funding gives explicit
  external-wallet send instructions, identifies this browser’s receiving address,
  explains fees above the deposit amount, and replaces Next with Deposit. Missing
  or insufficient ETH has visible status; cost details are shorter. Public
  leftover ETH returns stay distinct from private-balance withdrawal.
- Fee refresh retains the last estimate/QR and open help until a replacement is
  ready. The display snapshot never authorizes signing; expiry disables Deposit,
  errors suppress QR, edits discard it, and submission still validates a fresh
  quote. See [payment feedback](ZKAPI_PAYMENTS.md#payment-flow-feedback-2026-09-28).
- Both balance and first-time Welcome dialogs keep tab-local view/method/
  disclosure/scroll and safe amount-draft
  metadata until dismissed. Address amounts restore the existing durable ETH
  intent. Wait for the full address/fee layout before consuming restored scroll;
  a temporary loading screen can clamp it to zero. User interaction cancels
  deferred restoration. No restore submits a transaction or opens a wallet prompt.
- MetaMask cancellation clears only a provably unsubmitted matching SDK draft
  under its wallet lock; approvals, submitted/uncertain work and other-tab changes
  retain recovery. A seven-second notice returns to a fresh deposit form.
- Withdrawal labels no longer imply completion before the payout. Verified
  completion opens Payment history with brief confirmation; prepared withdrawals
  keep their destination across method switches. Missing USD uses exact ETH.
  Method switching clears transient feedback, never transaction journals.
- Validation: 1,024 core and 660 zkAPI tests pass; fresh Sepolia production
  build succeeds; independent final diff review approved. An unfunded local
  browser displayed live Sepolia fees/QR, preserved fee help across refresh/reload,
  and had no horizontal overflow at 375px. The final scroll recheck hit preview
  networking failures (RPC connection errors and missing same-origin proxy routes
  on the static preview server); browser-clamping regressions cover the fix in
  both dialogs. No funded wallet transaction or deployment was performed.

## 2026-09-28: Restore switched accounts in existing windows

- A completed username sign-in announces that its saved account is ready. Other windows discard old in-memory credentials and load the new account's non-extractable key bundle, verify the shared session, and activate its scoped ticket wallet without reloading or asking for a second passkey. Focus, visibility, and send preflight also reconcile the saved binding when a notification was missed.
- The existing “Restoring your account…” surface covers the handoff and closes automatically when restoration succeeds. Failed exchanges retain the pending-login security marker but return to manual sign-in, rather than leaving a permanent spinner. No prompt, response, or key material is broadcast.
- Ticket-mode send preflight now requires a verified, unlocked account and both scope and initial ticket-sync readiness, even if cached ticket counts look sufficient. Restoration never adopts the previous account's tickets.
- Staging's public manifest on September 28 reported chat `52b065b`, which predates the committed `f200994` banner removal. Its visible “Verification incomplete” warning is old deployed UI, not a new warning path in this checkout.

## 2026-09-28: Safe username switching and stale login windows

- Username sign-in now authenticates the requested account instead of rejecting it against the locally remembered username. Landing handoffs retain the old account until the native prompt succeeds and suppress that account's Google/legacy auto-unlock surface.
- Canceling the native prompt preserves the original session, keys, tickets and settings. Successful login publishes the new binding and non-extractable keys atomically, then activates the account's own ticket/preferences snapshot without adopting the old wallet.
- Shared-cookie exchanges hold the same origin-wide lock as encrypted sync. A persisted pending-login marker prevents old-account sync and key restoration after an uncertain response; a later successful authentication clears it. Other windows lock memory only and restore the new saved account automatically (see the follow-up above). See [username switching](USERNAME_PASSKEYS.md#switching-accounts-across-windows-2026-09-28).

## 2026-09-28: Verification outage notice placement

- The unavailable-verification timeline icon now places a small orange dot inside a neutral shield. Successful verification retains its checkmark; pending, interrupted, and rejected states do not acquire the outage dot. Typed verification events use the shield with custom verifier hosts as well as the default host.
- Removed the duplicate outage banner from single-model and Council key cards. The Activity Timeline heading is now "Verification not available"; its expanded explanation still identifies the key as unverified. Security Details retains verification status. Issuance, retry and rejection behavior are unchanged. This supersedes the key-card warning presentation described in the September 27 outage notes below.

## 2026-09-28: Compact funding instructions and clearer existing balance

- The funding screen leads with "Send" and the remaining amount including the
  optional buffer, after subtracting ETH already at the address. The entire
  balance bar and fee breakdown live in the question-mark panel, closed by
  default. The extra minimum-shortfall sentence is removed.
- The bar uses one continuous blue fill for the current address balance,
  including leftovers from earlier deposits. It no longer colors that balance
  as separate deposit/fee buckets. A required-total marker and hatched optional
  range explain the target; exact ETH/USD amounts and the cost breakdown remain
  available in the panel. Opening the panel persists through read-only refreshes.
- Readiness still requires principal plus the required fee allowance; incomplete
  optional buffer never blocks Next. See [funding behavior](ZKAPI_PAYMENTS.md#wallet-methods-metamask-and-send-to-an-address).

## 2026-09-28: Sepolia chat startup blocked by verifier TLS outage

- Around 21:15 UTC, investigation of a reported "Failed to fetch" on private
  chat startup identified a verifier outage that blocks new keys. Deployment
  health, manifest, tree snapshot, billing quote and public RPC checks passed.
  Browser requests to `verifier2.openanonymity.ai` failed, while independent
  workstation and Sepolia EC2 probes timed out during the TLS handshake.
  This failure precedes CORS checks; a frontend origin allowlist does not fix it.
- Fresh Azure diagnostics at 21:18 UTC reported both `oa-verifier` and
  `skr-sidecar` in `Waiting` with no start time, despite the container group
  reporting `Running`. A group `DeploymentTimeout` event occurred at 19:53 UTC.
  See [diagnostic run 36485142008](https://github.com/OpenAnonymity/oa-verifier/actions/runs/36485142008).
- The SDK verifies each newly issued key before allowing inference. A failed
  verification retains the prepared-request journal; preserve site storage and
  use the existing recovery path after service restoration. Do not bypass key
  verification. Mainnet shares this verifier and may also be affected; a funded
  Mainnet chat was not tested. Recovery was not confirmed at investigation time.
- Public deployment and asset-integrity checks alone do not establish live
  verifier or inference readiness. See [runtime troubleshooting](ZKAPI_PAYMENTS.md#private-chat-startup-troubleshooting).

## 2026-09-28: Optional funding buffer and address progress

- Send to an address separates the required transaction allowance from an
  optional fee buffer. Next requires the fixed principal plus the required
  allowance, not the entire recommended buffer. A rising recommendation can
  consume the already-shown budget without blocking or increasing authorization.
- The visible funding bar shows the public address balance against Deposit,
  Network fee and Optional buffer, with required and recommended totals. Once
  required funds are present, the QR and suggested top-up disappear even if the
  optional buffer is incomplete. Fee errors retain an independently checked
  address balance while suppressing stale payment instructions.
- The required fee allowance still covers the padded gas limit at a viable
  next-block fee rate, as required for upfront affordability; it differs from
  the estimated fee actually spent. See [funding behavior](ZKAPI_PAYMENTS.md#wallet-methods-metamask-and-send-to-an-address).

## 2026-09-28: ETH in balance details

- Native balance details show exact ETH beneath the existing USD available
  balance. The SDK's integer-gwei formatter preserves all nine ETH decimals,
  independently of the USD oracle; stale pricing leaves USD unavailable while
  ETH remains visible. Claimed balances use zero for both amount calculations.
- This is display-only, with no new price requests or wallet operations. See
  [native balance details](ZKAPI_PAYMENTS.md#native-balance-details).

## 2026-09-28: Actual historical Mainnet USDC fees verified

- The user supplied old Mainnet vault `0xef88012d1A7F9d44e5f5afB8bC5e611Dc3283709`.
  Etherscan shows 31 successful deposits: 6,769,348–6,798,742 gas each,
  effective prices 0.032632814–0.218146265 gwei, and approximately $0.42–$3.67
  per deposit using each transaction date's ETH/USD closing reference.
- The September 22 deposit of 2 USDC used 6,769,771 gas at 0.144245936 gwei:
  0.000976511954400656 ETH, about $2.69. The later native quote's sampled
  5.388380983-gwei effective rate is 37.36 times higher. Repricing that exact
  old deposit at the quote's rate/reference gives $98.29. The user's memory of
  much cheaper deposits is correct; network gas pricing explains the increase.
- Both exact Mainnet deployments link the same Poseidon library and have
  identical hashing source. These actual Mainnet transactions supersede the
  earlier reliance on Sepolia/mock-token comparisons for historical costs.
  See [Mainnet receipt comparison](ZKAPI_PAYMENTS.md#historical-mainnet-usdc-receipts-2026-09-28).

## 2026-09-28: Nearly $100 Mainnet deposit quote

- A later MetaMask screenshot still has a 6,759,269 gas limit, with 6.8453-gwei
  max base fee and a 0.1-gwei tip. At Mainnet block 26078062's 5.288380983-gwei
  base fee and the app's valid $2,694.5224 ETH/USD reference, using that full gas
  limit would cost about $98.14. This is an estimate, not a completed receipt.
- Prior controlled comparisons and archived Sepolia token/native receipts show
  slightly lower native gas consumption. Historical Mainnet USDC receipts were
  subsequently checked above. The expensive shared tree update and gas pricing
  explain the quote; changing the deposit asset does not remove the hashing cost.
- See the [quote investigation](ZKAPI_PAYMENTS.md#mainnet-metamask-nearly-100-fee-quote-2026-09-28).

## 2026-09-28: Immediate payment method selection and user-approved fees

- Payment method selection is local presentation state, independent of SDK
  provider activation. Read-only fee/price RPCs must not block switching between
  MetaMask and Send to an address. Explicit wallet actions and saved signed
  transactions retain serialization; stale reads cannot restore old UI state.
  Address quote preparation must activate and invoke the SDK in one synchronous
  turn: the SDK reads the chain/root through its captured provider even when an
  explicit sender is supplied. Stopped flow generations cancel delayed activation.
- Removed the address signer's fixed 0.02 ETH total-fee and 300-gwei price caps.
  They originated in the September 27 address-provider implementation, not an
  Ethereum rule. Keep validated fee data, protocol gas bounds, sufficient funds,
  and the user's exact approved quote allowance. Higher fees require a current
  quote and user action; they do not justify an arbitrary market-price block.
- Deposit screens omit repeated Mainnet/Sepolia labels and the network caption
  under MetaMask. QR payloads retain their chain ID; withdrawal/return destination
  labels still provide the network context needed for those actions.
- See [wallet methods](ZKAPI_PAYMENTS.md#wallet-methods-metamask-and-send-to-an-address)
  for provider activation, current fee policy and quote approval boundaries.
- Independent review passed 276 focused tests, including a real local-EVM
  high-fee deposit. A fresh browser without MetaMask displayed a live Mainnet
  quote/QR above the former fee cap and preserved the amount during rapid
  method switches. No funds or external wallet signatures were used in that
  browser check.

## 2026-09-28: Tinfoil DeepSeek V4.1 Flash catalog update

- Memory and Tab-Tab now offer `deepseek-v4-1-flash` instead of the stale `deepseek-v4-flash`, matching Tinfoil's public catalog. Tinfoil marks V4.1 Flash experimental; live inference quality has not been validated here.
- Existing unavailable-selection handling restores the feature default for saved V4 Flash selections (Gemma 4 31B for Memory, GPT-OSS 120B for Tab-Tab). Issuance, transport, and defaults are unchanged. See [Tinfoil configuration](local_inference.md#65-tinfoil-hosted-openai-compatible).

## 2026-09-28: Shared deposit amount and payment QR

- Balance and welcome funding screens put one USD/ETH amount control before
  the payment method choice. Method changes retain the exact integer-gwei
  principal or current edited draft; switching the display currency never
  reprices an already resolved principal. MetaMask amount entry does not create
  a local funding address. Saved SDK deposits remain authoritative.
- Address instructions render a local QR with the configured chain and exact
  remaining ETH transfer, including fees and subtracting the current address
  balance. Hide it with stale payment instructions on edits, quote failures,
  expiration or a fully funded address. The encoder is bundled; no remote QR
  service or private data is used. Its caption is simply "Scan to pay"; the
  redundant amount explanation underneath was removed. Decoder tests cover both networks.
- See [wallet methods](ZKAPI_PAYMENTS.md#wallet-methods-metamask-and-send-to-an-address)
  for amount persistence, quote boundaries and QR semantics.
- Regression coverage includes locking both dialogs before asynchronous price
  resolution, correcting field errors without stale accessibility attributes,
  retrying an initial price failure, and expiring the QR even while a balance
  read stalls. Independent review passed 168 targeted checks. Local browser
  checks confirmed exact amount/method/currency continuity, restored address
  intent, QR rendering, and no horizontal overflow at 375px. These checks did
  not connect an external wallet or submit a payment.

## 2026-09-28: Staging cutover to the fresh Mainnet deployment

- `OA_ZKAPI_DEPLOYMENT=fresh-20260928` selects reviewed public pins for either
  explicit network. The builder verifies the proof artifacts, replaces the
  public browser config, and updates SDK/outer integrity manifests together.
  The Vercel route generator resolves the same profile. Unset preserves the
  SDK defaults; no dependency, protocol or wallet-storage migration is added.
- Staging is deployed from `OpenAnonymity-FPL/oa-commercial`, not this repo
  directly. Its release updates the core gitlink and source-snapshot pin and
  selects fresh Mainnet in both Git and fallback build paths. The existing
  staging org, passkey relay and verifier policy continue to be used.
- The user explicitly requested a direct switch from old USDC staging without
  backward compatibility. No legacy route or automatic note conversion is
  introduced. Mainnet challenger funding remains deferred as previously agreed.
- See [fresh deployment details](ZKAPI_FRESH_DEPLOYMENT_20260928.md) and
  [build configuration](ZKAPI_PAYMENTS.md#build).
- Vercel evaluates a relocated bundle of `vercel.mjs` before installing the
  submodule's SDK dependency. Fresh profiles are static JSON imports so this
  phase needs neither SDK resolution nor source-relative filesystem paths.
  Proof/circuit checks still run against the actual emitted SDK assets before
  publication. Regressions execute relocated bundles without SDK access.

## 2026-09-28: Fresh Mainnet and Sepolia infrastructure

- User requested fresh latest-main zkAPI deployments with new Ethereum
  addresses on both networks. Two new isolated EC2 instances are provisioned.
  Both networks' contracts are finalized and HTTPS read-only acceptance passed.
  Mainnet deployment cost 0.009639044233442061 ETH of the funded 0.02 ETH.
  Sepolia's funded real-SDK normal-flow test passed deposit, issuance,
  verification, inference, settlement and finalized mutual withdrawal with the
  exact refund and treasury payout. This was a headless acceptance test, not a
  browser UI test or frontend cutover. Existing services and wallet recovery
  origins are preserved.
- The user explicitly deferred Mainnet challenger funding. Ordinary issuance,
  settlement and cooperative withdrawal do not require challenger gas; stale
  escapes cannot be contested until it is funded. Mainnet deployment completed
  within its funded 0.02 ETH balance, retaining 0.010360955766557939 ETH.
- Each network has separate owner/deployer, earnings treasury, challenger and
  protocol signing material. Only the treasury credential belongs in an
  earnings-only operator handoff; note closure pays earnings automatically.
- In the dynamic lease path, the legacy `request_charge_cap` value (50,000
  gwei here) is a minimum proof solvency. The actual lease ceiling is bound by
  `public.solvency_bound` and may exceed that value. Do not describe the legacy
  configuration field as a universal maximum request budget.
- See [fresh deployment record](ZKAPI_FRESH_DEPLOYMENT_20260928.md) for resource
  identities, credential locations, operational status and handoff details.

## 2026-09-28: Current Linux package runtime trials

- Docker on `rockypika` built current daemon source `d22c80d` into a fresh
  Linux AMD64 `0.0.0` validation bundle. Fresh source preparation reproduced
  Git 2.43 replacing the index during `git apply --intent-to-add`; applying
  both patches with `--index` fixes it while retaining exact full-source
  verification. The regression preserves unchanged tracked paths and passed
  Git 2.43/2.55; fresh build and Linux Go race passed.
- Actual Arch/pacman, Linux Homebrew, Nix profile, and real-HTTPS one-command
  installation trials passed. Arch and Homebrew managed user-service startup/
  shutdown passed, as did unmodified NixOS/Home Manager generated units in a
  minimal systemd container. Arch reinstall/removal, Nix generation refresh/
  removal, and installer reinstall preserved private state. Homebrew reinstall
  was not tested. Every route also passed automatic companion/proof discovery,
  unfunded Sepolia startup, private permissions, and joint shutdown.
- Native coverage is Linux AMD64 only. Nonhost archive slots used for manifest
  generation are explicit fixtures/cached artifacts; they do not certify
  macOS/ARM64 builds. Nix generated-unit checks do not certify a complete NixOS
  boot. No funded inference, transactions, or package publication occurred.
  Trial containers/images were removed and unrelated Docker workloads retained.
  See [Docker trial details](../daemon/docs/CLI_PACKAGING.md#rockypika-docker-package-trials-2026-09-28)
  and [sanitized evidence](../daemon/packaging/validation/rockypika-packages-20260928.json).

## 2026-09-28: Daemon distribution preparation

- Arch/AUR preserves the reviewed executable payloads (`!strip`), declares
  OpenSSL 3, and validates generated `.SRCINFO` against native makepkg output.
  Homebrew checks the companion/proof assets and adds the brewed OpenSSL
  library path to the Linux companion's RUNPATH. Both remain generated from
  actual native archive hashes; public tap/AUR publication is separate.
- Release assembly now emits a locked four-system Nix binary package, overlay,
  NixOS/Home Manager user-service modules, and standalone `oa-chat-nix.tar.gz`.
  Linux ELF paths are fixed with autoPatchelf. The daemon wrapper puts the
  bundled companion first on PATH; the companion stays unwrapped for its
  resolved `../share/oa-chat/proof-setup` lookup. Only public package assets
  enter the Nix store. Services require separately initialized private state,
  selected non-root users, and explicit login-start opt-in.
- The shell installer rejects NixOS with Nix-package guidance, rejects
  duplicate/noncanonical archive paths, preserves the service metadata, and
  prints restart guidance on upgrades. It still never initializes/funds a
  wallet, modifies shell profiles, or starts a service.
- Fresh companion preparation previously left the patch-added withdrawal
  source untracked, causing exact-source verification to reject every new
  release build. `git apply --index` now stages the complete patches, includes
  new files, and preserves unchanged index entries on Git 2.43. Preparation
  verifies both complete patches before returning.
  An offline regression exercises added files in the parent and submodule
  and rejects unexpected source changes.
- Release CI gates draft creation on native piped installation/reinstallation,
  manifest/payload checks, Homebrew validation, native Arch makepkg, and Nix
  package/module checks. Manual dispatch requires an explicit version and
  creates no release. See [release preparation](../daemon/docs/CLI_PACKAGING.md#building-a-release).
- These source changes do not replace the published `daemon-v0.1.0` binaries.
  A new reviewed tag/build and publication are still needed to distribute
  current funding/withdrawal, direct-network defaults, and logging behavior.
- Validation passed: 21 installer regressions on macOS/Ubuntu, 11 package
  regressions, preparation regression, Go race/vet, Bash/ShellCheck, workflow
  lint, and fresh review. Current macOS ARM64 source passed native build,
  piped install/reinstall, and Homebrew service lifecycle. New Arch, Linux
  Homebrew, and Nix packaging passed with real published Linux AMD64 archives;
  those mechanics checks do not certify current-source Linux behavior. The
  new four-platform CI matrix, actual Linux service boot, and funded inference
  remain separate. See [dated validation](../daemon/docs/CLI_PACKAGING.md#distribution-preparation-validation-2026-09-28).

## 2026-09-27: CLI package distribution status

- Homebrew and Arch/AUR manifests are generated from the native release
  archives with actual checksums. Public GitHub/AUR checks still found only
  the `daemon-v0.1.0` daemon prerelease, no official Homebrew tap, and no
  `oa-chat` or `oa-chat-bin` AUR entry. Publishing those package repositories
  remains separate from the draft-release workflow.
- The recorded macOS ARM64 Homebrew install/test/service lifecycle passed;
  Arch installation and Linux service boot remain unverified. Nix packaging
  is absent: no derivation, flake, service module, or Nix CI. See
  [packaging status](../daemon/docs/CLI_PACKAGING.md#nix--nixos).
- The published prerelease predates address-based funding/withdrawal,
  opt-in CLI relay defaults, and foreground status/logging. Package manifest
  generation does not publish newer source changes.

## 2026-09-28: Merge native ETH work into main

- User authorized merging the completed branches into each repository's `main`
  without PRs. OA Chat combines feature `dc25950` with main `fcf9ef8`, retaining
  main's CLI, account, verifier, wallet-entry and reload improvements. The
  source conflicts were in AccountModal, WelcomePanel, FundingSetupGuide and
  walletJourney; both branches' handoff history is retained below.
- Deposit validation still runs before wallet work. New native deposits convert
  USD to ETH; saved deposits use their exact persisted billing amount even when
  their approximate USD display is zero or unavailable. Confirmed deposits wait
  for the exact note's balance projection before exposing another funding form.
- Address subscriptions, balance polls and quote updates share main's disclosure
  animation queue. They retain new data while coalescing background renders;
  explicit amount edits still hide stale instructions immediately, and currency
  switches remain immediate. Regression tests cover the combined behavior.
- The SDK/backend main fast-forwarded to `20aa542`; protocol main merged at
  `f87d3c8`. Immutable SDK `cf56d67` and protocol `8b2d4e3` pins remain unchanged
  and reachable. The protocol merge changes only its README relative to the
  reviewed feature code, preserving native asset and historical-root challenge
  semantics alongside main's v2 overview.
- Post-resolution verification passed 1,549 OA Chat tests (1,001 application and
  548 payment), production builds for Sepolia and Mainnet, 305 SDK tests and
  asset verification, and 82 Rust plus 27 Solidity protocol tests. Independent
  adversarial reviews approved the app resolution and protocol merge. These
  checks do not constitute new funded browser or live challenge acceptance.
- This source merge uses the existing `[preserve-deployments]` commit marker
  to skip Vercel Git deployments. It does not perform a new infrastructure,
  contract or wallet transaction rollout. Existing Mainnet funding and live
  acceptance limitations in the preceding work remain applicable.

## 2026-09-28: Mainnet high-fee investigation

- User's pending MetaMask Slow quote was $26.45, with gas limit 6,759,269,
  max base fee 1.6097 gwei and tip 0.0001 gwei. At 14:22 UTC Mainnet base fee
  was 1.347259214 gwei and the finalized ETH/USD quote $2,682.88: the reported
  gas limit would cost about $24.43 if fully consumed at base plus that tip.
  The tip contributes only $0.0018. Base fee was 5.32× the prepublication
  gas-price sample, so the earlier assumption that expensive fees were
  Sepolia-only was too broad.
- No native-asset gas regression or new MetaMask fee override was found. The
  actual legacy Mainnet SDK uses the same gas-estimate padding and leaves all
  fee rates to MetaMask. Native skips ERC20 approval/transfer; old and new
  contracts share the same expensive Poseidon/Merkle code and linked library.
- Ten controlled same-environment tests found 6,090,717 gas for legacy mock
  token deposit versus 6,063,084 for native, with no extra deposit gas from the
  note-binding repair. Approximately 96% was root hashing in this fixture.
  These are not live USDC/receipt measurements or exact live opcode shares.
- Equivalent hashing optimization needs differential proof-format tests and a
  new vault rollout; reducing a wallet gas limit does not reduce contract work.
  No runtime, fee setting, contract or wallet was changed by the investigation.
- At 14:29 UTC the same gas-price rise put the challenger's 0.005 ETH below
  the installation readiness allowance: 10M gas at 1.565704917 gwei requires
  0.01565704917 ETH. The daemon sets its transaction gas limit to the estimate
  plus 20%, so this is a reserve gap, not proof every challenge would fail.
  The vault had zero balance/notes and no pending challenges; checkpoints advanced. Readiness
  funding is checked at installation, not continuously by service health.
- Full timestamped arithmetic, source provenance and measurement limitations:
  [Mainnet fee investigation](ZKAPI_PAYMENTS.md#mainnet-metamask-2645-fee-investigation-2026-09-28).

## 2026-09-28: Native ETH Mainnet public deployment

- User explicitly authorized public Mainnet deposits after funding 0.005 ETH
  each to the deployer and dedicated challenger. This supersedes the earlier
  deferral; do not ask for activation approval again. No PRs are requested.
- Native vault `0x9e5570ae0F1FCB087c2dD0eac521aC067a6b6F42` (block 26074671)
  and adapter `0x7C530D1eeab639FB78DAefCEdb4E0AA046727898` (block 26074584)
  are finalized. Exact runtime, constructors and public signing identities
  match. Total receipt fees were 0.001069970517280939 ETH; finalized deployer
  balance was 0.003930029482719061 ETH, nonce 2. The two CREATE transactions
  completed the authorized contract work; do not replay their signed journals.
- Mainnet backend is live at `https://d3hmaz52qw22t.cloudfront.net`, using
  backend source `2e9647c`, protocol `8b2d4e3` and immutable image `d833ea7c…`.
  Deployment ID is `zkapi-native-eth-mainnet-note-bound-v1-20260928`, with
  independent keys, data and challenger state. Its native ETH manifest, server,
  indexer root, proof hashes and finalized ETH/USD quote passed live checks.
- Dedicated challenger `0x667F2BB2aC6f56516B2e064B8be91526E86A6fF3` retains
  0.005 ETH. Startup checkpoint advanced to 26074834 with no pending obligations;
  the startup 10M-gas fee liability was 0.00183578607 ETH. Before publication,
  checkpoint reached 26074894, still with zero pending obligations and the full
  reserve; the refreshed maximum fee liability was 0.00253192496 ETH. Health alone does
  not establish funding adequacy; monitor fees, obligations and reserves.
- Mainnet CloudFront `E301WJL60HXXBI` now uses authenticated HTTPS through
  `/mainnet` on the existing TLS origin, retaining disabled caching, all query
  strings and required methods. Six missing/wrong/cross-network credential
  checks passed. Private signer/environment/dashboard endpoints return 404.
- The shared TLS service was intentionally recreated; existing Sepolia and
  legacy application containers/state were preserved. Independent public checks
  at 08:50 UTC found native Sepolia and legacy Mainnet builds/configs unchanged,
  with both backends healthy. Retain `oa-wallet-mainnet.vercel.app` and its USDC
  deployment for old wallet recovery; do not reinterpret old notes as ETH.
- Runtime installation required two reviewed validation repairs: canonicalize
  Docker mount array ordering, and run the disposable nginx check as the actual
  gateway user 101:101. The first failure preceded installation; the second
  preceded service startup. Original journals and all installed secrets/state
  were retained. Final installer SHA-256 is `9cde6ca9aa82300c372bf8fdf9cae69646da92e2897a0dde62ac4112bfb0db3f`.
- SDK Mainnet pins and guard removal passed fresh review and focused tests.
  Both app package files now pin `cf56d67e0c1dd4bc3f3c32392478ce242c746446`
  from `OpenAnonymity/zkapi`; installed dependency resolution matches.
  Mainnet is published at `https://oa-wallet-eth-mainnet.vercel.app`, app
  `c81405722608a32f2883c115a8ed8e522e6ba12b`, build `K2DVDIBU`, Vercel
  `dpl_EfvfCXhrcPYR5DVh8aQ8UCb5HXso` (READY). All 1,400 app tests pass.
  Independent canonical verification matched all 486 published file hashes,
  native config/trust checks, API identity and finalized billing quote. The
  Mainnet migration guard is absent. Canonical unfunded browser smoke passed
  both choices, ETH/USD totals, collapsed help and disabled Next. Four unit
  switches took 9.3–15.5 ms without changing principal. Exact custom ETH amount,
  input denomination and address survived reload and full browser restart.
  No uncaught page errors occurred. A bounded reopen/reload reproduced one
  handled proxy-preference sync warning: disabling was prevented while requests
  were active (`chat/app.js` catches this warning). Funding/recovery stayed
  correct. Two earlier console errors did not reproduce and lack retained
  message text; do not claim a completely clean run or verified proxy reliability.
- This remains an experimental, single-party proof setup with unaudited
  integration and incomplete live escape-challenge acceptance. No Mainnet paid
  browser transaction has been tested. The vault is unpaused and has no TVL cap;
  pausing also blocks mutual close and escape initiation. Never rewind durable
  state or stop challenge coverage while notes/leases remain active.
- See [deployment evidence and funding clarification](ZKAPI_NATIVE_ETH_DEPLOYMENT_20260927.md#mainnet-preparation-resumed-2026-09-28).

## 2026-09-27: Follow-up rollout and live Sepolia acceptance

- User authorized deploying the merged backend and fresh funded Sepolia
  acceptance. Google login is explicitly out of scope for this follow-up.
- At that stage, user chose to leave native Mainnet guarded after reviewing
  the experimental deployment funding requirements. The September 28 request
  above resumes preparation; it does not establish completed deployment.
- Merged backend `2e9647c` is deployed on existing native Sepolia infrastructure,
  immutable image `d833ea7c…`; source rebuild, runtime hashes and preservation
  checks passed independent review. Vault, keys, state, signer/TLS and legacy
  stack were retained. Never rewind live data as part of image rollback.
- Fresh canonical browser acceptance passed deposit/restart/real inference/
  signed settlement/withdrawal. Usage $0.007471 became 2,816 gwei at the frozen
  quote; note 5 closed with 742,068 gwei returned. A browser restart during
  withdrawal confirmation recovered the same receipt without another nonce.
  Separate ref-based automation lost focus across polling renders; synchronous
  normal input/change/click handlers succeeded, with no source bug established.
- Live isolated challenge acceptance was stopped by automatic safety review
  before lease issuance or any escape transaction; it has not passed. Note 7
  closed normally. A later safety rejection also blocked ordinary note 6
  cleanup after the saved quote expired: 753,607 gwei remains controlled with
  its exact prepared request, no issued key and no pending escape. Preserve the
  protected recovery bundle; do not drop that journal without the SDK/server
  expiry acknowledgement. The test EOA retains 0.027933169397001076 ETH.
  Local challenge regressions pass but do not establish live daemon acceptance.
  These unfinished test/cleanup limits are explicit in the deployment record.

## 2026-09-27: Merge the zkAPI review repairs into native ETH

- Merged incoming review branch `2eda8f3` into native SDK/backend commit
  `2e9647c`, now pinned in both app package files from `OpenAnonymity/zkapi`.
  The merge preserves native protocol `8b2d4e3`, vault/config pins, request-bound
  OA issuance, active-lease challenge evidence and native billing recovery.
- Incorporated proxy concurrency coordination and durable direct OpenRouter
  retirement. A merge-specific regression protects challenge evidence during
  retiring/disabled/revoking phases. These optional-mode limitations and all
  review acceptance results are tracked in
  [review merge acceptance](ZKAPI_REVIEW_MERGE_20260927.md).
- Exact deposit confirmation is now independent of subsequent worker/status
  refresh: durable success returns `confirmed` with `balanceRefreshPending` when
  needed, publishes history/plan clearance, and ordinary polling recovers display.
  Pre-commit worker/indexer/storage failures remain errors. Welcome/account
  dialogs keep a transient exact-note refresh guard: no false zero/ready copy
  or new funding quote appears until that note's projection arrives.
- Pending submitted deposits and indexer lag now use recoverable status instead
  of failed activity. Real reverts and note mismatches stay errors. Collapsed
  funding help explains that account/Google login is optional; default screen
  density, currency switching and signing rules are unchanged.
- Validation: 1,400 app tests (886 core + 514 payment), 305 SDK tests, 141
  integration Rust tests, 82 protocol Rust tests, 27 Solidity tests, two real
  shipped-WASM proofs, 11 signer tests and four launcher tests pass. Fresh
  independent reviews approved both final diffs; Rust formatting/Clippy pass.
- Published frontend: app `5255a23`, SDK `2e9647c`, build `IPB766G3`,
  deployment `dpl_B7BXWut3W6uYnupsjwX3CAacAzjo` on the canonical native Sepolia
  origin. All 486 file hashes match and four public endpoint checks return 200.
  Canonical browser checks passed; four unit switches took 8.2–17.6 ms with
  unchanged exact principal, no page errors and unfunded Next disabled.
  At frontend publication, AWS/backend/contracts were unchanged and optional
  backend changes were only merged/tested in source. The follow-up above now
  records the merged backend rollout and fresh browser acceptance.
- Do not confuse the newly merged ERC20 AWS/CLI acceptance examples with this
  native deployment. Full Google login and native Mainnet publication remain
  outside the completed acceptance coverage.

## 2026-09-27: Immediate deposit currency switching

- Currency switching waited for `AddressDepositFlow.check()`, including public
  balance reads and sometimes a full fee simulation. The unit input now updates
  after local persistence, with chain checks continuing in the background.
- A just-edited draft uses the loaded, SDK-validated ETH/USD price and skips its
  fee check before switching. This avoids a second blocking price request and
  duplicate fee work. Missing or stale pricing reports immediately; it never
  substitutes an old price or changes an existing principal to force conversion.
- Atomic intent comparisons, exact ETH principal, and the fresh fee/readiness
  checks before Next remain required.
- Validation: 886 core and 495 payment tests pass (1,381 total), including
  unresolved RPC tests proving switches finish before balance/fee responses.
  Fresh adversarial review approved the diff. Browser measurements were
  11–18 ms for six repeated switches (same exact principal) and 6 ms for
  editing an ETH draft immediately before switching; the previous build's
  sampled switch took 516 ms even with a fresh fee quote.
- Published on `oa-wallet-eth-sepolia.vercel.app`, app `1b5252b`, SDK
  `6f12f3b`, build `5TAGD2MP`, deployment `dpl_GhCDeBXNj3eDamsQr7HEos9nGzyp`.
  All 486 artifact hashes match and all four public config/health/quote checks
  returned 200. Four canonical browser switches took 9–18 ms, preserved the
  original USD input and produced no alerts. No transaction was signed.

## 2026-09-27: USD/ETH entry for address deposits

- The amount input has a USD/ETH currency button. ETH input accepts up to nine
  decimal places, matching the private ledger's whole-gwei units. Switching
  units preserves the exact saved ETH principal; only an explicit amount edit
  creates a new principal. Input currency and value live in the existing
  browser-only, chain/vault/address-scoped deposit intent, outside account sync.
- The prominent ETH amount to send also shows its current approximate USD
  value. This values the remaining transfer including fees and buffer, after
  subtracting ETH already at the funding address. Fee details stay behind the
  question mark. A missing price never substitutes a made-up zero USD value.
- Unit-specific input IDs prevent a focused USD node from being reused as an
  ETH field. Currency-button focus survives polling; pending amount edits are
  resolved before switching, and saved SDK deposits keep their amount locked.
  Older intents without a currency field remain readable.
- Currency-only updates and legacy-intent migration compare and write inside
  one IndexedDB settings transaction. A stale tab cannot overwrite a newer
  principal while saving its selected unit. Failed comparisons require reopening
  the screen; explicit amount edits keep the existing durable write path.
- Validation: 886 core and 490 payment tests pass (1,376 total), with fresh
  adversarial approval. Browser checks cover exact ETH/USD round trips, restored
  input currency, mobile layout, immediate removal of stale transfer instructions,
  invalid precision, and concurrent settings writes using real IndexedDB.
- Published on `oa-wallet-eth-sepolia.vercel.app`, app `f860264`, SDK
  `6f12f3b`, build `4YKO3YLN`, deployment `dpl_4jLxYSYEKeE61reyJEKG6iD3ULbN`.
  All 486 live artifact hashes match; public config, health and billing quote
  checks returned 200. The canonical browser confirmed visible USD totals,
  closed fee help, and an exact 0.002 ETH → USD → ETH round trip with no errors.
  No transaction was signed for this UI release; the backend and gas policy
  are unchanged.
- See [payment details](ZKAPI_PAYMENTS.md) for conversion and recovery behavior.

## 2026-09-27: Compact send-to-address deposit screen

- The deposit screen emphasizes the exact ETH still needed and the funding
  address. The USD input, network, Copy, brief funding status and Next remain
  visible. Principal, estimated fee, buffer, existing ETH and total appear only
  after clicking the question-mark help beside the send amount.
- Fee explanations and browser/ETH-value context live inside that disclosure;
  the Low policy remains active without slow-confirmation explanatory copy.
  Blocking errors and saved-deposit constraints remain visible. Pricing,
  polling, fee authorization and signing behavior are unchanged.
- Help is a keyboard-accessible click disclosure, not hover text. Outside
  click dismisses it; the first Escape closes help and the next closes the
  dialog. Open state and toggle focus survive balance and quote refreshes.
  While the quote refreshes, open help shows a loading state instead of stale
  payment amounts or Next. Closing the dialog or changing wallet method resets it.
- Validation: 129 focused funding/recovery/UI tests pass. Fresh adversarial
  review approved the final diff. Actual browser checks covered collapsed and
  expanded details, keyboard and outside-click dismissal, a full fee-quote
  refresh with retained focus, and desktop/mobile amount layout.
- Published on `oa-wallet-eth-sepolia.vercel.app`, app `f9ee03f`, SDK
  `6f12f3b`, build `SXHXD7RB`. All 486 live artifact hashes match, all four
  public config/health/quote checks returned 200, and the canonical browser
  confirmed closed-by-default details, click expansion and removed slow copy.

## 2026-09-27: Native ETH versus earlier token gas comparison

- Fresh canonical Sepolia receipt comparison found no asset-switch gas
  regression: earlier address/token deposit used 6,753,103 gas and paid
  0.007452555980880150 ETH; native deposit used 6,742,196 gas and paid
  0.007151174818090856 ETH. Earlier MetaMask/token deposit used 6,897,262 gas
  and paid 0.007803390250469292 ETH. These are our recorded test transactions,
  not a claim about an unidentified user transaction or historical Mainnet fee.
- Both assets share unchanged, expensive on-chain Merkle/Poseidon hashing.
  Deposit does not verify a Groth16 proof. Controlled current Forge tests
  attribute 95.68% of native deposit gas to root hashing; native avoids ERC20
  transferFrom and approval. Optimizing equivalent hashing is the meaningful
  contract cost target; switching back to tokens does not remove it.
- Sepolia and Mainnet gas markets differ. A simultaneous read put Sepolia at
  about 10.7x Mainnet per-gas cost; this is a timestamped observation, not a
  fixed ratio or Mainnet deployment quote. The funding UI applies the ETH/USD
  reference to test ETH too. A follow-up should label Sepolia dollar amounts
  explicitly as test/reference values, not real Mainnet costs. Keep expected
  fees distinct from the additional buffer and total requested transfer.
- Details, transaction links, benchmark limitations and sampling timestamps:
  [ETH/token fee comparison](ZKAPI_PAYMENTS.md#native-eth-versus-token-cost-comparison-2026-09-27).

## 2026-09-27: Low fees for the address option

- New address deposits, withdrawals and public returns share a Low fee policy.
  Tip = integer median of 10th-percentile rewards from nonempty blocks within
  the latest 20 blocks, floored at 0.001 gwei. Maximum price uses 1.25x current base fee plus
  tip, replacing 2x headroom. Gas-limit padding and signing caps are unchanged.
- Fee history is pinned to the sampled latest block with exact window/base-fee
  checks and a 120-second age limit. Malformed/unavailable history fails closed;
  there is no fallback to an expensive generic RPC tip. An all-empty valid
  history uses the minimum tip. Quotes and actual signing use the same policy.
- The Low fee policy can take longer. Existing signed journals replay unchanged,
  even if created under the earlier pricing policy. No automatic fee bump or
  wallet connection is introduced; MetaMask continues to choose its own fees.
- This mainly lowers the maximum amount requested at current Sepolia prices:
  the previous test's 0.001-gwei tip was already only 0.0943% of its actual fee.
  Do not promise a 37.5% reduction in the charged fee; that comparison applies
  to the maximum allowance when base fee dominates, not the receipt charge.
  See [payment details](ZKAPI_PAYMENTS.md) for policy and primary references.
- Validation: 886 core + 454 payment tests pass (1,340 total), including 63
  provider/real-EVM checks. Fresh adversarial review approved the final change.
  A same-block Sepolia comparison at block 11797083 reduced the maximum fee
  reserve from 0.01565140231992339 to 0.009785179194182595 ETH (37.48%) for
  the same gas limit and unchanged 0.001-gwei tip. This is a read-only quote
  comparison, not a claimed reduction in the actual transaction charge.
- Published at `oa-wallet-eth-sepolia.vercel.app`, app `bfe09cf`, SDK
  `6f12f3b`, build `VUJXGHPE`; independent verification matched all 486 live
  artifact hashes and returned 200 for config, health and billing quote.
- Live Low-fee withdrawal succeeded at Sepolia block 11797127 with nonce 4,
  maximum fee 1.292962397 gwei and tip 0.001 gwei. Two fee-shortage refusals
  occurred before signing; explicit controlled test top-ups and retry resumed
  the same authorization. One transaction returned the retained test principal,
  paid 0.007545454436185302 ETH and left 0.006438321354938754 public test ETH.
  See [deployment evidence](ZKAPI_NATIVE_ETH_DEPLOYMENT_20260927.md).
- Known preexisting UI follow-up: five-second address-status refreshes reset
  the withdrawal acknowledgement checkbox. It fails safely by disabling the
  action, but can interrupt slower users. Preserve acknowledgement only across
  read-only refreshes for the same note, wallet method, withdrawal mode and
  destination; reset it on context changes and dialog closure. Independent
  review accepts this usability limitation for the fee-only release.

## 2026-09-27: Browser custody and native ETH funding (Sepolia live)

- Native address deposits now prepare a durable SDK note draft and simulate the
  actual payable call before funding. The screen separates private principal,
  estimated network fee, additional fee buffer and total ETH to send, subtracting
  ETH already at the public address. Quotes last 30 seconds; balances poll every
  five seconds. The configured Sepolia RPC supports sender-balance-only state
  overrides for `eth_call` and `eth_estimateGas`; unsupported RPCs fail closed.
- Next forces a new quote and checks the durable amount again. A larger fee
  allowance requires another explicit click; the signer is bound to the prepared
  operation, commitment and displayed fee ceiling. Receipt-backed actual fee is
  saved with deposit history and the remaining public ETH is polled separately.
  Tiny leftovers remain possible; the estimate does not promise an exact charge.
- Dynamic-quote validation: 886 core + 448 payment tests and 298 SDK tests pass,
  including unfunded state-override simulation on a real local EVM, pre-sign fee
  rejection, exact remaining-balance arithmetic, concurrent edits, browser-state
  reloads and saved-plan method switching. Fresh adversarial review approved
  the final source after fixing MetaMask-to-address intent reconstruction.
  SDK pin: `6f12f3b520989d24c50fbeee33b4c42b761d5651`.
- Dynamic quotes are live on `oa-wallet-eth-sepolia.vercel.app`, app `ca008e6`,
  SDK `6f12f3b`, build `PE25UOAE`. All 486 published hashes were independently
  verified. The real deposit quoted 0.0072093324245628 ETH expected fees and paid
  0.007151174818090856 ETH. Exact displayed funding, existing ETH reuse,
  pre-sign retry, browser closures before/after submission, one confirmed
  transaction and persisted actual-fee history passed. The conservative buffer
  still left 0.010249061230859864 public test ETH; do not promise zero/tiny dust.
  Full evidence and retained test balances are in the deployment record.
- User confirmed: hold ETH and show its floating current USD value, rather than
  fixed USD credit. Native ETH requires new vault/server/SDK deployment pins;
  the existing live ERC20 vaults cannot accept payable ETH deposits.
- New local funding accounts use a non-extractable AES-GCM browser key committed
  atomically with ciphertext in IndexedDB. No password, backup or lock step.
  V1 accounts fail closed until one-time conversion preserves their key/journal.
  Same-origin scripts can use browser custody; clearing site data loses access.
- `AddressDepositFlow` owns only the local funding intent and read-only five-
  second polling. Dollar input produces exact gwei/ETH principal; it stays fixed
  across reloads and price movement. Principal plus maximum network-fee reserve
  is shown before transfer. Next rechecks funds and durable intent, then allows
  the signer one native payment. A changed input immediately invalidates Next.
- The 0.02 ETH ceiling remains a signing safety limit, not the prefunding amount.
  Expected fee uses simulated gas at current base fee plus tip; the buffer is the
  difference up to SDK-padded gas at the EIP-1559 maximum fee. Signing rechecks
  gas/fees and expires the authorization before any signature if the quote is
  stale. At signing, fresh EIP-1559 headroom is clamped to the already approved
  total allowance while still covering the next-block minimum plus tip. This
  lets the buffer absorb modest increases without silently raising its cap.
  SDK quote drafts never become pending deposits until explicit Next.
- Definitely unsubmitted prepared deposits can re-enter the same quote screen
  with a fixed principal after reload or a pre-sign failure. The SDK alone
  declares this state safe; host UI never infers it from missing public hashes.
  Switching from a MetaMask-created prepared plan reconstructs the host intent
  from the SDK's exact gwei amount; absent original USD is shown as a saved ETH
  amount with current USD reference, not invented dollar input.
  Ambiguous address retries first review status and explicitly prepare an exact
  retry without submitting; they then show fees for the original saved path.
  Signed transaction recovery continues to replay only the journaled bytes.
  MetaMask keeps its existing flow.
- Fee/affordability failures retain a fixed public-only explanation after SDK
  withdrawal bookkeeping replaces its generic error copy. The exact additional
  ETH, address and chain come from the current signing check; the retry remains
  explicit. Only the same originating Error object can receive this explanation,
  and it is scoped to action memory rather than persisted.
- Public ETH return remains a collapsed action for an existing usable funding
  address even after the private note closes. Its availability must not depend
  on a USD quote or a successful public-balance poll: stale price feeds must
  not hide access to residual ETH. Public-return journals intentionally remain
  pending until the receipt block is Ethereum-finalized; explicit status checks
  explain this wait and retain the exact signed bytes until it completes.
- Signer/provider recovery stays separate from SDK note recovery. No page load,
  quote, balance check, method hydration or arrival of ETH signs or broadcasts.
  Signed bytes are durably journaled before broadcast and replay exactly only
  after an explicit recovery action. Cross-tab locks and nonce guards remain.
- Public deposit intent uses `chatDB` settings with chain/vault/address scope;
  account synchronization has an explicit allowlist that excludes these keys.
- Provider adversarial review found and fixed native deposit authorization
  allowing multiple payments in one action, and stale cached custody after an
  IndexedDB read failure. All 45 provider tests pass, including local EVM value
  transfer and journal recovery; UI/actions and interruption controller tests
  also pass. The independent native protocol review approved 268 SDK tests,
  52 server tests, native vault tests and the real proof/settlement fixture.
  Live Sepolia deposit, recovery, chat, settlement and withdrawal now pass;
  see the deployment record below for remaining test boundaries.
- USD references use the latest finalized Chainlink round with a pinned
  4,500-second freshness limit, so they may lag the chain head. New leases
  reject superseded finalized quotes; accepted leases retain their original
  conversion. Exact unaccepted-request acknowledgment gates journal replacement.
  Sepolia live testing saw a brief hourly quote outage when heartbeat plus
  finality delay exceeded 4,500 seconds: 409/native_quote_expired recovered
  automatically with the next finalized round. No cache flush or pin relaxation
  was needed. Existing withdrawal/return recovery remains usable in this window.
- A saved deposit in Welcome opens the existing balance dialog's recovery UI;
  it never requotes or submits from the welcome screen. Non-funding address
  views poll public ETH separately, including recovery from transient storage
  failures. Closing or switching methods cancels both polling lifetimes.
- Keep the actual focused USD input DOM node across refresh renders. Restoring
  only focus/selection can lose composition or input events. Local browser
  testing confirmed amount/address recovery after full browser closure, no
  submission on receiving simulated funds, and one submission on explicit Next.
  Separately, the live canonical Sepolia origin survived full browser closure
  after funding and while the signed deposit was pending, recovered one
  successful deposit without resubmission, and completed actual chat and close.
- Native backend/SDK changes are isolated in
  `/Volumes/Data/codex/worktrees/native-eth-wallet/zkapi-EF-collab`, branch
  `codex/native-eth-wallet`. Do not use the unrelated dirty note-bound checkout.
  See [payment details](ZKAPI_PAYMENTS.md) for custody and conversion semantics.
- Deployment audit found the selected legacy protocol has a cross-note balance
  binding flaw and rejects valid historical-root escape challenges. Do not fund
  or publish its first native Sepolia vault (`0x0bf47f7fCc28975E4A928587869B73D32CD12f77`),
  which remains empty. The reviewed integration now uses `zkapi-v2-note-bound-v1`,
  matching WASM/proving keys/verifier, historical-root repair and a durable
  challenge service. Its replacement vault is deployed and finalized;
  none of this upgrades existing immutable contracts. The newer setup is a single-party development
  setup and must not be described as production-audited.
- See [native deployment progress](ZKAPI_NATIVE_ETH_DEPLOYMENT_20260927.md) for
  the unused first test vault, isolated infrastructure, test boundaries and
  remaining deployment gates.
- Live staging issuance uses an authenticated SSH tunnel from org to station.
  Its connection terminates at station loopback; the station IP allowlist must
  include `127.0.0.1` alongside the existing org private IP. Full signed OrgAuth
  checks remain mandatory. Missing, malformed and forged signatures return 401.
- Publication review found that `build.json.webauthnRelayUrl` is metadata only:
  the current build does not inject that URL into executable code. The staging
  account relay remains unverified; separate origin/CORS checks do not prove it
  works. Native wallet funding/recovery does not depend on the account relay.

## 2026-09-22: MetaMask and Send to an address

- Live Sepolia testing exposed fixed-price legacy transactions getting stuck
  below a rising base fee. New address transactions now use capped EIP-1559
  headroom, with maximum-fee affordability checks and unchanged 300-gwei /
  0.02-ETH limits. Existing signed transactions still replay exactly; this is
  not a replacement feature. ETH max return resolves its amount from the same
  fee quote used to sign, and explains that unused fee reserve may remain.
- User selected exactly two options: MetaMask first and Send to an address.
  The earlier manual calldata/hash-entry experiment was never deployed and has
  been replaced. Receiving funds and converting them to private credit are
  distinct states; only Add to private balance authorizes contract calls.
- The new local Ethereum account is password-encrypted in separate IndexedDB,
  locks on reload, and downloads a recovery file before showing its address.
  That file restores public funding-account assets only. Private notes remain
  in the SDK's browser storage; clearing site data can still lose private credit.
- SDK provider restoration precedes init; after config initialization the host
  reloads the funding record. Signing is scoped to a user's explicit action,
  serialized across tabs, and journaled before broadcast. Read-only refreshes
  and unlock never send transactions. Stop waiting must recheck cancellation
  after asynchronous balance reads before permitting any deposit.
- Withdrawal gas payer and payout destination are separate. Saved proof-bound
  destinations cannot change during recovery. Return-funds controls handle
  residual public tokens/ETH without guessing the incoming sender's address.
- UI preserves ordinary field edits and disclosure/scroll state; passwords stay
  only in input/event scope and are never serialized into rendered markup.
  Copy stays usable while waiting for funds, and stopping that wait is an
  informational outcome rather than a failed or submitted transaction.
- Wallet button styles explicitly honor `hidden`. Their author-level grid
  display otherwise overrides the native hidden style and exposes MetaMask
  replacement controls in address mode after a transaction timeout. This rule
  covers primary, secondary and quiet actions without changing disclosure motion.
- Pre-deployment gas checks found an observed vault deposit using 6,897,262
  gas; the SDK pads that estimate to 8,326,714. The address signer now imports
  the SDK’s 16,777,216 transaction gas ceiling, replacing its lower 8-million
  limit. The 300-gwei and 0.02-ETH transaction fee caps remain in force. Tests
  exercise the real SDK buffering and reject oversized or over-budget calls.
- Exact ETH returns preserve all 18 decimal places and the original authorized
  amount. Only the blank/max path resolves its authorized amount after reserving
  fees; it supports ordinary accounts, while contract recipients need an exact
  amount. Provider-level tests cover both paths, not only UI mocks.
- Validation: 886 core and 352 payment tests pass, including 60 focused address
  tests and a real local Anvil contract call, lost-response recovery through the
  SDK, and ETH return. Sepolia, Mainnet and Tickets-only production builds pass.
  Browser checks without an injected wallet cover production option switching,
  encrypted setup, reload/unlock, copy during waiting, cancellation, destination
  preservation and a 390px layout. The final adversarial review approved the
  diff. Live Sepolia deposit, chat, settlement, custom-destination withdrawal
  and public ETH return passed, including finalized closure and journal
  cleanup. The local-chain test also uses a fixture contract.
  See [zkAPI payments](ZKAPI_PAYMENTS.md) for custody and recovery boundaries.
- The user chose the current pinned servers. `oa-wallet-sepolia.vercel.app`
  and `oa-wallet-mainnet.vercel.app` are now READY in Vercel team
  `oas-projects-cbf58581`, with staging-org rewrites, the staging passkey relay
  and the existing verifier. All 972 published asset hashes and backend pins
  passed independent verification. Mainnet desktop/mobile smoke and Sepolia
  encrypted setup/reload/unlock/waiting checks passed without an extension.
  The live Sepolia contract lifecycle resumed with 0.0825 test ETH. Mint
  and exact approval passed. The fixed-fee deposit became stale while queued;
  a zero-value test cancellation cleared its nonce. After finalized recovery,
  the EIP-1559 deposit, chat and custom-destination withdrawal passed, and
  unused public ETH was returned. Finalized block 11,762,594 confirmed all
  receipts, and the app cleared the funding transaction journal and active lease. See [deployment evidence](ZKAPI_DEPLOYMENT_20260922.md) and
  `/tmp/oa-address-deploy-20260922/task-state.json` to resume. No Mainnet funds
  were used. The newer note-bound Sepolia server requires a separate matching
  SDK/artifact migration and is not selected for these deployments.

## 2026-09-27: CLI foreground status and logs

- `oa-chat serve` sends timestamped startup/shutdown, API request start/end,
  and wallet readiness updates to stdout. Readiness is checked immediately
  and every five seconds with a three-second deadline; only changes print.
  Ticket mode reports available count; zkAPI reports policy-checked companion
  readiness, a loaded private balance, and pending settlement. These read-only
  checks neither acquire access nor guarantee upstream inference availability.
- Request logging uses fixed route/method labels and status/duration, excludes
  health probes, and preserves `http.ResponseController` flushing and deadlines.
  Aborted requests are marked separately. Raw companion output and HTTP panic
  diagnostics stay suppressed because they can contain private data. Logs never
  include prompts, responses, headers, query strings, model names, funding
  capabilities, or private wallet/proof details.
- The daemon creates no log file, but stdout redirection, Homebrew services,
  and systemd may retain operational activity metadata. `oa-chat status` retains
  its JSON output; fatal command diagnostics still use stderr. See
  [foreground logging](../daemon/README.md#foreground-status-and-logs) and the
  [local client privacy model](PRIVACY_MODEL.md#local-api-clients).
- Full Go race tests, vet, and build passed. A built-binary smoke check and
  subprocess regression verify stdout status/request/lifecycle output, clean
  stderr on normal shutdown, and secret exclusion. Fresh review approved.
- This source change is newer than the published `daemon-v0.1.0` bundle.

## 2026-09-27: CLI network proxy is opt-in

- The command-line daemon uses direct HTTPS when `relay_url` is empty or absent.
  `oa-chat init --relay-url WISP_URL` opts in; existing nonempty relay settings
  stay enabled. Clear the value to `""` and restart to disable it. `init` still
  never overwrites existing configuration.
- Ticketing, verification, inference, funding RPC, and the supervised zkAPI
  companion share this external transport choice. The companion always keeps
  its authenticated loopback CONNECT bridge, which rejects plaintext HTTP and
  HTTPS-to-HTTP redirects that reqwest could otherwise follow. An empty relay
  setting makes that bridge dial
  destination TCP directly; nonempty uses Wisp. Environment proxy variables
  are ignored. Opt-in Wisp continues to fail closed without a direct fallback;
  HTTPS certificate and station/key verification remain mandatory.
- Direct mode uses local DNS and reveals the source IP to destination services,
  so network metadata can correlate requests despite blind issuance and fresh
  provider keys. See [CLI setup](../daemon/README.md#build-and-run-ticket-mode)
  and [the privacy model](PRIVACY_MODEL.md#local-api-clients).
- Full Go race tests, vet, and build passed; changed relay/command packages
  passed a final race-test rerun. Coverage includes direct routing, destination
  TLS validation, and rejection of HTTPS-to-HTTP redirects.
- This is a source change after the published `daemon-v0.1.0` bundle. Historical
  Wisp validation records below describe the transport used at the time.

## 2026-09-27: Daemon documentation lives with the daemon

- The daemon entry point is [daemon/README.md](../daemon/README.md). Supporting
  [packaging](../daemon/docs/CLI_PACKAGING.md), [ticket](../daemon/docs/CLI_TICKETS.md),
  and [zkAPI](../daemon/docs/CLI_ZKAPI.md) guides and their screenshots live in
  `daemon/docs/`; keep future daemon-specific documentation there.
- Native release and Linux package sources use the relocated packaging guide.
  Installed packages retain the existing `CLI_PACKAGING.md` filename.

## 2026-09-24: Live Account dialog focus recovery

- Live staging testing at narrow widths confirmed that closing commercial Account by either Escape or Close attempted to focus an Account trigger inside an inert collapsed sidebar, leaving focus on BODY.
- Added the host UI capability `restoreAccountMenuFocus(target)`: preserve a usable original trigger; otherwise focus the visible sidebar toggle without scrolling or forcing the sidebar open. Billing delegates through this capability and retains its fallback for older hosts.
- Regressions cover inert, detached, focus-refusing and available triggers, plus commercial-to-host delegation. See commercial `docs/LIVE_UI_AUDIT_2026-09-24.md` for live coverage and transaction/authentication exclusions.

## 2026-09-24: Google-to-username account switching handoff

- Live user testing reported that signing into Google in one tab and entering a different username on the landing page required a second sign-in over chat.
- The username auth route cleared the old account before opening its passkey handoff. The Account subscription opened the generic sign-in dialog during cleanup; `openForUsername` then returned because the dialog was already open. The earlier OAuth-completion fix did not cover this path.
- The username handoff now owns the waiting surface before old-account cleanup and can reuse an idle restoration dialog. Cleanup suppresses old-account automatic passkey prompts and dismissal; duplicate handoffs cannot replace the submitted username. Failure shows an error and does not start the new authentication.
- If an old authentication/recovery operation is already active, the switch is refused with a retry notice and the incoming username route remains available for a reload. Idle explanation timers are invalidated before reusing the dialog.
- The router still waits for account cleanup before account-scoped app initialization; it does not wait for the native passkey ceremony. Normal username validation, passkey verification, and account-scoped storage remain unchanged. Regression coverage combines the real Account subscriber, auth router, and username handoff with delayed/failing cleanup.
- Local regression success is not deployment/live acceptance: repeat Google A → landing username B after deploying the fix.

## 2026-09-24: Interactive control audit

- Settings layout/font/theme/effort segments now expose radio semantics, keep only the selected choice in the Tab order, and support arrow keys plus Home/End through existing click handlers. Disabled groups and modified shortcuts are ignored.
- The model dialog and its close button have accessible names. Empty search results explain how to recover; a settled empty catalog no longer spins forever.
- Delete-history confirmation focuses Cancel rather than the destructive action. Copy specifies all chats in this browser and retains the download-before-delete option without asserting this is the only copy.
- Security Details ignores asynchronous integrity-check UI updates after the dialog is removed, replaces old Escape/backdrop listeners on rerender, and names its close button. Integrity and network behavior are unchanged.
- Commercial `docs/INTERACTION_AUDIT.md` records actual browser checks separately from fixtures and unit tests. Live OAuth/passkey, real payments, and paid inference are not certified by these checks.

## 2026-09-24: Expanded release regression checks

- Account username editing clears field-specific errors through the existing service, retaining the value and caret after the synchronous subscriber render. It does not clear unrelated Google/passkey/network errors or replace the field during IME composition. Enter during composition (including keyCode229) does not submit.
- Twelve adversarial tests exercise this input lifecycle plus deposit boundary validation, recovery gating, persisted field errors and phase-toast ownership. Full core suite:909 application +322 payment tests, zero skipped. Independent review approved.
- Commercial staging-configured build and artifact checks passed. Real auth/payment/device verification remains a release gate; see the commercial readiness report for exact coverage rather than treating unit counts as end-to-end certification.

## 2026-09-24: UI readiness pass and bottom composer

- Empty chats retain the same bottom-docked composer as active chats, including the mobile keyboard offset. Composer-anchored notices sit above it in both states; outgoing welcome content can fade without moving the composer.
- Ticket mode suppresses zkAPI phase toasts, and background closing/settlement never emits “Closing previous chat.” System Panel state and settlement work remain intact; cleanup only removes the phase toast it owns.
- Wallet funding uses a full-width 44px Ethereum-wallet CTA, aligned disclosure rows, bounded amount-field width, and legible dark error text. MetaMask-specific workflow instructions stay accurate.
- Deposit UI validates using the SDK token parser and safe integer range before starting wallet work (the SDK itself connects before validation). Errors persist with field association across renders, clear on edit, and do not change SDK recovery/transaction checks.
- Empty username validation rejects locally with “Enter a username to continue.” Commercial sign-in errors now sit within the account column; account recovery errors also have readable dark colors. No authentication or inference privacy boundary changed.
- Full core tests passed (904 application + 315 payment). Independent review approved. Real OAuth, wallet transactions and native mobile keyboard testing remain separate release checks; see the commercial `docs/UI_READINESS_REVIEW.md` for coverage and previews.

## 2026-09-24: Hide the sign-in form during Google account cleanup

- The completed-Google arrival now opens its waiting surface before clearing a mismatched previous account. The previous fix consumed the completion correctly but left the generic sign-in form visible during asynchronous logout/cleanup.
- The modal marks the handoff pending before its first render, keeps the waiting surface through cleanup and session completion, and suppresses automatic passkey prompts for the old account. Cleanup failure shows an error without completing the new session; concurrent handoffs cannot bypass cleanup or consume the token twice.
- Regression coverage checks every initial render, deferred cleanup, duplicate arrival, cleanup failure, and continuation to the normal encryption-passkey flow. Server authentication, account-matching policy and token validation are unchanged. The reported live browser flash has not been independently reproduced with real Google accounts.

## 2026-09-24: Shorter account-unlocked toast

- The successful username/account-number passkey unlock toast now displays for 1.5 seconds instead of the default 3 seconds. Other notifications are unchanged.

## 2026-09-24: Revised ephemeral-key description

- Replaced the System Panel key-help description with the requested single paragraph describing OA obtaining a key from a trusted issuing station and verifier checks for provider-account ownership and disabled request logging. Removed the previous shared-key paragraph. Copy only; issuance and verification behavior are unchanged.

## 2026-09-24: Complete Google sign-in in an already-open Account dialog

- A landing Google completion can clear a previously verified username/legacy account. That state change opens the signed-out Account dialog through its subscription before the auth-intent router delivers the completion token. `openForOAuthCompletion` previously returned because the dialog was already open, discarding the handoff after its URL fragment had been removed.
- The completion now reuses the open dialog and runs the existing session-completion and encryption-passkey flow. An in-flight handoff still prevents duplicate consumption. No authentication validation, credential storage, or inference boundary changed.
- The regression exercises the real Account subscription and auth-intent router: clearing the old account opens the dialog, the token is consumed once, and the result advances to passkey unlock. It failed against the previous implementation. This confirms a code path for the reported second sign-in screen, not the exact circumstances of the user's production session.

## 2026-09-22: CLI withdrawals using the local funding key

- `oa-chat withdraw` shows status; `withdraw --to ADDRESS` authorizes a cooperative close of the full remaining private balance. The daemon signs with its existing local funding key, so neither funding nor withdrawal requires a wallet connection. Gas comes from that address; public leftovers are not swept, partial withdrawals and escape/challenge submission are not exposed.
- Both native binaries must be rebuilt: the companion now advertises `withdrawal_bridge_version: 1`, persists its exact note/destination reservation before requesting clearance, and blocks inference and legacy mutation paths until closure. Go freezes the recipient, shares the existing transaction journal and nonce history, replays identical signed bytes after uncertainty, and accepts a refreshed proof/new nonce only after reporting a finalized revert and another explicit command.
- Closure requires a canonical finalized successful receipt with the exact vault `MutualClose` event in both Go and Rust. Private recovery archives are durable before the active note disappears. Completed retries are idempotent and cannot touch a newer note. Go finishes its closure bookkeeping before any funding entry point can prepare another deposit. A missing note without confirmed closure still requires recovery.
- A separate owner-only `management-token` is required in addition to the inference API key for withdrawal management. Commands bind every request to their original note ID; retry authorization names the exact reverted hash once, so concurrent or suspended polling cannot authorize a new attempt or withdraw a later note. If someone else relays the identical payout first and the local transaction finalizes reverted, `--confirm SUCCESSFUL_HASH` can recover that independently verified payout without signing again.
- See [CLI withdrawal and recovery](../daemon/docs/CLI_ZKAPI.md#withdraw-without-connecting-a-wallet). The published `daemon-v0.1.0` bundle predates these changes; no updated release is implied by source changes.
- Live Sepolia withdrawal completed on September 23 UTC (September 22 Pacific) after the gas top-up. Note 58 paid its remaining 99971 test-token units to the selected destination in [transaction 0x085471…bdf1a](https://sepolia.etherscan.io/tx/0x0854712a98b32c420aa5f9a012674b057ea9e0e69541e6aa4a553f7e0b8bdf1a). Exact vault event, historical recipient balance delta, treasury payment, consumed nullifier, closed note, and canonical finality passed. Restarting during finality kept the same signed bytes; restarting after completion and repeating the CLI/management request kept the signer nonce at 3. Both processes report completion, private recovery archives remain, and the same address is ready for funding again (no second live deposit claimed). Gas cost was 0.007434784766264632 test ETH; remaining public ETH stays at the local signer. Temporary services were stopped and closed-state backups retained. See the [acceptance evidence](../daemon/packaging/validation/sepolia-cli-withdrawal.json).

## 2026-09-22: Live Sepolia CLI address funding and cancellation recovery

- The manual CLI flow passed against the pinned legacy Sepolia deployment: a fresh locally generated address received 0.1 demo tokens and gas, signed its own approval/deposit, waited for canonical finality, and activated note 58. Restarting during confirmation retained the exact signed transaction. No external wallet connection was used.
- One verified `openai/gpt-4o-mini` stream returned HTTP 200 and 40 content events; automatic signed settlement charged 29 microcredits and left 99971. Restarting again and repeating the same funding command preserved the reduced balance and did not send another deposit. See [CLI acceptance details](../daemon/docs/CLI_ZKAPI.md#live-address-funding-acceptance-2026-09-22) and [sanitized evidence](../daemon/packaging/validation/sepolia-address-funding.json).
- The default relay failed TLS, so the test used a temporary remote Wisp helper through SSH with destination TLS intact. Test services were stopped and private recovery state retained outside the repo. The existing independent-request settlement wait remains; this does not validate the newer note-bound deployment, mainnet, browser UX, or a new release.
- Ctrl+C during the local funding HTTP request previously reported an unavailable daemon. Cancellation now gives neutral same-command resumption guidance; read-only `fund` cancellation never suggests selecting `--amount`. Focused regression tests, the full Go race suite, vet/build and fresh review passed.

## 2026-09-22: Clarify ephemeral-key help

- Key help now identifies the request path: the device requests a key through OA, which obtains it from an issuing station. A new key is requested only when needed. Removed the multiple-queries sentence.
- Replaced vague verifier “ownership and limits” with station provider-account ownership, signatures, and expiry. The verifier checks signed expiry but the inspected ownership endpoint does not establish a general spending-limit audit. “Shared keys” now explicitly means a key included with a shared chat; its existing expiry and credit are preserved. Copy only; no issuance, verification, sharing, or charging behavior changed.

## 2026-09-22: Keep an unresolved deposit dialog through repeated reloads

- An open funding dialog retains its tab-scoped view marker while deposit/approval confirmation is unresolved, including after its JS action returns and after restoration. Closing it or resolving the deposit clears the marker. The marker contains only view/mode, never wallet credentials or transaction data.
- After initial navigation finishes, explicit same-tab dialog intent may restore over an OA chat without switching its payment mode. Without that intent, SDK-persisted operations still only auto-open in zkAPI mode. Restoration only opens the dialog and refreshes status; no deposit, approval, wallet prompt, or inference request is submitted.

## 2026-09-22: Reloaded response display and resumption boundary

- Ordinary saved assistant streaming flags no longer leave an endless waiting indicator when this tab has no live request. A display-only copy clears the flags, preserves partial text/reasoning/images, and offers the existing manual Retry response action with an explicit new-request notice. Stored records remain untouched because another tab may still own the request. Live sessions and completed/legacy messages are unchanged.
- Reload never automatically resends a prompt or acquires a replacement key. The direct provider stream has no reconnect path here; a returned access key is authorization, not a handle for retrieving the original response. True continuation after reload is not implemented. Existing key verification, proxy policy, SDK recovery/settlement, and manual retry access rules remain intact. The OA ticket redemption/response-loss gap described below also remains; stopping the browser cannot undo a redemption accepted by the server.
- Parallel/Council and memory-agent workflows have their own render/state models; this change is limited to ordinary assistant response display.

## 2026-09-22: Clearer standard withdrawal steps

- Preparation copy identifies the zkAPI server authorizing the withdrawal and the device creating its proof. The wallet step says “Confirm your withdrawal in MetaMask” and explains returning the remaining balance to the wallet. Deposit cancellations say “Deposit canceled.” in both funding screens; standard withdrawal cancellations say “Withdrawal canceled.” Escape recovery wording and all transaction behavior remain unchanged.

## 2026-09-22: Explicit deposit and withdrawal confirmation copy

- Deposit confirmation says “This transfer moves funds from your wallet into your zkAPI balance.” without naming a token. Deposit and withdrawal chain steps name Ethereum confirmation. Submitted deposits explain that the deposit awaits confirmation on Ethereum, without a timing promise. Submitted withdrawal notices explain that the withdrawal is awaiting confirmation on Ethereum, without promising a completion time. Escape recovery retains its separate safety-window explanation. No transaction or polling behavior changed.

## 2026-09-22: Search results remain in normal history

- Reproduced with regression tests against the real ChatApp controller: search caches sessions outside the initial 80-row sidebar page. Previously ensureSessionLoaded and insertSessionIntoList mistook cache membership for sidebar membership, so clearing search hid an opened/updated old chat. loadMoreSessions also skipped cached-but-unlisted results.
- Opening a cached session now inserts its existing object into the sidebar. Insertion and pagination deduplicate against the displayed session list, preserving the cached object and live edits. Search alone does not populate the entire normal sidebar. Tests cover opening/updating/clearing search, repeated opening, pagination, and stale database copies.
- The trash tooltip uses bottom-start placement: below the trigger and extending rightward, with the existing uncentered entrance animation. No deletion behavior, inference, ticket redemption, or response recovery changes.

## 2026-09-22: Correct Ethereum mark and reload findings

- Further investigation (no recovery implementation): ticketStore.consumeTickets archives selected tickets after the redemption handler returns, but the org spends them before issuing the key. Reload can lose a successful redemption response before durable client access storage; acquireVerifiedAccess retries TICKET_USED with other tickets. Recovery must reconcile the original redemption rather than treating an unknown result as safe to spend again. The local org request_key endpoint rolls back known provisioning failures but does not expose replay of a successful key response. zkAPI separately owns lease recovery and aggregate-usage settlement; preserving a UI spinner cannot keep provider inference alive across reload. Resumable inference would require provider support or a privacy-reviewed durable execution service, not simply browser state restoration.
- The client payment selector uses the exact six diamond paths/colors from the supplied EF color-light SVG, including its purple facet, in place of the previous embedded PNG.
- Investigation only (not fixed): request ownership is in-memory and lost on full reload. ChatArea normalizes streamingReasoning/streamingTokens but leaves streamingPending/streamingPhase intact; MessageTemplates renders those saved placeholders even when no request is active. A subsequent change should reconcile orphaned messages to an interrupted/retry state and separately recover access state; do not treat a restored indicator as a resumed inference request.

## 2026-09-21: Withdrawal reload and disclosure continuity

- Deposit confirmation copy now reads “Confirm the deposit in MetaMask to add funds to your private balance.”

- Restore prepared/retry-ready withdrawals as well as submitted/unknown ones, even after the transient tab marker has been consumed. Background submissions/finalizations open Payment history; completed records and long escape waiting periods stay quiet. Reopening only refreshes status and never resubmits a transaction.
- The first mutual-close step now says “Prepare your withdrawal.” Recovery copy explains opening MetaMask from the browser toolbar and using the existing recovery/retry actions without another page reload. The injected provider has no documented focus-existing-confirmation method; no automatic transaction or permission requests were added.
- Background wallet updates are coalesced while a guide/history arrow, panel, and follow-up scroll animate. Existing shared Transitions.dev timing and reduced-motion behavior remain; close/rerender clears deferred work.

## 2026-09-21: Tighter sidebar trash placement

- The delete-history glyph sits 6px farther left within its existing 36px button. The adjacent fixed sidebar toggle keeps a separate hit target; New Chat stays in place.

## 2026-09-21: Integrate inference reliability with current main

- Merge preserves request deadlines, silence warnings, partial-response recovery, output-budget recovery, and the 30K generation cap alongside the current responsive layout and wallet UI. Both lifecycle regression groups are retained. Credit-error body inspection now obeys the same abort signal and cancels discarded response branches, including a stalled 402 before streaming begins.

## 2026-09-21: Restore interrupted wallet dialogs

- While an open wallet dialog runs an action, a tab-scoped sessionStorage marker records only its view and withdrawal mode. Reload restores that view even before a transaction exists; restoration consumes it, and completion or dismissal clears it. Ongoing transactions continue to restore from SDK records. Wallet secrets and recovery records remain exclusively SDK-owned. Restoration only opens and refreshes status, never reconnects MetaMask or submits a transaction.
- Startup waits for SDK initialization, initial conversation restoration, and an eligible zkAPI chat before consuming restoration. In-flight USDC approvals also qualify, even when the surrounding deposit plan is still prepared. Manual navigation/dismissal wins. Restricted session storage falls back to SDK-persisted transaction restoration.
- Funding copy says “Your deposit progress is saved in this browser.” Sidebar trash moves 4px closer to the fixed toggle without overlapping either 36px hit target.

## 2026-09-21: Named payment selector

- The chat toolbar now shows OA and zkAPI beside their existing marks, with larger 32px-high targets. Labels remain visible on phones. Existing hover explanations, keyboard focus, sliding selection, and locked-mode behavior are retained.

## 2026-09-21: Wallet recovery controls and sidebar order

- MetaMask waiting, submitted deposits, and active wallet work use a neutral spinner with visible status text in the System Panel. Unknown deposits use the same neutral row with a static dot, since no check is running. Error/expiry attention styling is retained.
- Deposit recovery uses “Check payment status” as the main action and “Try again in MetaMask” as a secondary text button. The existing retry confirmation and SDK recovery/submission methods are unchanged; help toggles never submit wallet actions.
- Journey labels distinguish submitted confirmation, an active deposit check, and an unknown result. The unknown state explains checking before retrying.
- Funding accordions now share a gentler ease-in/out and matching 420ms opening/closing durations; the stable scroll gutter avoids text reflow when overflow appears. Existing deferred scrolling, cancellation, inert/ARIA state, and reduced-motion behavior are retained.
- Sidebar order is fixed toggle, Delete history, New Chat. DOM order matches visual/tab order; the fixed toggle and existing delete confirmation remain unchanged.

## 2026-09-21: Approved zkAPI wallet walkthrough

- Funding uses the approved single-dropdown numbered guide, full-row dividers,
  shorter mainnet/resume copy, and a flowing private-billing explanation. The
  mainnet and free Sepolia setup paths remain separate.
- Shared `FundingDisclosures` keeps setup/billing/history mutually exclusive,
  updates ARIA/inert state in place, and retains payment-history action bindings.
  History content is rendered up front, inert when closed. Opening help never
  triggers a wallet request or service refresh.
- Reuses installed Transitions.dev accordion/modal CSS. Local accordion timing
  is 420ms open/320ms close, followed by up to 320ms scrolling after final layout
  is known. Manual input, close, or rerender disposes timers/listeners/frames.
- Modal placement anchors the title near the top instead of recentering it as
  the guide grows. Wallet refresh preserves guide expansion, focus and scroll.
- See [zkAPI payments](ZKAPI_PAYMENTS.md) for flow and recovery boundaries.

## 2026-09-21: System-panel tooltip clears payment controls

- The fixed right-panel toggle now uses the existing below/right-aligned tooltip placement, for both Open panel and Close panel. The former left-of-button placement overlapped the adjacent OA/zkAPI payment controls.

## 2026-09-21: Panel reflow and anchored sidebar tooltip

- Desktop sidebar and system-panel visibility changes now capture the transcript bottom before changing layout, using the same cancellable anchor as widen/narrow. Overlay panels do not change transcript width and do not start anchoring.
- Anchoring includes both panel transition durations and rechecks destination styles on the first animation frame. Combined panel/width changes keep the bottom visible through the longest animation; manual scroll and session changes still release the anchor.
- The fixed left toggle uses the uncentered tooltip entrance animation. Its previous centered keyframes briefly put the tooltip off-screen before snapping to its left-aligned resting position.
- New Chat remains before Delete history, keeping the frequent action first.

## 2026-09-21: Keep the transcript bottom visible through width changes

- Widen/narrow captures whether the chat scroller is within 8px of the bottom
  before reflow. It follows the bottom throughout the computed CSS transition,
  preventing widening's scrollTop clamp from leaving the view higher up after
  narrowing. Includes the collapsed Council/Parallel transcript width toggle.
- Readers above the bottom are not moved to the end. Wheel, touch, pointer, or
  scrolling keys immediately release the temporary anchor. Session changes and
  rapid reversals cancel stale work; original scroll behavior is restored.
- This is a brief layout adjustment, not a change to streaming auto-scroll,
  persisted positions, messages, or inference. Zero-duration/reduced-motion
  layouts settle without relying on a transitionend event.

## 2026-09-21: Stable left sidebar toggle and stateful widen control

- Left sidebar has one viewport-anchored button at the top-left, outside the
  moving/inert sidebar. The header reserves its space; when collapsed or in
  overlay mode the toolbar reserves the same target. Both directions use the
  same button, preserving pointer position and keyboard focus during reversal.
- Collapse/expand tooltip uses the shared tooltip typography/skin, retains the
  shortcut, and opens toward the viewport interior. Labels and aria-expanded
  update immediately for button, keyboard, programmatic and responsive changes.
- Widen/narrow labels and pressed state now update directly when the preference
  changes. Outward/inward chevrons crossfade with the existing Transitions.dev
  icon swap; hover movement follows the action, with reduced-motion support.
- At 768–1099px, sidebar contents match the 280px overlay instead of retaining
  the narrower desktop width. Desktop resize preferences and phone widths stay
  unchanged. No inference, storage, account or payment behavior changes.

## 2026-09-21: Preserve distinct formulas in long responses

- Markdown math placeholders now terminate their numeric IDs, so restoring token
  1 cannot consume tokens 10–19 (and similarly at higher counts). Previously a
  long response could repeat an earlier formula with trailing index digits.
- Applies to dollar and backslash inline/block math and escaped currency dollars.
  The shared renderer fixes existing stored responses on rerender; message source,
  inference, storage, and network behavior are unchanged.
- Regression coverage exercises 25 expressions per delimiter family and 25
  escaped dollars through the production Markdown processing method.

## 2026-09-21: Background response keeps its sidebar title glimmer

- The existing title-generation glimmer now also lasts while an unselected chat
  is responding. New Chat and conversation switches consult the same in-memory
  stream state used for Send/Stop, including access preparation, Parallel, and
  Council. Returning to the chat clears the background-response glimmer; any
  existing title-generation work keeps its original indicator.
- Start/finish/failure/cancellation update visible title classes in place,
  preserving inline renames and virtual-list position. Newly rendered rows read
  live state, so scrolling or filtering cannot revive a completed response.
- No timer extends or cancels inference, no state is persisted or broadcast to
  other browser tabs. Reduced motion uses a static emphasized title instead.

## 2026-09-20: Toolbar controls never float over transcript text

- The floating toolbar now measures both control groups against the transcript's
  inner edges, with 12px clearance. Share, payment-switch width, font changes,
  chat width mode, and side-panel size all contribute to the actual threshold;
  the old fixed 52px estimate missed the commercial controls.
- ResizeObserver watches the groups and chat column, and window resize checks
  immediately. Panel toggles cover the transcript before movement; observation
  follows the actual animation instead of retaining a prediction for 350ms.
- The opaque background applies immediately, including below 768px. Toolbar
  position and transcript top padding stay fixed, so switching does not shift
  the conversation. No inference, payment, or persisted preference changes.

## 2026-09-20: Ticket-code redemption survives leaving Billing or reloading

- `TicketCodeRedeemer` persists each code's exact blinded batch, issuer key, and
  serialized unblinding state in the browser-local `oa-ticket-code-recovery-v1`
  IndexedDB before `/api/alpha-register` can consume it. Signed responses are
  validated and saved before unblinding. Interrupted work replays the exact
  batch or finishes locally from saved signatures; it never generates replacement
  blinding secrets for a pending code.
- Recovery is isolated by wallet owner (including anonymous), serialized by an
  origin-wide Web Lock, and gated on verified/unlocked/synced account readiness.
  The final wallet write requires durable persistence and the original account.
  Successful recovery is deleted only after that commit. Definitively unusable
  codes are retired; transient failures remain saved and do not block other
  codes. Key rotation retains the bearer code while replacing stale blinding
  state. Reimports use identical token bytes and treat durably removed or
  invalidated tokens as settled without resurrecting them.
- The commercial extension receives only pending count, progress, and final
  wallet count. Opening Membership resumes saved work; a wallet-ready notification
  retries an earlier readiness check. Closing the view never cancels issuance.
  Reopening retains the same owner's progress/success. Account changes suppress
  stale UI completion and preserve the original owner's recovery record.
- Code and blinding secrets remain local bearer material; they are never synced
  or sent to billing/account APIs. Issuance explicitly omits account cookies.
  Clearing site data removes recovery. Existing codes lost before this journal
  existed cannot be reconstructed; this change protects new redemptions.
- The org's existing exact-batch replay implementation is required (present in
  `oa-org-staging-release`). No production redemption was performed for testing.

## 2026-09-19: Responsive landing and compact composer

- Welcome and composer share the available chat column (680px composer cap),
  with 24px desktop / 16px phone gutters and bounded space below the landing
  group to place it slightly above center. The same input node docks on first send.
- Both side panels overlay below 1100px. CSS, pre-hydration defaults, sidebar
  interaction logic, and RightPanel use that boundary. Sidebar resize clamps
  presentation while retaining the preferred desktop width; crossing the boundary
  restores the saved desktop visibility without overwriting it.
- A card ResizeObserver selects compact controls below 560px of actual composer
  width. The original mode and memory nodes move into the existing Settings
  popover (labelled More options); they retain their listeners/state. A Scrub
  prompt button calls the same capability-checked scrubber path. Parallel model
  selectors get a separate two-column row. Phone primary controls have 44px targets.
- VisualViewport shrink greater than 120px while editing, without pinch zoom,
  hides the empty welcome and docks the composer above the phone keyboard.
  Focus-out and viewport resize/scroll update that layout. Short settings menus
  can use the visible viewport rather than extending above it.
- Transcript padding now measures the input card itself, including the additional
  model row and draft growth; the fixed mobile card is outside its wrapper flow.
- Local demo files are outside the application repository in `oa-responsive-demos`.
  They exercise the actual chat modules but disable inference submission. The
  keyboard demo simulates visual-viewport shrink; physical iOS/Android keyboard
  behavior still needs a device check. Nothing has been pushed.

## 2026-09-17: System Panel icon buttons; submitted transactions resolve themselves

- The widen, collapse and clear-timeline controls share `.oa-panel-icon-btn`:
  a 16px glyph from the 24px outline set at a 1.5 stroke, muted until hovered,
  `--color-hover` tint behind it (150ms colour/background transitions), the
  same state on `:focus-visible`, and a 1px nudge that says which way the
  control acts (collapse leans toward the edge it leaves to, widen's arrows
  spread, or draw in when already wide). Clear is destructive and rare: red
  on hover only. Collapse is a 28px target centred on the header text line;
  clear is 28px inside the timeline row without growing it (`--tight`).
- Tooltips (12px, existing system) on all three, delayed 350ms so a pass of
  the pointer says nothing; labels follow state ("Open/Close panel",
  "Widen/Narrow chat"). New `data-tooltip-position="end"` (beside, to the
  right) for controls at the toolbar's left edge, which clips tooltips below.
- A submitted deposit or withdrawal needs nothing from the person: the step
  says "Waiting for confirmation. Usually under a minute; this updates on its
  own." and the check button is the quiet fallback ("Check now"). Other
  phases (dropped, awaiting wallet, ambiguous) keep the primary check. The
  SDK reconciles every 15 s and on focus; the dialog re-renders on change.

## 2026-09-17: Wallet progress survives a reload; System Panel inline from 768px

- Private balance dialog: after SDK initialization, a saved deposit or an
  unfinished withdrawal (prepared/submitted/pending, escape window, late
  attempt) reopens its own view once, on its steps. Opening only refreshes
  status; nothing is submitted or resumed without a click. A close, or any
  manual open during startup, wins and stays through background updates.
  The SDK was already reconciling the chain every 15 s; only the view was lost.
- The panel's Private balance status pill no longer truncates ("Withdrawal
  submi…"): the header row wraps and the pill keeps its whole label.
- Canceling the MetaMask prompt and finding a saved plan after a reload are two
  states with one line each, never both. Just canceled: "Canceled in MetaMask.
  Nothing moved." with "Try again with MetaMask"; the "Saved deposit" caption
  and "Saved in this browser…" note appear only when nothing was just canceled
  (a reload). MetaMask's own shortMessage is no longer shown for a rejection.
- System Panel: inline beside the chat from 768px (was 1024px), so a wallet
  side panel that narrows a laptop window no longer turns it into a fixed
  overlay covering the composer. Below 768px it is a sheet with a scrim that
  closes it on tap (`#right-panel-scrim`). Default-open stays at 1024px+
  (`DEFAULT_OPEN_MIN_WIDTH`), so tablets in the 768–1023 range keep their old
  default; with both sidebar and panel open there the chat column is narrow
  (≈260px at 768) — close one.

## 2026-09-17: Toast placement with the centered composer

- Logout keeps the normal dimmed backdrop and “Logging out…” indicator during
  cleanup, then shows the login modal (or returns to zkAPI). It no longer shows
  a success toast: the destination already confirms logout. The unused account
  toast anchor and its dialog height reservation have been removed.
- After the account modal closes, unlock confirmations use the composer position
  (below centered / above docked). A fixed top offset is not safe for account
  notices: a tall login dialog can occupy that same space.
- Ordinary and loading toasts sit 16px below a centered composer and 16px above
  a docked composer. Payment confirmations keep their existing top-center slot.
- A toast keeps its last position when the composer switches between those
  layouts. Later notifications choose the current layout. During first-send
  motion they use the composer's final destination, not a moving animation frame.
- Position remains responsive to draft resizing within the same layout and is
  clamped on window/visual-viewport resize and viewport scroll. Listeners are
  removed on replacement or dismissal; weak placement remains through the exit
  fade. Existing toast fades and reduced-motion rules remain in place.

## 2026-09-17: No empty-chat flash during conversation restoration

- The restoration flag must also be exposed by `COMPONENT_APP_KEYS`: ChatArea
  receives the restricted component facade, not the controller itself. Without
  that entry, renders see `undefined` and show the welcome while loading, and
  explicit New Chat throws when it tries to clear the flag. The regression test
  exercises the production `createVanillaUiInterface` for both directions.
- Prelude and app bootstrap use the same navigation predicate: explicit `?s`
  links and saved conversation selections keep the normal bottom composer while
  loading. The versioned navigation record wins over the legacy key, including
  explicit New Chat selections and interrupted legacy writes.
- Bootstrap no longer unconditionally renders the welcome. No-session renders
  stay blank until saved/local/shared navigation resolves; missing/failed links
  can then fall back to the normal empty state. Explicit New Chat resets the
  guard immediately.
- Prelude rechecks navigation, container contents, and app ownership after its
  asynchronous template import. A late import cannot insert a welcome into a
  mounted app or overwrite restored messages.

## 2026-09-17: Centered composer on empty chats

- Empty chats center the existing welcome/byline and composer with no prompt
  suggestions. CSS keys off the actual welcome node, including the prelude's
  first paint. Typing does not leave the centered state.
- Appending the first accepted user message animates the same input card to its
  normal bottom position over 500ms. The welcome fades away, and the transcript
  fades in without transforming its geometry (prompt scroll anchoring depends
  on that geometry). No draft, attachment, focus, or input event binding is cloned.
- Full session renders and new-chat resets cancel transient animations; viewport
  resizing cancels motion too. Reduced motion docks immediately. Existing/shared
  conversations render at the bottom without replaying arrival.
- Empty state overrides the mobile fixed-card/display-contents rules below 768px.
  Animate the input card itself, never its ancestor: transforming its wrapper
  would change the containing block of the mobile fixed-position card.
- Empty transcript padding overrides the input ResizeObserver's inline bottom
  padding; normal transcript padding resumes as soon as the welcome is removed.

## 2026-09-16: Proxy status and mutually exclusive panel help

- Network Proxy uses its globe for status: muted when off, pulsing while
  connecting, blue when ready but not verified, green after a verified proxied
  request, and amber after failure. Hover/focus exposes the exact status. Normal
  states have no status row; failures show a 12px amber status with a compact
  adjacent retry arrow. Retry has hover/press feedback, rotates while pending,
  and uses the shared Transitions.dev text/icon swap and success-check recipes.
  A completed retry shows Ready until a proxied request is verified; only verified
  connections say Connected and turn the globe green. Confirmation fades after
  1.5 seconds, leaving the globe. The retry row survives top-section refreshes;
  repeated activation is blocked and timers are cleared on failure or destruction. Retry
  respects active requests and reconnects without accidentally toggling off.
- The proxy question mark expands the same bordered, 12px explanation as tickets
  and ephemeral keys. Learn more opens the existing proxy modal; Security Details
  remains available while enabled. The switch uses the shared Transitions.dev
  toggle and connecting motion honors reduced-motion preferences.
- Only one of those three explanations may be open. Outside clicks dismiss it
  without consuming the action; inside clicks stay open. Escape closes focused
  panel help and returns focus from its content to its trigger, without taking
  Escape away from a foreground modal. Hidden explanations are inert.
- Explanation switches adjust the panel scroll position during the accordion
  transition to compensate for content collapsing above the selected question
  mark, within the scroller's bounds. At the top boundary movement remains a
  smooth collapse. Wheel/touch scrolling cancels this adjustment.

## 2026-09-15: Activity status lives on each event icon

Activity Timeline rows use one status-colored activity icon in the timeline rail,
replacing the separate dot and gray content icon. The shared dot status policy
still determines success, error, pending, interruption, and near-expiry colors.
Verifier shields retain their more specific validation warnings and hover check.

## 2026-09-15: Payment controls stay inside the toolbar

The persistent System Panel toggle now lives outside the app layout. Both the
combined Tickets/zkAPI switch and zkAPI-only Private balance control must insert
before `chat-toolbar-panel-space`, not before that floating toggle. Using the
old sibling anchor placed payment controls in normal body flow above `#app`,
pushing the entire shell down and misaligning the System Panel header. Keep the
explicit toolbar anchor in all shared HTML builds. Verify the composed payment
shell, not only isolated RightPanel previews, when changing header controls.

## 2026-09-15: Panel help, layout stability, and usage feedback

- The ephemeral key question mark expands an in-panel explanation. Learn more
  opens the existing attestation modal; parallel chats expose a link per issued
  lane. Expansion state survives top-section refreshes, and collapsed interactive
  content is inert. Key and ticket explanation text is consistently 12px.
- Key detail rows share a compact 42px minimum height, 12px horizontal padding,
  and 8px vertical padding; expiry and renew controls have a 12px gap. Row labels
  and masked keys stay on one line and ellipsize instead of increasing row height. The System Panel uses one fixed top-right toggle outside the
  resizing layout, preserving its position and focus when opening or closing.
  A closed panel is inert. Sidebar contents keep their final width while the
  outer rail clips, including saved widths and mobile overlays.
- Successful verifier activity uses a colored shield instead of a second green
  dot. Its check draws on hover using the Transitions.dev recipe; unsuccessful
  and pending verification never receive a success check. Reduced motion is kept.
- Tab-Tab no longer carries a decorative ticket icon. A toast reports one ticket
  only after new confidential access is issued; reusing a valid key produces no
  cost toast. UI callback failures cannot break key issuance or persistence.
- Widen uses a rectangle with outward chevrons and a lower divider, matching the user’s reference. Citation cards and their collapsed source
  stack use bundled website icons for supported domains and a local website
  symbol otherwise. Never add remote favicon fetching based on response URLs.
- Commercial welcome places the inference-ticket explanation below all payment
  and code options; it remains absent from zkAPI funding screens.

## 2026-09-15: Shared conversation entry and Memory wording

- A nonempty `?s=` conversation link skips only the automatic startup sign-in
  dialog. The normal URL-session importer can load the transcript without an
  account, including its existing password and expiry handling. Explicit auth
  handoffs retain priority; Tickets sending still runs the normal sign-in gate.
  Commercial routing must also exempt `s` from the first-visit landing redirect.
- Shared URLs use the active site origin and route root, including root-mounted
  builds. Staging shares therefore stay on staging; production shares stay on
  production instead of crossing into a different share backend. Native/opaque
  renderer origins retain the configured public URL fallback.
- Settings labels the existing global Memory feature switch “Save memories”,
  with “Save useful details from your chats.” The book tooltip says “Use memories
  in replies”. “Always attach retrieval” and its approval behavior are unchanged.
  Save memories still gates the feature as a whole: disabling it also disables
  live retrieval; book off alone leaves background saving enabled.
  Fresh/default preferences remain off, and explicit saved choices survive.

## 2026-09-14: Google passkey setup matches username entry

- New Google accounts now show the shared brief passkey explanation and open
  the native creation prompt automatically once, like new username accounts.
  The extra initial Create passkey card is skipped; cancelled or refused
  prompts retain an explicit retry action. Returning Google accounts retain
  automatic unlock, and legacy recovery/migration remains explicit.
- The setup timer is bound to the open login view and account. Closing,
  switching accounts, losing the verified session, or entering recovery cannot
  launch a delayed passkey ceremony. Key generation, wrapping, and persistence
  continue through the existing account service without changes.

## 2026-09-14: Checkout toast placement and username challenge errors

- Account-created success notifications use the top-center position, rather than
  anchoring to the chat composer behind the commercial welcome dialog. Both
  username/passkey and recovery-code registration use the same placement.
- Commercial checkout can request `showToast` with `{ position: 'top-center' }`.
  It sits below the header with a safe-area inset and a viewport width cap;
  ordinary notifications retain their position above the composer.
- Browser session interception excludes the exact `/auth/challenge` lookup.
  Its 401 is an authentication lookup outcome, not session expiry; preserving
  the response lets username continuation recognize `AUTHENTICATION_FAILED`
  without exhausting SuperTokens refresh retries. Other account and billing
  APIs retain automatic session refresh. Electron's separate bridge is unchanged.
- Creating an encryption passkey is still required for a new Google account
  (`PRF_PENDING`) or new username; existing PRF accounts should unlock instead.

## 2026-09-14: Toggle motion

- Settings and small switches use the Transitions.dev toggle recipe: 350ms thumb
  overshoot and settle, with travel matched to each existing control size.
- `ui/toggleMotion.js` initializes controls at their current checked state and
  enables motion after pointer/keyboard interaction changes that state. Newly
  rendered controls do not play an off animation. Reduced motion skips keyframes.
- Legacy transforms are excluded on animated small switches to avoid double
  movement. The commercial Billing toggle uses the same recipe and retains its
  two-step consent: revealing the explanation does not move the thumb.

## 2026-09-14: Ask chooses room for a readable answer

- Ask opens below a selection when at least 320px is available; otherwise it
  chooses above if that side has more room. Placement no longer depends on the
  height of the initial loading message.
- The edge beside the selected text stays anchored: an above panel grows upward,
  a below panel downward. Streaming never flips sides. Long answers retain their
  internal scrolling and reader-position behavior. Chat scroll and viewport resize
  re-fit the same side, preserving the selection gap where space permits.

## 2026-09-14: Consistent model waiting shimmer

- zkAPI now shows “Waiting for response” with the same text shimmer as OA tickets,
  without the additional animated dots. Access/proof preparation remains separate.
- Verified the existing shimmer CSS against production styles.css: the gradient,
  240% background and 1.9-second alternating animation match exactly. The original
  pending shimmer was introduced in commit 10b1ced. zkAPI’s smaller text and flex
  layout overrides now apply only to preparation details, leaving the waiting row
  at production’s 12px size and normal line layout.

## 2026-09-13: Inference Tickets explanation

- The commercial Inference Tickets question-mark panel leads with the 20-minute
  access window, reuse for multiple queries, and token-dependent usage, followed
  by the existing privacy explanation using The Open Anonymity Project's full name.
- Verified read-only against staging's active Redis tier configuration: all active
  ordinary-chat tiers currently have duration_minutes=20. Revisit this copy if tier
  durations change; it does not describe the separate 60-minute Tinfoil keys used
  by Tab-Tab and Memory. No issuance, pricing, or expiration logic changed.

## 2026-09-13: Ticket cues and Privacy/Memory explanations

- Tab-Tab keeps the existing shortcut layout with one adjacent decorative ticket
  icon, no hover or click behavior. Its existing visibility and input inset apply.
- Privacy and Memory headings use sentence case with compact, muted info icons
  and 24px click targets; this overrides the gear menu's old uppercase titles.
- Privacy and Memory use a 14px circled info icon with a filled dot and rounded
  stem, keeping it legible at Settings scale.
- Privacy and Memory have matching info buttons with the approved one-line cost
  descriptions. Hover/focus opens, click pins, outside click or Escape dismisses.
  Explanations render outside scrolling containers, have no shadow, and stay
  within the viewport. Both payment mode names open below the entire mode
  switch, with the tooltip’s right edge aligned to the switch’s right edge.
  The labels extend left into whitespace, keeping Share and the System Panel
  clear. Viewport clamping and an above fallback remain for limited space.
- Memory defaults off when no preference is saved, including imports without a
  feature preference. Explicit saved on/off choices and memory entries survive.
  Key issuance, cost/cap enforcement, and runtime availability gates are unchanged.
- This UI release starts at staging's b4bed57 and retains the published wallet
  SDK 06e3ee9; later wallet recovery commits remain on the feature branch.

## 2026-09-11: Disabled scrubber model explains its payment restriction

- The Settings scrubber model control shows the runtime's unavailable reason
  on hover and keyboard focus of its wrapper, including in zkAPI mode. The
  select remains disabled; returning to Tickets removes the wrapper's extra
  tab stop and explanation. Model preferences and capability gates are unchanged.

## 2026-09-10: Current Tinfoil chat models in Tab-Tab and Memory

- Added Kimi K3, GLM-5.3, GLM-5.3 Flash, DeepSeek V4 Flash, and Llama 3.3 70B
  to the shared confidential-model allowlist. Tinfoil's public model catalog
  confirms these IDs and tool-calling support. Gemma 4 31B and GPT-OSS 120B
  remain the Memory and Tab-Tab defaults respectively.
- Removed the unavailable Kimi K2.5 and GPT-OSS Safeguard entries. Saved
  selections of unavailable models fall back to each feature's default;
  Tab-Tab now validates stored and runtime choices as Memory already did.
- No key, provider, transport, or cap changes. The new choices are catalog
  verified, not live inference certified. GLM's always-on reasoning can consume
  request budgets before content appears; see [Local inference](local_inference.md).

## 2026-09-10: Tab-Tab preview hints keep their own space

- A pending scrub reserves 150px on the right of both the textarea and diff
  preview for the Control/Option shortcut hints. Hiding the initial Tab-Tab
  hint must not shrink that area while the preview/edit hint is visible.
- Changing pending state recalculates input height after applying the padding,
  so newly wrapped lines are visible immediately without another keystroke.
- The same inset keeps wrapped text aligned while holding Control or editing
  the preview. Clearing the pending scrub restores the existing input spacing.

## 2026-09-10: Saved deposits do not imply an empty wallet transaction queue

- A prepared deposit can coexist with a pending token-approval transaction if
  confirmation polling times out before the vault deposit starts. Its recovery
  notice now states only that the deposit did not finish and its amount/private
  note remain saved, and asks the user to check pending MetaMask transactions
  before resuming. It no longer claims that no transaction was sent or funds
  moved. This is a copy correction; submission and recovery behavior is unchanged.

## 2026-09-09: Read confirmed Sepolia balances after test-token minting

- The SDK dependency now includes the confirmed-block balance read. A successful
  Sepolia test-token mint could previously be followed by a cached `latest`
  balance, stopping funding with a false insufficient-balance error.
- Funding reads the balance at the mint receipt's block, verifies the canonical
  block hash and selected network before and after the read, and retries only
  reads for a bounded period. It never resends a mint during those retries.
- The change is confined to automatic test-token minting. Mainnet funding,
  withdrawal, private-note storage, and recovery journals keep their existing
  paths. An indexer that cannot catch up to the chain still blocks new proofs;
  a provider outage must be repaired without weakening that root check.
- A fresh Node 24 install of the pinned dependency passed 758 OA tests and
  180 native payment tests. The SDK's mint/read regression tests live with the
  SDK implementation; live transaction verification is recorded separately.

## 2026-09-09: Commercial payment modes retain ephemeral-key controls

- Commercial's ticket funding layout embeds the shared Ephemeral Access Key
  panel below its Membership launcher. Private-balance funding does not. The
  old top-section renderer inferred embedding solely from the host's ticket
  management action, so Commercial zkAPI hid the key, expiry, renewal, station,
  and attestation UI even though the runtime still loaded the active lease.
- `fundingSectionIncludesAccessKey()` now describes the selected funding
  renderer. Tickets retain their compact embedded layout when Membership is
  available; zkAPI always lets the shared top section render its key. Funding
  replacements must override this hook when they do not embed access controls.
- Render regressions cover standalone/Commercial, Tickets/zkAPI, pending/active
  keys, proxy and attestation controls, and switching back to Parallel Tickets
  during private settlement. The existing masking and lease ownership paths
  remain unchanged: a private chat binding is not a provider credential.

## 2026-09-09: Funding setup for first-time wallet users

- Removed the mainnet risk banner from both native funding entry points.
  The prerequisite sentence uses “Ethereum network” in the public UI.
  Mainnet now shows prerequisites and an optional guide to installing MetaMask,
  buying ETH for gas and USDC for chats, selecting Ethereum for both, and
  returning to confirm the deposit. Sepolia has its own free-test-token guide.
- `FundingSetupGuide.js` shares copy and restores the guide's expanded state,
  keyboard focus and scroll position when wallet refreshes rebuild a dialog.
  The deposit-focus guard now covers `fund` as well as `balance`. Welcome
  preserves the entered deposit amount after a canceled wallet attempt.
- See [Optional zkAPI payments](ZKAPI_PAYMENTS.md) for the official copy sources.
  No SDK, transaction, or transport behavior changed.
- Updated both stable trial deployments and checked the guides in Chrome.
  All 165 payment tests and deployed asset/provenance checks passed; see
  [SDK trial deployments](ZKAPI_SDK_TRIALS.md) for exact source and build IDs.

## 2026-09-09: OA owns optional zkAPI payments

- The dependency is now OA Chat → `@openanonymity/zkapi-browser-sdk`. The
  payment UI and chat adapter live in `chat/zkapi`; the SDK contains no OA UI.
- `startChatApp` preserves the synchronous `createChatApp` API and lazily loads
  the native payment adapter only when `OA_ZKAPI_NETWORK` selects a network.
  The build validates and emits pinned proof/config/worker assets and records
  immutable dependency provenance. Ticket-only builds keep their default path.
- Wallet storage/journals and chat storage remain unchanged and independent.
  Anonymous SDK protocol/manifest/config/daemon traffic now explicitly omits
  account cookies, including same-origin proxy requests.
- Plain Tickets deletion skips unrelated wallet state; private history stays
  recoverable, and delete-all checks even unloaded private owners.
- New deployments and verification results are recorded
  in [SDK trial deployments](ZKAPI_SDK_TRIALS.md).
- The new Sepolia origin completed a $5 deposit and live private-key/chat
  checks. Auto Router's returned DeepSeek V4 Flash 0731 model was displayed,
  and the $0.007184 private estimate matched settlement. Ticket continuation
  completed before private settlement, retaining history without adding the
  ticket response to private usage. A `≥ $6` model was blocked at a $4.99
  balance without losing the draft. A new $1-cap Luna chat worked across
  reload with its history and estimate retained. Withdrawal's automatic
  settlement brought total usage to $0.00746. After wallet confirmation, the
  UI reported $4.99 returned and payment history showed the completed mutual
  withdrawal and original $5 deposit. Successful public receipts reconcile
  $5.000000 deposited as $4.992540 returned to the same depositor plus
  $0.007460 paid to the server, excluding gas. Post-withdrawal reload retained
  both history entries, both Luna responses and their $0.000274 estimate,
  with the wallet correctly showing $0.00/not funded. Ticket continuation
  still recalled the conversation after the relay was explicitly re-enabled;
  its final response used TLS-over-WSS without new OA errors. The funded
  Sepolia flow is verified through mutual withdrawal and reload persistence.
  Switching the empty balance back to zkAPI automatically reopened funding;
  no further deposit was started, and both trial tabs were preserved.
- The funded browser run exposed inherited relay behavior: a verifier relay
  connection failure triggers immediate direct fallback, then RightPanel's
  error listener persists `enabled: false`. The resulting unavailable status
  and `Enable relay` action do not imply a user toggle, and later requests can
  remain direct across reloads. SDK extraction did not add this policy or a
  second proxy instance. Treat this as a transport-privacy limitation of the
  trial, not a verified relay-preserving recovery; the detailed source path
  and follow-up are recorded in the trial notes. Live Tinfoil and mainnet
  wallet transactions remain untested, as do balance expiry and escape-hatch
  withdrawal.
- See [Optional zkAPI payments](ZKAPI_PAYMENTS.md) for build, deployment,
  lifecycle, and origin/persistence details. Commercial composition is outside
  this change; account onboarding remains the host's policy.

# App State and Handoff

## 2026-09-22: Recover zkAPI chats interrupted during key issuance

- A failed first Send can retain an ownerless SDK proof journal while the server
  lease remains `provisioning`. The pinned SDK's settlement does not advance
  this status, and scoped settlement may return without touching the journal.
  Do not use `activeLease === null` or a successful scoped call as proof that
  the wallet is clear.
- The host compatibility adapter replays only the original saved request under
  the SDK wallet lock, verifies the recovered key, retires it without exposing
  it to inference, and applies the SDK's signed receipt. Recovery preserves
  other-chat/other-tab ownership and retains the journal on all failures.
- New Chat, deletion, renewal and withdrawal share bounded settlement. Stop
  waiting releases UI waiters and aborts recovery where supported; it does not
  forget a still-running SDK mutation. Retry cannot overlap that work. Error
  status and recovery controls remain visible even if the SDK's last activity
  still says settling. Deletion now retries ownerless recovery too.
- An issuer outage can still block deletion/withdrawal until the reserved
  request is reconciled. Clearing browser storage or inventing zero usage would
  risk losing funds; neither is part of this fix. See
  [Interrupted temporary-key issuance](ZKAPI_PAYMENTS.md#interrupted-temporary-key-issuance).
- Validation after rebasing onto current main: 886 core and 292 native payment
  tests pass, including real pinned
  SDK methods with simulated network/storage/proof boundaries. The zkAPI Sepolia
  production build succeeds. Desktop/mobile browser checks exercise Stop waiting
  and Retry with simulated settlement state; no live funded outage transaction
  was performed. Adversarial review approved after bounding deletion discovery,
  preserving daemon settlement, and serializing concurrent deletion scopes.

This is the living handoff doc for the web app's current state. Use it to capture UI
behavior, coupled state, implementation gotchas, and lessons that are easy to miss when
reading code alone.

## 2026-09-22: CLI Ethereum funding without an external wallet

- `oa-chat fund` now prints a daemon-owned funding address and public balances;
  `fund --amount USDC` explicitly signs approval/deposit locally and waits for
  activation. Mainnet remains default, Sepolia explicit. `--browser` is an
  optional view of the same flow; `--no-open` retains the capability URL mode.
  Neither address reads, service startup, nor page reload authorizes spending.
- The local Ethereum key and signed-transaction journal belong under
  `funding/<network>/address-funding.json`, distinct from private note recovery
  in `pending-deposit.json` and companion state in `zkapi/<network>/`.
  Back up the whole private config directory. Ambiguous broadcasts replay exact
  signed bytes; a different amount or existing private note is never replaced.
- Funding RPC uses the existing mandatory anonymous Wisp transport. Public
  transfers/deposits remain public; no wallet/account identity, signing key,
  or note secret is introduced into inference or the browser page.
- Successful approvals may progress before finality, so history recovery must
  replay the exact prior approval even when a crash/fee failure happened before
  signing its successor. Failed receipts require finality before entering the
  explicit-retry state. Retired finalized failures stay in nonce history with
  a marker so they cannot be restored as unresolved approvals after restart.
  A missing companion note after activation blocks further funding; it is not
  proof that the old note was closed.
- The published `daemon-v0.1.0` installer still installs the earlier MetaMask
  implementation. Address funding needs a build of this revision and a future
  native release. Existing Sepolia live validation below belongs to the older
  implementation. See [CLI funding](../daemon/docs/CLI_ZKAPI.md) for recovery and limitations.

## 2026-09-22: First CLI prerelease published and installation verified

- [`daemon-v0.1.0`](https://github.com/OpenAnonymity/oa-chat/releases/tag/daemon-v0.1.0)
  was published at 14:41 UTC as a GitHub prerelease with 11 assets. The exact
  `releases/download/daemon-v0.1.0/install.sh` command and custom-prefix example
  are available. Homebrew tap and AUR publication remain separate, unfinished
  release steps.
- GitHub's repository-wide `latest/download` URL excludes prereleases. An
  exact-tag URL works for both stable releases and prereleases; no version
  suffix or installer change is needed for the GitHub prerelease flag. Keep
  `latest/download` as an optional future stable-release command.
- [Release CI](https://github.com/OpenAnonymity/oa-chat/actions/runs/35740027874)
  passed Go/installer tests, native builds, executable smoke checks on all four
  targets, and assembly. GitHub asset digests matched `SHA256SUMS`; native
  library dependencies matched the documented platform requirements.
- Public installation passed on macOS ARM64 with a custom prefix containing
  spaces and on clean Ubuntu 24.04 ARM64 as an unprivileged user with the
  default prefix. Both executables and all five proof assets passed. Linux
  reinstallation retained the previous release, activated a complete new one,
  and left no configuration or stale lock. See the
  [dated validation record](../daemon/docs/CLI_PACKAGING.md#published-prerelease-validation-2026-09-22).

## 2026-09-21: One-command CLI installer

- `daemon/install.sh` installs checksum-verified native macOS/Linux AMD64 or
  ARM64 bundles into a user-owned prefix, defaulting to `~/.local`. It checks
  the OS/runtime baseline and both executables before switching the active
  release. It never initializes configuration, funds a wallet, changes shell
  startup files, or starts a service. See [installation and upgrades](../daemon/docs/CLI_PACKAGING.md#one-command-installation).
- Release assembly fills the script's single `@@VERSION@@` placeholder,
  includes `install.sh` in `SHA256SUMS`, and attaches it to the draft daemon
  release. The published script downloads its own exact version; it does not
  resolve a second moving latest-release URL for the binaries. The source
  script requires `--version` until release assembly fills the placeholder.
- Launchers in `PREFIX/bin` point through `PREFIX/lib/oa-chat/current` to a
  complete release containing `bin` and `share`. This layout is required:
  `oa-zkapi` resolves symlinks before finding `../share/oa-chat/proof-setup`.
  Updating retains the previous release directory and refuses unrelated
  launchers. Stop/restart an active daemon around upgrades. Private config,
  tickets, and wallet state stay outside the installation tree.
- The package's systemd unit hardcodes `/usr/bin/oa-chat` and is not installed
  by the user-prefix script. Homebrew and distro packages retain their own
  service workflows. The standalone installer prints PATH/foreground setup
  guidance; it does not register a second managed service.
- CI exercises the installer with local release fixtures on Linux/macOS and
  before native release builds. The September 21 implementation did not publish
  a daemon release, tap, or AUR package; the September 22 release is recorded
  above. An exact `daemon-vVERSION/install.sh` URL stays version-pinned and
  supports prereleases. The latest-download URL is repository-wide and requires
  a stable daemon release marked as latest.
- Cleanup must inspect the committed `current` link before deleting a staged
  bundle: a signal can land between its atomic rename and the success flag.
  EXIT-trap state must outlive `main`'s locals, which Bash 5 unwinds on implicit
  command failure. Regression tests cover both boundaries on macOS and Linux.

## 2026-09-10: Funded Sepolia CLI streaming and settlement verified

- The live flow now passes: MetaMask test-token mint/approval/deposit → private
  note activation → local Groth16 proof → OA-verified provider key → streamed
  inference → automatic signed-state recovery. Open WebUI 0.11.3 used
  `oa-sepolia.openai/gpt-4o-mini`, starting at `2026-09-10T20:50:48.081Z`.
  First visible content arrived at 13.815 seconds, with eight partial-content
  frames before completion at 15.277 seconds. These timings include access
  preparation and browser rendering. See the
  [browser evidence](../daemon/packaging/validation/openwebui-sepolia-stream.json).
- Independent read-only settlement checks observed `finalized` at 20:56:01 UTC:
  actual usage/charge was 0.000723 USDC (723 microcredits), balance changed
  100000 → 99277, pending cleared, and exactly one durable key handoff existed.
  The 0.05-USDC lease limit is a cap, not the debit. The earlier rejected lease
  settled without reducing the balance. The undeployed early-settlement patch
  assumes full-cap billing and is unsuitable for this metered deployment;
  redesign and validation are required before using it. See [details](../daemon/docs/CLI_ZKAPI.md).
- After settlement, one new independent direct SSE request passed HTTP 200,
  delivered 100 content events, first content at 7.081 seconds and `[DONE]`
  at 7.843 seconds. Catalog and authentication checks passed. See the
  [API evidence](../daemon/packaging/validation/sepolia-direct-stream.json).
  Browser content frames are not SSE token counts; the API test verifies raw
  framing separately. Automatic Open WebUI background tasks were disabled.
  This second lease finalized at 21:03:36 UTC, charging 65 microcredits
  (0.000065 USDC), moving balance 99277 → 99212, clearing pending, and leaving
  two durable key handoffs. No extra request was made to observe settlement.
- Remaining limits: each provider key is handed out once, so independent API
  calls wait for the prior lease's settlement (about 4.5 minutes plus grace in
  this deployment). The Go CLI did not implement withdrawal at this September
  10 revision; the current [CLI withdrawal flow](../daemon/docs/CLI_ZKAPI.md#withdraw-without-connecting-a-wallet)
  is documented separately. Public Sepolia metadata does not disclose its
  OA-org issuer URL, so that issuer's staging
  status remains unknown. The live tests used the owned temporary Wisp helper
  through SSH after the public relay failed; its four-hour lifetime and local
  tunnel must both remain healthy. No direct-transport fallback was used.
- The first funded request proved and issued a lease, then failed the old
  native equality check on signed-key and lease expiry. The deployed server
  shortens the usable lease by 30 seconds; the browser permits a signed expiry
  covering it by 0–60 seconds. The fixed companion uses checked subtraction,
  preserves the original signed expiry in verifier submissions, and returns
  the shorter lease expiry to Go. Active boundary and HTTP/bridge tests pass.
- The successful deposit was wrapped by MetaMask: its outer recipient was an
  execution contract while the configured vault emitted `NoteDeposited`.
  Receipt status plus the exact vault event/commitment/amount/note/expiry bind
  the deposit; requiring `receipt.to == vault` incorrectly rejected it.
  Recovery activated the original 0.100000-token note without another deposit.
- Wallet handoffs require a persistent daemon. A foreground tool session
  stopped after a successful mint, causing the next local path request to fail.
  The test service now uses launchd job
  `ai.openanonymity.cli-sepolia-e2e-20260910`, configured by
  `/tmp/oa-cli-sepolia-e2e-20260910.plist`, with the same private state directory.
  A restart invalidates funding capabilities: renew and reload before recovery.
- Earlier gas failure was RPC admission, not a mined revert: MetaMask supplied
  21,000,000 gas above the 16,777,216 cap when the page omitted an explicit
  estimate. Mint/approval/deposit now simulate the exact call, use the SDK's
  20% plus 50,000-gas margin, reject failed/oversized estimates, and recheck
  account/chain afterward. The connected wallet's approval estimate/limit was
  26,363/81,635 gas; mint 51,353/111,623; deposit 6,814,110/8,226,932.
  Fee rates remain MetaMask's choice. Never fall back to a guessed gas limit.
- The original flow also omitted missing test-token minting. Both Go and browser
  now require chain 11155111 plus the deployment's explicit demo flag, mint only
  the missing amount, and verify balance at the canonical receipt block. RPC
  lag retries reads without another mint. Existing balances and allowances are
  reused across expired sessions. Mainnet never enters the demo-mint path.
- Earlier unfunded Open WebUI and wallet-preflight records are retained as
  historical failure-path evidence; they no longer describe the current funded
  validation result. Wallet confirmations were performed by the user because
  browser security policy prohibited controlling the extension or alternate
  surfaces. The allowed local funding page was exercised through computer use.

## 2026-09-09: Go local API daemon and service packages

- The standalone `daemon/` Go module exposes OpenAI models/chat completions
  with immediate SSE flushing for Open WebUI and other clients. See
  [CLI setup and validation](../daemon/README.md), [ticket recovery](../daemon/docs/CLI_TICKETS.md),
  [zkAPI companion/funding](../daemon/docs/CLI_ZKAPI.md), and [packaging](../daemon/docs/CLI_PACKAGING.md).
- Ticket blinding uses CIRCL with browser interoperability tests. Wallet
  mutations use a process-shared lock and durable reservations. Each API call
  obtains a separately verified key; client identity headers/metadata are stripped.
- zkAPI retains its Rust prover as a supervised authenticated companion. Go
  owns streaming and self-hosted MetaMask funding. Companion HTTPS uses a
  local authenticated CONNECT bridge over Wisp. Mainnet is default, Sepolia
  explicit. Leases are single-use across requests/restarts; current servers
  may require waiting for settlement before the next request.
- Live ticket issuance passed at `org-staging.openanonymity.ai`; the dotted
  historical hostname is stale. The verifier intentionally returns 16 hex:
  browser `_hashKey()` truncates SHA-256 to eight bytes, matching the deployed
  verifier. Requiring 64 hex was a daemon implementation error, now corrected
  with exact 16/full-64 comparisons on the key-specific HTTPS response while
  retaining station/status checks. No verifier server change is needed.
  The public Wisp relay closed before its handshake; tests use a temporary
  relay on the staging host via SSH, with no direct-transport bypass.
- Live staging ticket inference now passes: 114 content events, first content
  at 3.329 seconds and `[DONE]` at 4.183 seconds, including access preparation.
  The temporary SSH forward must remain alive independently of the remote
  Wisp process; a healthy remote helper does not guarantee a local listener.
- Open WebUI streaming passed both with the deterministic fixture and with
  real staging tickets/OpenRouter inference. The live browser recorded 38
  content updates, first content at 3.329 seconds and completion at 6.095 seconds.
  Evidence and screenshots are linked from [the daemon README](../daemon/README.md). Its automatic title/tag
  requests cost extra access and conflict with pending zkAPI settlement.
- Homebrew install/start/stop passed. Linux packages were built and inspected;
  publishing and Linux boot tests remain distinct from that validation record.
  Real MetaMask/Sepolia funding and inference later passed on September 10,
  as recorded above.
- Computer use of the MetaMask extension page was rejected by browser security
  policy, including alternate control paths. On September 10, computer use of
  the local funding page progressed through wallet connection to the exact
  0.100000 test-USDC allowance prompt. A user-reported submission was rejected
  before broadcast for an excessive gas limit; see the September 10 fix above.
  Subsequent user confirmations and the compatibility fixes completed the
  Sepolia deposit, streamed inference, and settlement on September 10; see the
  current result above.

## 2026-09-08: Payment runtime reconciled with current account and UI baseline

- `codex/zkapi-browser-sdk` combines the payment runtime changes with the current
  account/settings baseline (`1380827`). Captured-session send, settlement,
  metadata and deletion reservations remain authoritative during navigation.
- The shared navigation helper now persists every owned selection, including
  forks and clearing the current chat, while retaining the payment branch's
  stale-navigation guards. Its versioned tab record preserves an explicit new
  chat across return navigation.
- Host-required sign-in and the visible-modal send guard apply before either
  payment path. Accountless compositions still skip authentication bootstrap
  and auth-intent handling. The optional account component factory coexists
  with the newer settings dialog.
- Memory import/export retain the newer ability to run with the global Memory
  preference off; payment capability guards still prevent unavailable composer
  actions. Streaming awaits buffered reasoning before content and preserves
  returned-model pricing alongside interleaved reasoning segment formatting.

## 2026-09-08: Shared model tiers and private-key budgets

- Trusted compositions can import the lightweight `chat/publicModelTierApi.js`
  seam, or `publicRuntimeApi.modelTiers`, for `getTicketCost`,
  `ensureModelTiersReady`, `initModelTiers`, and `onModelTiersUpdate`. Both paths
  share the ordinary OA tier cache and live map. Cached and heuristic values
  support display; access issuance must await the live tier map. Dollar budgets
  belong to the downstream payment policy, not the shared ticket service.
- `presentation.getModelPricing(model, {reasoningEnabled})` receives the same
  reasoning setting used for ticket pricing. Optional escaped
  `balanceBadgeLabel` and `balanceBadgeTooltip` fields show the required private
  balance in the same right-aligned badge position and style as ticket counts.
  zkAPI uses concise labels such as `≥ $2`; the accessible tooltip explains
  that a private balance of at least that amount is required. Token prices
  remain below the model name, with no separate cap/minimum explanation line.
  Omitting these fields preserves the existing presentation and ticket rows.
- The zkAPI composition maps reviewed OA ticket tiers to public dollar buckets.
  A key's cap is a cumulative usage limit and minimum balance proof, not an
  upfront fee. Its System Panel displays the actual owned key cap while that
  key is live; otherwise it uses the selected model's budget.
- `renderCurrentModel()` notifies the optional right-panel
  `onModelSelectionChange()` hook. The private panel updates only its existing
  usage labels, so selecting a different model immediately updates the next
  key cap without remounting billing controls or waiting for wallet activity.

## 2026-09-06: Composer capabilities follow the owning payment mode

- Products may supply `runtime.supportsFeature(feature, session)` and
  `getFeatureUnavailableReason(feature, session)`. The ordinary app keeps every
  existing feature; mixed products can retain the normal controls while limiting
  Memory, Scrubber, or Parallel per payment method. Global Memory and Parallel
  preferences and historical Council configuration stay intact when switching.
  The System Panel also gates lane-key rows by capability so an unavailable
  historical or pending Parallel choice still presents the single-key access panel.
- The composer leaves its scrubber shortcut area empty when the payment method
  does not support Scrubber. Switching back restores the normal shortcut hint;
  unavailable mode reserves no hint space and shows no replacement message.
- Memory retrieval and background extraction both require a separate confidential
  Tinfoil key funded with tickets. Gate these flows, one-shot memory overrides,
  stale approvals, and uncached Scrubber restoration by their captured session.
  A visible chat in another payment mode must not change background ownership.
  Cached scrubbed/restored text and existing Parallel transcripts stay readable.
- `beginFeatureOperation` owns confidential work through its complete promise;
  its abort signal never releases an unfinished request. Mode changes and Delete
  drain this work. Empty-draft work captures its default backend and can bind the
  created session through `bindFeatureOperation`; components finish in `finally`.
- Backfill writes `memoryProcessedAt` through `updateMemoryProcessedAt`, which
  merges into the current live session under a metadata reservation. Never save
  a stale candidate record over a newer payment mode, lease, or deleted chat.

## 2026-09-06: Routed response usage pricing

- Streaming usage snapshots carry the returned model's catalog price as soon
  as its ID arrives, before output or usage in the same SSE event. Exact model
  variants take precedence over their base ID. An unknown response model has
  no local price; it must not inherit Auto Router's rate.
- Runtime accounting accepts the backend's price snapshot (including an
  explicit `null`) and only falls back to the owning session's catalog when
  pricing is absent. It never overrides returned-model pricing with the
  requested model's rate or a different visible chat's catalog.
- A late `modelOnly` event reprices the existing usage preview while retaining
  its token counts and provider cost. Metadata alone still creates no durable
  charge. Cancellation with partial output retains the repriced snapshot.
  Completed usage and the later message metadata write use the same pricing.
- Products persist these response-time snapshots with usage; historical totals
  are not recalculated against today's model catalog. This changes estimates
  only, not the requested model, access budget, or settlement amount.

## 2026-09-06: Runtime payment modes share the same conversation

- Trusted runtimes can choose ticket access per session with
  `usesTicketAccess(session)`. A false result requires explicit `checkCanSend`
  authorization and skips ticket-tier loading during key acquisition. The
  normal ticket and verifier path remains unchanged for ticket sessions.
- `context.changeSessionBackend(backendId, {sessionId?})` captures the chosen
  conversation, reserves its exclusive mutation, drains outstanding title,
  access and Quick Ask work, and awaits `beforeBackendChange`. Its hook receives
  a staged clone so lease settlement metadata and the backend are persisted in
  one session write. Failed settlement or storage keeps the live backend and
  recovery metadata. New Send, Quick Ask, title and access work cannot enter
  during the transition; Delete waits for its reservation before removing data.
- Switching clears active access, old verifier failure presentation, shared-key
  marking and Council lane access, while retaining message history, historical
  ephemeral mappings, title, draft and attachments. It never navigates or
  rebuilds the conversation. Model refreshes reject stale results after
  navigation or another backend selection. All configured verifier caches
  initialize before persisted access is restored, even when the default mode
  uses an alternate payment backend.
- `context.isSessionBusy()` lets a mode selector disable itself during any
  owned work. `presentation.renderComposer` is notified as Send, title, Quick
  Ask, access and exclusive mutations start/end, as well as navigation.
- Mixed runtimes can set `shouldCancelOnNewChat({session})` so ticket chats
  continue streaming in the background while paid chats retire their lease.
  `onNewChat` still runs synchronously to establish any retirement barrier.
- Empty-composer mode changes only change the inference service default. Send
  captures that default before its first await, and new session creation retains
  the captured backend. Products own durable preference storage and may call
  `setDefaultBackendId()` after switching an existing conversation to choose
  the next chat's default. Unknown explicit backends fail closed rather than
  routing a request through another payment mode.
- Legacy sessions and imported keys without a backend use the registry's
  stable `legacyBackendId` and optional `resolveLegacyBackendId(session)`,
  independently of the preferred new-chat mode. A dual product must identify
  historical ticket sessions as `openrouter`; provider API keys must never be
  interpreted as alternate-backend session bindings.
- Historical/new-chat navigation replaces the prior backend's model catalog
  synchronously with the destination's cached catalog before refreshing it.
  Ticket key request/renewal reserves its captured session before animations;
  navigation cannot redirect redemption or apply its key to another panel.
- Background ticket requests keep their backend's catalog for ticket pricing,
  key acquisition, response model resolution, Quick Ask and usage estimates.
  `getModelsForSession(session)` and `context.getModels(sessionId?)` must replace
  reads of the visible `state.models` in inference work that can outlive
  navigation. Model configuration callbacks receive the captured session.
- Rename, star/unstar and model selection reserve session metadata persistence.
  A mode switch cannot snapshot over an in-flight metadata write, and those
  controls acknowledge busy while settlement holds an exclusive reservation.
- `publicApi.js` additionally exports the ordinary Account and Welcome UI;
  `publicInferenceApi.js` exports the normal `openRouterBackend`; and
  `publicRuntimeApi.js` exports the shared `modelConfiguration` namespace for
  compositions that offer ticketing alongside another funding method.
- The shared attestation modal describes the selected payment method rather
  than assuming ticket redemption. Its issuance overview describes the
  available checks without claiming a current key has verified issuance proof.
  ZK runtime attestation and station broadcast evidence are distinct from the
  ordinary ticket key's signatures and persisted `submit_key` proof; this copy
  change does not create missing key evidence or alter any security checks.

## 2026-09-06: Vercel Git builds restore the memory browser link

- Vercel Git builds were receiving the initialized root `nanomem` submodule but
  omitting the tracked `chat/nanomem -> ../nanomem` symlink. A diagnostic build
  confirmed root `nanomem/browser.js` exists while `chat/nanomem` is absent.
  `prepare:nanomem` passed because it checks the root source directory; esbuild
  subsequently failed the three `../nanomem/browser.js` imports in chat services.
- `scripts/build.mjs` now runs `prepareNanomemBrowser(...)` before copying and
  bundling. It validates both root browser entrypoints and recreates the missing
  link (or an exact Git link-text placeholder). Valid local symlinks and packaged
  directories remain unchanged, and unrelated existing paths fail explicitly.
- Copying root `nanomem` into `dist` cannot fix this alone: esbuild reads the
  original `chat/` source. Keep the source link valid through bundle creation.
- The existing `.vercelignore` includes the root submodule and its descendants;
  this failure does not require widening the upload allowlist or restoring Git
  metadata. Keep the final `.git` and `.env*` exclusions intact.

## 2026-09-06: Auto Router response model attribution

- Assistant responses show the model reported by inference, with its provider
  icon, as soon as that metadata arrives. The selected session/composer model
  stays Auto Router; subsequent turns and regenerations continue routing.
- Response IDs resolve through the existing local catalog and display-name
  overrides, with the returned ID as the fallback for uncatalogued models.
  Never pass the requested router name as a concrete response ID's fallback.
  If the provider does not identify a different model, retain the selected name.
- The shared SSE parser publishes `modelOnly` token callbacks before processing
  output from that event. These callbacks update attribution but are not output
  or new token/cost measurements. Runtime accounting merges the model and its
  price into its latest usage snapshot; cancellation retains that attribution.
- Ordinary Chat persists the resolved name/ID in the existing `message.model`.
  Parallel/Council lanes keep their requested `model`/`modelId` for access and
  regeneration and store separate `responseModel` attribution. This survives
  history reload, export, and sharing; regeneration clears the old lane result.
- Live header updates patch only the model label/icon, including the standalone
  waiting indicator before the first output chunk, scoped to its owning session.
  Completed reasoning's
  optimized final-render path must refresh this header too. All returned model
  labels are escaped or assigned via `textContent`; attribution adds no requests
  or account metadata. Old responses saved only as Auto Router cannot be
  retroactively attributed without their original provider metadata.

## 2026-09-06: Composer live announcements stay visually hidden

- `Message accepted.` and `Response complete.` are screen-reader announcements,
  not visible composer labels. Keep the single `chat-operation-status` node and
  its `role="status"`; do not remove it or use `display: none` / `aria-hidden`.
- The shared `styles.css` owns the `.sr-only` accessibility primitive so all
  consumers stay clipped and out of layout even when a composed build copies an
  older generated Tailwind stylesheet. This applies in both themes and reduced
  motion. Do not fix future leaks only in a downstream payment-specific class.

## 2026-09-05: Product UI composition keeps the shared renderer

- Optional `ui.components` factories replace only Account, Welcome, and the
  right-panel funding integration; ordinary OA uses its existing components.
  Downstream funding panels extend the public shared `RightPanel` and override
  `generateFundingSectionHTML()`, preserving the shared key/proxy/activity UI.
  Do not extract markup using comment markers or copy a snapshot of RightPanel.
- `ui.presentation` supplies plain model-price copy, a session-operation badge,
  and a detailed pending presentation. Product-specific progress calculation and
  copy stay downstream. The default ticket product keeps its existing pending
  labels and model ticket prices when no presenter is installed.
- Pending details belong only in the assistant placeholder. The generic
  `preparing-access` phase is not model reasoning or response output. Rendering
  and updating use the same presenter for both a live placeholder and a restored
  streaming session. Updates mutate keyed progress steps and text in place;
  identical visual snapshots are no-ops so a timer cannot close a disclosure or
  restart its animation. The hidden accessibility announcement must remain
  visually hidden; it is not a second visible status paragraph.
- A downstream `ui.integration` object is an explicitly supplied component
  capability, not access to the underlying ChatApp. Product services can be
  injected through `ui.services`; shared data, inference and UI facades retain
  their existing boundary. Never place wallet or credential secrets in progress
  presentations or session-status copy.
- The UI inference service defaults to the controller's configured runtime
  service, not a separate default backend. Renewal, access display, and key
  tests must use the same backend as real inference. A semantic runtime
  transition can notify the product right panel through
  `onRuntimePresentationChange`; clock-only data must not remount the panel.
- Optional `ui.mountShell` runs once after component construction. Product
  shells must move existing controls rather than clone them so focus and event
  handlers survive; state refreshes must never rerun shell mounting.
- Regenerate and Resend capture their session and prompt IDs before yielding,
  reserve an exclusive timeline mutation, and acknowledge conflicting actions
  on the initiating button. They must not truncate the newly selected chat
  after navigation. Sidebar deletion remains visibly busy until the controller
  has stopped outstanding jobs and completed durable deletion.
- A response with `finishReason: 'length'` offers one assistant-side Continue
  action. Other finish reasons and user messages do not show this action.
- Memory API overrides live only in an in-memory map keyed by session ID.
  Async augmentation, approval recovery, file processing, Parallel lanes, and
  cleanup all use their captured owner. Never restore a single global override:
  simultaneous work in another chat could otherwise inject private context into
  the wrong request. Each entry has a revision, separate from the global Memory
  feature generation, so a changed approval within the same generation is
  reprocessed before inference. Turning Memory off invalidates all entries;
  finishing one chat clears only that chat.
- `updateInputState` preserves send-button descendants when the semantic icon
  state is unchanged. Navigation briefly disables input and Send with a loading
  indicator; background preparation leaves drafting and cancellation available.
  Repeated refreshes must not restart the progress animation.
- Send captures session, draft, attachments and request settings before its
  first await. Its acceptance callback runs only after the message and parent
  session transaction commits, before optional indexing/title/UI work. Raw
  attachment File objects remain durably retryable until conversion succeeds;
  delayed conversion cannot recreate deleted history or overwrite edited files.
- Fork persists its transcript atomically. It may snapshot an active response
  without interrupting ordinary OA streaming. Product runtimes can decline
  access reuse and transform copied billing metadata. Background writes never
  navigate unless the initiating action still owns the selected view.
- Delete first drains captured send/title/Quick Ask/attachment/timeline work,
  then runs the product recovery hook and atomically removes session/messages.
  A failed recovery hook retains history. A delete completing after navigation
  cannot clear the new chat's draft or change its URL.
- Accountless compositions skip account bootstrap, automatic unlock and
  authentication-intent routing, including `?auth=google`; their extension auth
  capability fails explicitly. Standalone/commercial account behavior remains
  enabled by default, with the existing verified-ticket path unchanged.
## 2026-09-06: First-time accounts go straight to the passkey too

`maybeAutoPromptPasskey()` now also fires for `oauthSetupRequired` (first
Google keyring setup), and `handleAccountContinue()` chains
`handleUsernamePasskeyContinue()` when the lookup returns `register`
(reserve + WebAuthn create) as well as `login`. The setup card lost its
"Encrypt your data" heading; like the returning path it is untitled
(`aria-label="Create your passkey"`), hidden behind the spinner while busy,
and only drawn for Try again / Back. Legacy migration and legacy-passkey
cards are unchanged.

## 2026-09-06: One continuous wait from the landing button to the passkey sheet

`chat/index.html` paints `#auth-arrival` — the same dim backdrop and spinner
as the account dialog's waiting state — from an inline script and style that
run before any stylesheet, whenever the URL carries `?auth=google`,
`?auth=username` or `?tickets=`. `AccountModal.open()` removes
`html[data-auth-arriving]` once its own backdrop is up, and `app.js` removes
it in the `finally` of `routeAuthenticationIntent` so it never outlives the
route. The username lookup ("Checking username…") is drawn the same way:
untitled card with `data-waiting`, spinner only, status text for assistive
technology. Net effect: landing button spinner → page load → lookup → OS
sheet with no blank frame and no card in between.

## 2026-09-06: Login dialog matches the landing card; spinner behind the passkey prompt

The **Log in** dialog's username step is a standalone **Choose a username**
field followed by a full-width filled **Continue with username** button
(`.account-login-submit`, #000 / near-white in dark, hover lift), the same
control as the landing card; the attached arrow cell is gone. While the
automatic passkey prompt is in flight the dimmed page shows only a small
spinner (`.account-unlock-waiting`, role=status) — no card, no text — and
the untitled card fades in only for Try again.

## 2026-09-06: The core Account item hides through the app facade

`AccountModal` reaches extension slots only via the component facade
(`appInterface.js`): `refreshExtensionSlot`, and the new
`hasExtensionSlotNode(name, selector)` and `subscribeExtensionSlot(name,
listener)`. The earlier `this.app.extensionSlots?.…` calls were `undefined` in
the real app (the facade never exposed the registry), so the core Account
fallback was never hidden and the menu showed two Account entries on staging.
`accountModal.test.js` now asserts the component never touches
`app.extensionSlots`.

## 2026-09-06: Nothing is drawn behind the automatic passkey prompt

The untitled unlock card carries `data-waiting="true"` while the automatic
prompt (Google keyring or returning username) is in flight, and CSS hides it
(`opacity: 0; pointer-events: none`). The OS passkey sheet is the only thing
the user sees; the card stays mounted for focus and the status sentence and
fades in only for Try again. `.account-menu-item[hidden]` now actually hides,
so the core Account fallback item no longer shows beside the extension's
Account item in the composed app.

## 2026-09-05: Returning accounts prompt their passkey on arrival

The "Welcome back → Unlock" explanation is gone from the returning-user flow.
`AccountModal.open()` calls `maybeAutoPromptPasskey()`, which runs
`handleOAuthKeyringUnlock()` once per open for a locked Google keyring (never
for setup, legacy migration, legacy passkey, busy, error or unsupported
states), and `handleAccountContinue()` calls `handleUsernamePasskeyContinue()`
as soon as a username lookup resolves to an existing account. The shared
`renderPasskeyUnlockCard` renders no `<h2>` for that returning case — the
dialog carries `aria-label="Unlock your encrypted data"` and the
`account-unlock-card-untitled` class — so the card only ever shows the waiting
and Try again states. Setup ("Encrypt your data"), legacy migration and the
legacy-passkey account keep their headings. Safari's user-activation rule for
WebAuthn is the known risk on the Google return path: a refused prompt lands
on the untitled Try again card rather than an idle one.

## 2026-09-05: The account menu prefers the composed Account surface

When `account.menuActions` has mounted content, the core
`#account-security-menu-item` is hidden and the commercial extension's item,
labelled **Account**, opens the unified Account dialog (identity row, Get
tickets, Payment, Invoices), followed by the core **Log out** item. Standalone
oa-chat keeps the core **Account** item and compact account-security dialog, so
installing no extension never removes existing account management.
`context.ui.getAccountIdentityLabel()` gives extensions the signed-in display
name (username, else Google email) for that identity row; it deliberately
stays out of `account.getSnapshot()`. `renderCompactAccountUI` is no longer
reachable from the menu only in the composed commercial app.

## 2026-09-04: Compact Log-in hover matches Account controls

- On hover-capable pointers, the Google button and the complete username
  input/arrow shell use the same restrained background and border change as the
  Account `Unlock` button.
- Keep hover separate from OA-blue keyboard focus, suppress it for disabled
  controls, and do not add movement, shadow, or sticky touch hover.

## 2026-09-04: Reliable external returns and ticket recovery

- `navigationState.js` owns sessionStorage-only `oa-chat-navigation-v1`:
  either a conversation selection or explicit New Chat. It synchronizes the
  legacy `oa-current-session` key and removes that key for New Chat. Generic
  return loads restore this record before hydration; explicit `?s=` links keep
  precedence. Deleted conversations become New Chat; unavailable or malformed
  storage cannot block startup. The commercial host calls the opaque
  `ui.persistNavigationForReturn()` before Stripe navigation.
- Preparation reports waiting for storage, issuer, or locks separately from
  actual blinding/finalization. Existing staged recovery schemas, ticket fields,
  publication ownership, and account guards remain unchanged. Queued preparation
  and publication locks time out after 30 seconds without stealing ownership or
  timing out a running durable commit.
- `tickets.refreshSnapshot({ signal })` explicitly refreshes only browser-local
  account-scoped wallet state and exposes redacted counts/readiness. Both its
  wallet and nested account-data lock queues accept cancellation/deadlines;
  scope is rechecked after reading. Existing broadcasts remain authoritative
  notifications to refresh, never evidence that an unrelated purchase completed.
- Regression coverage: `navigationState.test.js`, `ticketRefresh.test.js`, and
  the existing entitlement recovery/account-isolation tests. Public interface
  details are in [EXTENSIONS.md](EXTENSIONS.md).

## 2026-09-04: Focus indicators do not use black UI boxes

- All app-owned focus treatments share a dedicated OA-blue focus token rather
  than the near-black light-theme foreground token. This covers the fallback
  `:focus-visible` outline, Tailwind ring utilities, and component-specific
  focus styles without changing non-focus borders. Controls with their own
  component treatment continue to override the low-specificity fallback, and
  pointer focus on non-text controls remains quiet.
- The model picker still focuses search immediately so users can type without
  a second click. Its full rectangular outline is replaced by a two-pixel blue
  underline on the existing search row, avoiding a black box while preserving
  a visible focus state. The underline clears when focus moves to the close
  button. Forced-colors mode retains a system `Highlight` outline.
- Model filtering, keyboard navigation, selection, modal focus movement, and
  light/dark theme tokens are otherwise unchanged.

## 2026-09-04: Account footer uses a unified disclosure chevron

- The bottom-left account identity row remains one full-width button. Its
  trailing affordance is now a downward chevron rather than a settings gear;
  the existing `aria-expanded` state rotates it upward while the account menu
  or Account dialog is open.
- The rotation uses the established 240ms ease-out disclosure motion and is
  disabled for reduced-motion users. The row is not rebuilt, so rapid reversal,
  focus restoration, pointer/keyboard menu behavior, and full-row hover/press
  feedback remain intact.
- This is presentation only. Account restoration, authentication, menu actions,
  Membership extension mounting, and logout behavior are unchanged.

## 2026-09-04: Account disclosure opens with invoice-style motion

- **Passkey & encryption** stays mounted and expands with the same 240ms
  grid-row easing used by Membership's **Invoices** disclosure. Content opacity
  settles during the height transition instead of appearing all at once.
- The collapsed panel is `aria-hidden` and `inert`; reduced-motion users receive
  the same state change without animation. The toggle still updates mounted
  nodes without rebuilding the Account modal, and no authentication, passkey,
  encryption, sync, or account-state behavior changes.

## 2026-09-04: Landing authentication handoffs require an identity match

- A restored account now satisfies `/chat/?auth=google` only when it is a Google
  account. A username or legacy account is logged out and its saved local binding
  is cleared before the Google sign-in surface opens.
- A restored username account satisfies
  `/chat/?auth=username#username=...` only when its NFKC-normalized, trimmed,
  lowercase username matches the requested username. A different username,
  Google account, or legacy account is logged out and cleared before the requested
  username lookup begins.
- Matching verified/unlocked identities still continue directly, while matching
  locked identities keep their normal unlock flow. Switching is automatic and
  does not add a confirmation prompt. A username handoff with no submitted
  username keeps the saved binding and shows the normal form.
- OAuth profile refreshes capture the account and lifecycle generation before
  requesting provider state. A response that finishes after logout, lock, or an
  account switch cannot repopulate provider metadata onto the cleared identity.

## 2026-09-04: Invoice-style Account disclosure chevron

- The signed-in Account dialog's **Passkey & encryption** disclosure uses the
  same 18px downward chevron and 240ms easing as Membership's **Invoices**
  disclosure. It rotates upward when expanded and disables the transition under
  reduced motion.
- Toggling updates the mounted `aria-expanded`, `aria-hidden`, and `inert` state in place
  instead of rebuilding the modal, preserving button focus and allowing the
  transition to complete. Authentication, passkey, encryption, and account
  state behavior are unchanged. Commercial compositions must pin the public
  Chat revision containing this change.

## 2026-09-04: Current-base modal title alignment

- Port the intent of old commit `9f660e0` onto public Chat `b37e246`; do not
  deploy or pin its obsolete `ca47d9d` parent. This preserves the later compact
  login, unified username/Google encryption, Memory fallback, Welcome-back
  no-logout behavior,
  Account focus, Membership, and invoice behavior in the commercial composition.
- `renderHeader()` and the compact login use semantic `h2.account-dialog-title`
  at 22px/600/-0.01em, matching Billing & Plan's title scale. The current
  left-aligned compact-login layout, 48px controls, 32px desktop/24px narrow
  card padding, radii, close target, body copy, and handlers remain unchanged.
  Its Google label alone moves from 16px to 15px.
- The shared Welcome/Encrypt title keeps its existing 26px size, line height,
  tracking, and card layout while moving from the newer 500 weight to the
  explicitly requested 600. The account-number and recovery headers use the same
  shared Account title rule.
- The sans stack puts `system-ui` and `-apple-system` before the named SF Pro Text
  font, allowing platform optical sizing for larger text. This is a global
  family-order change, so browser verification covers body copy as well as the
  compact Account, login, and Welcome surfaces in both themes and narrow widths.

## 2026-09-04: Focus rings are keyboard-only

- An inline script at the top of `chat/index.html` sets `html[data-keyboard-nav]`
  on Tab/arrow/Home/End keydown and clears it on pointerdown/mousedown/touchstart.
  It runs before any stylesheet or focus call.
- `chat/styles.css` draws the app-wide ring only under `html[data-keyboard-nav]`
  and forces `outline: none` on `:focus-visible` otherwise. Component rings
  (account footer avatar, menu items, compact rows, unlock/login controls,
  dialog close) are scoped the same way and retain the dedicated OA-blue focus
  token. Model search and the username-login shell are quiet when opened by the
  app and show their blue treatment only during keyboard navigation. Tailwind
  ring utilities are unaffected.
- Why: the app focuses elements itself — dialog open (`focusModal`), focus
  restore in `close()`, the model search input in `ModelPicker.open()` — and
  browsers report script focus as `:focus-visible` until the next pointer
  interaction. That lit rings on first load, unlock, the Account dialog's X,
  the footer avatar after closing, and under the model search. Prod
  (`origin/main`) has no global ring and is the reference behaviour.
- The earlier `data-auth-restored-focus` (footer) and `data-pointer-focus`
  (menu) markers were per-component workarounds for the same heuristic and are
  removed; `openAccountMenu` no longer takes `fromPointer`.

## 2026-09-04: Quiet pointer focus in the Account menu

- The menu still focuses its first item on opening for Escape/arrow navigation.
  Mouse/touch opening now sets a menu-local `data-pointer-focus` marker **before**
  moving focus. This suppresses the inherited focus-only outline and tint left
  by the login input, including on the Account row, without blurring the item.
- Any menu keydown removes that marker immediately. Keyboard/assistive activation
  (zero-detail click), ArrowDown/Enter/Space opening, and later arrow/Home/End
  navigation retain visible focus. Pointer interaction within the menu switches
  back to quiet focus; closing clears the marker. Normal hover feedback remains.
- This is menu presentation/input-modality state only: footer authentication
  restoration, menu actions, Membership, logout, and login routing are unchanged.
- `test/fixtures/account-menu-focus.html` uses the shipped footer markup with
  fake services to check post-auth focus, pointer reopening, keyboard navigation,
  and both themes without real authentication or billing.

## 2026-09-03: Lighter login typography

- The compact login card uses the supplied **Login Modal / 1a** proportions:
  16px Google text, an 18px outlined inline arrow, 48px controls, and a 22px
  medium heading with tighter line-height/tracking. Google text is regular (400)
  to address the requested lighter appearance, while retaining OA's system font
  and theme tokens. The smaller close glyph retains a 32px button target.
- The shared **Welcome back / Encrypt your data** title now uses weight 500,
  matching the **Account** title. Its size and layout are unchanged. These are
  presentation-only changes; auth handlers, Membership, and landing are untouched.

## 2026-09-03: Preserve the restored compact Memory fallback

- Restore the exact presentation fix from `40d9fad5bde7d7e0667666d91d73626b2cdd1ed7`
  (08:46 PDT, **Restore compact memory fallback**). That branch's fix was missing
  from the later combined login/Membership staging composition; do not revert the
  whole client or the membership work to recover it.
- Failed retrieval again says **No added memory. Sending original prompt.**
  with no extra bordered **Note:** card, including when older saved messages
  carry failure metadata. Allowlisted diagnostics, key invalidation, retrieval,
  extraction, and ticket-budget behavior remain unchanged. This restores the
  requested presentation; it does not claim to repair the underlying provider failure.

## 2026-09-03: Google and username share the encryption explanation

- Google and returning username unlock use the same centered **Welcome back** card,
  an outlined **Unlock** action, a disabled **Waiting…** spinner during the
  passkey prompt, and **Try again** with an alert on failure. Setup and legacy
  migration share the card with their own copy and existing action handlers.
- `renderPasskeyUnlockCard()` owns the shared copy, actions, and busy/error shell.
  Username Continue now looks up the account and pauses at **Welcome back → Unlock**
  or **Encrypt your data → Create passkey**. This explicitly supersedes the earlier
  direct-to-passkey request. The same step is used by landing and modal entry;
  landing still does not repeat the username form. Username uses **Back** because
  authentication has not occurred yet. **Welcome back** has no **Log out** action,
  including waiting/retry and legacy-passkey variants. Logout remains in unlocked
  Account settings; setup and legacy-migration cards retain their existing exit.
- No WebAuthn operation begins until that explicit action. Returning username
  Unlock obtains a fresh challenge, since the initial lookup challenge can expire
  while the explanation is open. New-account lookup is read-only: `/auth/init`,
  username reservation, and the registration challenge wait until **Create passkey**.
  Back before that click therefore leaves no ten-minute name reservation, and
  reading the explanation cannot expire a sixty-second registration challenge.
  Cancellation stays on **Try again**, never starts
  registration, and does not retry automatically. Back abandons an uncompleted
  registration without forgetting an existing saved account.
- Pending-account generation/object guards discard late initializer or native
  credential results after cancellation. Modal callbacks also belong to one
  open-view version. Username finalization briefly disables dismissal while its
  wrapper is committed, avoiding cancellation that zeroes the master key during
  registration. A separately cancelled finalization cannot install that key or
  overwrite a replacement account.
- The first-account Membership signal, returning-account Chat route, saved legacy
  recovery, encrypted sync, and post-login footer focus restoration remain intact.
- Escape and the compact close button dismiss the unlock card without
  decrypting data or signing Google out. Per the revised UI request, a returning
  locked Google account must unlock before reaching Account-settings logout;
  dismissal itself is not a signout/account switch. Successful unlock closes
  the card through the existing account lifecycle.

## 2026-09-02: Authentication intent waits for account restoration

- Successful authentication closes with `afterAuthentication: true`. If focus
  returns to the account footer, its temporary `data-auth-restored-focus` marker
  suppresses the automatic focus indicator: no black box, avatar ring, or
  focus-only tint remains after login/unlock. Focus still returns to the same
  button. Its next keydown or blur removes the marker, so later keyboard
  navigation shows the avatar's theme-colored ring (system `Highlight` in
  forced-colors mode). Ordinary dismissal, other return targets, menu focus,
  full-width hover/pressed feedback, and first-account Membership routing are
  unchanged. Do not replace this with unconditional outline removal or blur.
- The commercial landing page now hands Google entry to `/chat/?auth=google`;
  this is distinct from `membership=1`, which remains an explicit billing UI
  request. Core chat owns the one-use auth intent and removes it with
  `history.replaceState` after the initial authentication bootstrap settles.
- Initial account restoration has an explicit `authBootstrapComplete` state
  and `waitForAuthBootstrap()` gate. A remembered verified/unlocked account
  proceeds directly into chat; a verified locked account opens the encryption-
  passkey UI; and a genuinely signed-out account opens the Google UI. The
  signed-in Account summary is never opened by this route.
- The footer keeps stable compact geometry but renders no visible provisional
  identity until verification settles. A visually hidden live region announces
  account restoration to assistive technology. Opening the footer during that
  interval still shows the neutral restoration dialog; verified actions and
  commercial slots remain unavailable. The account-bound identity appears only
  when bootstrap completes, without caching it in `localStorage`. Profile
  refresh and encrypted sync continue in the background.
- Encryption-passkey errors are classified at the failing stage. Only a
  `NotFoundError` from `navigator.credentials.get()` becomes “passkey not
  available in this browser profile or private window.” A successful WebAuthn
  unwrap followed by IndexedDB failure instead reports that the key could not
  be saved. Once the durable key is stored, a later synchronization failure
  keeps the account unlocked and schedules restoration again; it must never be
  relabeled as a missing passkey.
- The footer restores its previous 49px total height at the user's request:
  a 3rem full-width trigger plus its 1px top border, for mouse and touch alike.
  The 1.75rem avatar and zero outer padding remain. The square-cornered trigger
  paints hover/pressed feedback edge-to-edge; horizontal spacing lives
  inside it, and pressing does not scale it into an inset highlight. The
  sidebar reserves 3.5rem below its content so the restored footer still clears
  the last chat. The settings menu stays
  anchored to the footer row with 0.5rem side insets and 2.625rem rows.
  The settings gear, flat open
  trigger, menu typography, hover states, focus restoration, and keyboard
  navigation remain part of the contract.
- The build versions copied `styles.css` from its own SHA-256 content digest,
  independently of the JavaScript bundle hash. CSS-only footer updates must
  produce a new stylesheet URL even when executable bundles are unchanged;
  deployed stylesheets may otherwise remain browser-cached for hours.

## 2026-09-03: Pseudonymous username accounts use one authentication passkey

- First-time username setup shows the shared **Encrypt your data** card before
  the prompt and its **Waiting…** state through creation/finalization, never a
  username reminder. A generated username keeps
  creation rendering active until close, even after sync publishes the new
  account ID; otherwise sync notifications could briefly show Account before
  the Membership handoff. Retry/error actions and returning login are unchanged.
- Username login uses the compact reference card: 360px maximum width, rounded
  24px corners, a left-aligned **Log in** heading, and the close button at the
  upper right. Google and the joined **Username →** control are 48px high,
  separated by a subtle lowercase **or** divider. The arrow is a stroked SVG,
  not the landing's filled arrow. Padding drops from 32px to 24px on narrow
  screens. This is modal-only; the landing still has no divider between Google
  and Username. The arrow retains the accessible **Continue** name and existing
  click/Enter handler; while busy it becomes a disabled spinner. Scoped CSS uses
  Chat's light/dark theme tokens, neutral autofill, and a 16px input. Saved
  account-number login keeps its existing layout. Returning Google and username
  accounts open the passkey prompt immediately; setup and legacy migration retain
  their explanatory step. A cancelled automatic prompt stays on the untitled
  encryption card with **Try again** focused, and never prompts again by itself.
  Username is an input placeholder with an accessible name, not a
  visible label or example handle. Introductory/helper copy and the separate
  signup/account-number rows are removed. Continue checks for a username
  challenge before reserving a new account, then waits for the explicit passkey
  action. Only typed lookup/registration errors select another flow, never
  passkey cancellation, network failure, or rate limiting. The button is
  single-flight and a close/reopen invalidates its pending lookup.
- The commercial landing page renders Username directly below Google and above
  the OR/access-code row. Both text rows share the same visual control rules,
  while independent handlers preserve the existing Google and anonymous
  access-code routes. The username route is a one-use local UI intent; Chat
  removes the username from its URL after the normal authentication bootstrap
  settles, then checks the username before showing the shared encryption step.
  **Checking username…** covers only lookup, without a redundant username form.
  Lookup errors restore the form; cancelled passkeys keep an explicit retry on
  the encryption card. Missing usernames (including no-JS entry), unsupported/busy states,
  and remembered legacy/Google unlock or recovery still use their normal UI.
  The native prompt does not block the rest of Chat initialization. Startup composer autofocus also respects
  an open Account dialog, including its forced first attempt, so focus stays
  on the authentication surface rather than moving behind it.
- Account entry now offers Google or a normalized, unique pseudonymous
  username. Username registration and returning login use one WebAuthn prompt:
  the assertion authenticates the opaque OA account while PRF unwraps its
  random master key locally.
- The server-generated 16-digit account ID remains the WebAuthn user handle and
  all account/sync cryptographic scoping remains ID-bound. The username is only
  the human-readable passkey label and login locator; it is stored in local
  account settings so restored UI can display it immediately.
- Username accounts do not generate, display, or upload recovery material. The
  first passkey prompt completes registration immediately and emits
  `registerFirstAccountReady`, matching the first-time Google-to-Membership
  handoff. Losing every synced copy of the passkey is intentionally permanent;
  remembering the public username alone cannot prove ownership or decrypt data.
- Existing account-number clients and users remain supported. `/auth/init`
  still accepts no body, old request/response fields and recovery derivation
  remain unchanged, and a saved legacy account automatically receives the
  account-number login UI. Manual account-number entry on a fresh device is
  intentionally removed per the product decision; saved legacy login/recovery
  remains available and the backend protocol is unchanged.
- Username challenge and login responses must resolve to the account already
  saved on the device. Creating or switching to a different username requires
  the existing explicit **Forget saved account** action, preserving the same
  account-scope boundary as Google sign-in.
- Each username login carries an opaque, single-use challenge transaction ID,
  so concurrent public lookups cannot replace an in-progress passkey prompt.
  OA limits every attempt by the trusted client IP and adds a hashed-username
  bucket only after a failed lookup or proof; a third party therefore cannot
  exhaust a public-name quota and lock out a valid owner.
- The Continue action passes an explicit username into account preparation. Blank
  or invalid input fails validation and cannot fall through to the retained
  no-body legacy account-number initializer.
- Conditional auto-unlock also uses the username route for a saved username
  account. Falling back to the legacy opaque-ID route would authenticate but
  clear the local username label when settings are persisted.
- Usernames are visible stable pseudonyms; the compact login no longer displays
  pseudonym guidance. They never accompany ticket
  redemption or inference. See [USERNAME_PASSKEYS.md](USERNAME_PASSKEYS.md) for
  the protocol, compatibility, and privacy boundaries.
- Username accounts mark encrypted sync as identity-backed, like SSO accounts,
  so consuming a ticket does not trigger an immediate authenticated sync.
  The consumed/archive state propagates during the next initial or periodic
  sync; deletion tombstones remain reserved for cash-style transfers.

## 2026-09-01: Commercial onboarding and ticket surfaces use core UI seams

- A newly created Google account closes Account after passkey setup and emits
  `registerFirstAccountReady`; the commercial extension opens Membership and
  focuses its heading. Returning accounts close the authentication dialog and
  remain in Chat; they do not emit this signal. The signed-in Account summary
  is opened only by an explicit Account action.
- Avatar, account label, and disclosure affordance are one accessible sidebar
  button. There is no separate gear. Long labels truncate within the shared hit
  target. The new account identity and menu actions match the existing sidebar
  type scale at 14px regular; only an open/selected state uses medium weight.
  Existing chat-history typography is unchanged. Log out is separated from account actions and remains fully legible
  in both themes, with destructive color reserved for hover/focus.
- The public extension ticket capabilities no longer expose ticket export.
  Membership and standalone ticket management retain Import, Share, and Redeem.
  Account-data/chat/memory export remains independent and never includes
  inference tickets.
- The System Panel uses its original compact styling: a 14px semibold title,
  12px medium ticket/key headings, and the original icons and help buttons.
  The larger September 3 heading redesign was reverted at the user's
  request; only the full-width theme-aware divider remains. It is positioned
  midway through the commercial stack's 24px gap, increased from 16px in a
  follow-up request for 4px more space on each side of the line. The divider
  itself adds no layout height. Its anchor follows expanded ticket help and preparation
  status, so the line stays below that content. Live counts, zero-balance,
  pending/live keys, expiry/renewal, and per-key Council attestation remain
  unchanged. The compact bottom-left footer and stylesheet cache versioning
  are separate changes and are not reverted. Commercial ticket
  preparation mounts directly below the ticket row; component rerenders must
  reattach that extension slot through `refreshExtensionSlot(...)`, never an
  internal registry. Paid preparation uses the same compact text and progress
  bar presentation as ordinary ticket issuance, without a separate spinner.
  A commercial zero balance labels its action **Get tickets** only while an
  account is verified and unlocked; signed-out zero balances remain the neutral
  **Inference Tickets: 0** state.
- Paid preparation stages finalized tickets durably in the account/purchase-
  scoped recovery store, outside the live wallet, until the commercial
  controller has removed its completed progress state. The narrow public
  completion method revalidates the active account, imports that staged batch,
  then publishes the scoped aggregate UI/broadcast update and starts encrypted
  sync without exposing ticket records to the extension. This keeps every live
  ticket consumer behind the loading UI without making preparation durability
  depend on presentation. A per-account Web Lock is held through the completion
  fade and publication. Other tabs wait, then observe the owner's single
  aggregate update without replaying a second success panel; account changes
  release an uncommitted owner while leaving staged recovery intact. Once the
  live-wallet commit begins, external cleanup cannot release its lock; scope is
  revalidated after the durable write, and ready/imported/published recovery
  checkpoints make interrupted publication and cleanup idempotent.
- Commercial Membership inherits the public `--font-sans` token and stays on a
  compact 12/14/20/24–28px interface scale. Negative space groups automatic
  reload beneath the two bordered offers; it is not presented as another card.
- The chat search placeholder is **Search chats...**; shortcut space remains
  reserved at narrow sidebar widths.
- The signed-in account menu is a floating popover that spans the sidebar edge
  and overlaps the account/thread divider slightly. **Log out** uses the same
  neutral hover surface as the other account actions; destructive color is not
  used for hover emphasis.
- Commercial can replace the standalone **Account** menu item only with an
  enabled, visible extension menu action. Slot mount/unmount notifications keep
  that fallback correct even while the menu is open; an empty, malformed, hidden,
  or disabled extension node never removes the only route to account security.
- The public account identity label is empty until bootstrap has completed and
  the session is both server-verified and unlocked. Cached usernames or emails
  must not leak into commercial UI while an account is restoring, locked, or
  signed out.
- Its trigger remains a flat, full-width footer row while open, with the
  account identity on the left and a disclosure chevron on the right. The
  chevron points down while closed and rotates up while expanded; the row does
  not turn into an inset selected pill.
- A restored signed-in account reuses its account-bound cached identity label
  immediately after session validation. Profile refresh and encrypted sync
  continue in the background, so the footer does not briefly fall back to the
  generic **Account** label on every reload.
- Long conversation history settles its initial paint at the top position, then
  leaves scrolling completely free without snapping or delayed row visibility
  changes. A short gradient blur softens a partially visible conversation only
  while more history exists below, and a real trailing spacer remains in both
  full and virtualized lists. The last title can therefore scroll fully above the
  account footer. The account identity
  row and menu keep the existing 14px typography but use a stronger full-row
  neutral hover/focus surface.
- Explicit logout preserves the current device theme while account-scoped
  preferences and encrypted wallet state are deactivated. A Google-authenticated
  session that still needs its encryption passkey is labeled **Unlock encrypted
  data** in the sidebar instead of looking fully logged in. Closing the unlock
  dialog keeps Google authentication but never marks encrypted data or tickets
  unlocked; the Welcome back card explains that a passkey protects the data.
- The viewport permits browser zoom. Do not restore `maximum-scale` or
  `user-scalable=no`; authentication, Membership, and ticket recovery must remain
  usable under magnification.
- The public entitlement preparer accepts an issuer response whose `key_id` is
  absent for rollout compatibility, while still deriving the key ID locally and
  rejecting any advertised value that does not match. Monthly rotation may
  therefore discard stale unsigned recovery without weakening issuer binding;
  the commercial extension immediately restarts the paid allowance.

## 2026-09-01: Browser Back cancels unpaid ticket-bundle Checkout

- Ticket-bundle Checkout now stores the exact Stripe Session and initiating
  billing scope in its tab marker, matching the subscription return boundary.
- A full navigation return or BFCache `pageshow` clears **Opening Checkout…**
  and asks oa-org to cancel that exact unpaid bundle automatically. A confirmed
  payment still wins the race and proceeds into private ticket preparation.
- A definitive unpaid return restores **Membership** with both purchase
  actions enabled and no cancellation notice. Subscription and ticket-bundle
  returns now share this behavior for browser Back and Stripe cancel URLs.
- The modal is made visible synchronously when the exact tab marker is detected,
  before account readiness and server cancellation. Purchase actions remain
  briefly disabled, so a cold ticket-bundle return cannot flash the chat shell
  or start a second Checkout while the payment race is unresolved.
- This temporary purchase lock is independent of ordinary modal `busy` state.
  It survives close/reopen and respects a modal the user leaves closed. An
  unresolved payment or transient cancellation error may hide Membership while
  presenting **Check status**, but it keeps the purchase lock until that exact
  Checkout resolves. An account/readiness change clears the lock and exact tab
  marker without sending the old Checkout Session under the new identity.
- `checkout_pending` no longer renders **Continue Checkout** or **Cancel
  Checkout**. An exact ticket-bundle return keeps the normal disabled purchase
  action in place and shows no transient cleanup copy. Marker-less durable
  recovery is also silent; cancellation and retry status remain owned by the
  navigation-return flow.
- Scope-less, mismatched-account, and mismatched durable records fail closed
  without sending the Checkout Session ID across account partitions.
- Paid-success reconciliation uses the same current/marker/durable scope
  validation before submitting the Session ID. Loopback demo cancellation and
  its **Check status** retry require the exact demo scope but not an Account ID.
- A stale marker-less top-up recovery no longer strands Membership without a
  button. Startup or Membership refresh schedules cleanup of only the exact
  durable Session stored under the current billing scope. The same tab and
  legacy records use a two-minute grace; new records bind a random local
  owner-tab ID, and a different or restored tab waits until 31 minutes, after
  oa-org's fixed 30-minute Checkout lifetime. Matching live tab markers remain
  owned by their return flow. Payment still wins a cancellation race, and
  loopback demo scopes participate without an Account ID.

## 2026-08-31: Browser Back cancels unpaid subscription Checkout

- The commercial subscription flow saves its exact Stripe Checkout session ID
  and initiating account scope in tab-scoped storage in addition to durable
  account-scoped recovery.
- Returning to chat in that tab without a Stripe outcome, including a BFCache
  `pageshow`, clears the transient **Opening Checkout…** state and asks oa-org
  to cancel that exact Session automatically. It never cancels from unload or
  guesses a Session from another tab/account.
- The tab marker scope must match the active account and any durable recovery
  scope before the Session ID is sent. Mismatched or legacy scope-less markers
  are cleared and fail closed without crossing account privacy partitions.
- oa-org remains authoritative for the payment race: confirmed payment proceeds
  to ticket preparation, a pending result keeps retry recovery, and only a
  confirmed cancellation restores Membership. No cancellation banner is shown.

## 2026-08-31: One-trip Desktop Google and encryption-passkey handoff

- Desktop-capable clients request flow version 2; oa-org explicitly negotiates
  it behind a disabled-by-default gate, so existing clients and deployments
  retain the custom-protocol plus separate-passkey flow.
- The stable HTTPS relay keeps its random loopback port and nonce in tab-scoped
  storage while the same tab travels through Google. oa-org returns opaque
  one-use OAuth and passkey-context tokens in a fragment, which the relay removes
  before consuming the context without cookies.
- Touch ID evaluates the WebAuthn PRF in that browser tab. The PRF output goes
  only to the local Desktop loopback listener; oa-chat validates the credential
  against the authenticated account keyring and wraps or unwraps the master key
  locally. oa-org never receives the PRF result or plaintext master key.
- Passkey failure falls back to the established Desktop unlock UI after OAuth;
  state, PKCE, exact-origin validation, and account continuity remain fail-closed.

## 2026-08-31: Staging Desktop encryption-passkey relay

- `/passkey-relay.html` is a static, same-origin WebAuthn bridge for OA
  Desktop. It receives the one-use nonce, random `127.0.0.1` callback port,
  operation, and serialized public-key options in the URL fragment, removes
  that fragment immediately, evaluates WebAuthn in the system browser, and
  form-posts the result only to the loopback listener.
- The legacy passkey-only route never calls oa-org. The combined route consumes
  only its one-use, sanitized context; neither route logs or transmits the
  WebAuthn assertion or PRF output. Desktop must still validate both the HTTPS
  relay origin and one-time nonce.
- `OA_WEBAUTHN_RELAY_URL` selects the exact relay page at build time and is
  recorded in `dist/build.json`. Staging Desktop packages must use the stable
  Vercel origin that also appears in oa-org's `WEBAUTHN_RP_ID` and
  `WEBAUTHN_ORIGIN`; the production relay remains the default.
- See [DESKTOP_PASSKEY_RELAY.md](DESKTOP_PASSKEY_RELAY.md) for the full handoff
  and packaging contract.

## 2026-08-30: Native desktop browser sign-in

- `accountService.authenticateWithOAuth(...)` uses the ordinary popup flow in
  browsers and the Electron preload handoff in OA Desktop. Both paths converge
  on the same Google session record and encryption-passkey setup/unlock logic.
- Desktop preserves a saved OA account ID while signed out and sends it as an
  OAuth account-binding check. The signed-out Account dialog exposes **Forget
  saved account** so switching Google identities requires an explicit local
  reset instead of silently replacing the account or weakening the check.
  Rendering that recovery action uses the privacy-safe
  `hasSavedAccountBinding` boolean (and the categorized mismatch failure as a
  fallback), so it does not disappear merely because no account identifier is
  visible in the signed-out UI.
- The renderer-facing `sessionService` API is unchanged. Electron owns PKCE,
  custom-protocol callback handling, rotating SuperTokens header credentials,
  refresh/retry, and encrypted persistence; oa-chat never receives a token.
- Desktop account traffic remains restricted to the configured org origin's
  `/auth/*` and `/api/billing/*` routes. Public ticket redemption/inference
  requests do not pass through the identity session bridge.

## 2026-08-24: Live ticket pricing and non-blocking relay fallback

- Key acquisition waits for the live model-ticket map before selecting tickets,
  including the synthetic `openrouter/auto` price. A failed refresh remains
  retryable and fails the send clearly instead of redeeming cached or heuristic
  ticket counts; stopping a send also cancels this wait promptly.
- If the encrypted relay fails, only that request retries directly. No
  account-scoped proxy preference is written, so an account sync lock cannot
  leave the UI stuck on `Requesting ephemeral key`, and later requests still
  retry the relay instead of remaining silently direct.

## 2026-08-14: Public core and private commercial composition

- Stripe presentation, Checkout orchestration, top-up state, and subscription
  UI now live in the private `oa-commercial` composition. Standalone `oa-chat`
  contains no billing modal, Stripe client, pricing copy, or upgrade CTA.
- `chat/publicApi.js` is the only supported downstream import. Extension API v2
  provides four isolated UI slots and narrow account, public-org, ticket, and
  UI capabilities; downstream code must not import oa-chat internals.
- Component rerenders refresh extension hosts through the narrow
  `refreshExtensionSlot(name)` UI-facade method. Do not reach through the
  component facade for `extensionSlots`: that registry is intentionally not
  exposed, and doing so silently drops mounted commercial controls when a
  modal replaces its contents.
- The public entitlement preparer retains the privacy-sensitive browser work:
  blinding, issuer-generation validation, strict response allowlisting,
  unblinding, crash-safe IndexedDB recovery, and durable ordinary-wallet
  import. This keeps the unlinkability boundary auditable in the public tree
  without placing commercial product logic there.
- The existing `oa-billing-local-v1` IndexedDB name is intentionally retained
  so a pending preparation survives the extraction. The record format is
  generic entitlement state and final wallet tickets contain no account,
  payment, subscription, or claim metadata.
- At the time of the public/private extraction, account registration was
  Google-only. The 2026-09-03 username-passkey entry above supersedes that
  sign-in limitation without changing the extension boundary.
  A commercial extension observes only the sanitized account snapshot and can
  resume an upgrade after the verified session becomes ready; Account itself
  has no Checkout-specific callback.
- A composition mounted below `/` passes `routeRoot` to `createChatApp`.
  Ticket-code path cleanup and generated shared-chat links use that root, so a
  refresh cannot fall back to the composition's separate landing document.
- Same-origin production builds replace the production-org fallback at compile
  time and remove the now-bundled raw `services/orgEndpoints.js` copy. The
  build scans every published JavaScript file for that hostname, so an inert
  source copy cannot silently weaken the disposable-demo isolation claim.
- `createChatApp({ welcomePanel: false })` lets the commercial composition
  suppress both legacy invite/free-access ticket panels: the first-run Welcome
  modal and the post-ticket Thanks/no-tickets modal. The standalone public
  default is unchanged. Guard both branches when changing ticket-startup logic;
  otherwise an authenticated commercial account that once held tickets can
  unexpectedly fall back into the old invite-code flow.
- A disposable same-origin verifier-bypass build may use a credential-free
  alternate Wisp endpoint through `OA_DEMO_PROXY_URL` when the ordinary relay
  is unavailable. Production builds retain the normal relay. Same-origin demo
  API requests have a ten-second hard timeout so an unresponsive WASM
  transport closes and enters the existing visible direct-fallback path
  instead of hanging forever. Provider inference streams remain unbounded.
- Vercel demo config repeats the non-secret compile flags in `build.env`, and
  the disposable project should store the same Production variables. A build
  can otherwise succeed under a project-level command override while silently
  retaining the production-org endpoint. Handoff must inspect the emitted app
  bundle for both absence of that endpoint and presence of the demo relay.
- The commercial composition now uses a three-panel, self-hosted-Newsreader
  landing page from `oa-commercial/feature/pre-chat-landing`, originally
  reconciled with the reviewed Google-only account handoff. The Account modal
  now adds a recovery-free username passkey path; Apple and access-code
  authentication alternatives remain absent. Its Premium modal keeps server-owned
  subscription/top-up prices and eligibility, exposes Customer Portal and
  ticket-pack actions when status authorizes them, and adds a collapsed ticket
  explanation without hard-coding model costs.

See [EXTENSIONS.md](EXTENSIONS.md) for the supported contract. The Premium
entries below describe the pre-extraction implementation history; the current
commercial behavior is documented and tested in `oa-commercial`.

## 2026-08-07: Disposable Demo Same-Origin Routing

- Normal production builds still target `https://org.openanonymity.ai`.
  Disposable Vercel builds must compile `OA_ORG_SAME_ORIGIN=true`; account,
  billing, ticket, and sync calls then use the exact frontend origin.
- `scripts/generate-demo-vercel-config.mjs` validates an HTTPS oa-org tunnel and
  creates deployment-only rewrites for `/auth/*`, `/api/*`, and `/chat/*`
  before the SPA fallback. Do not commit a rotating tunnel hostname or expose
  backend/provider secrets as frontend variables.
- Deploy the disposable Vercel project with `vercel deploy --prod` and use its
  stable production hostname for SuperTokens, WebAuthn, Google OAuth, and
  cookie origins. Preview hostnames rotate and cannot satisfy that fixed
  identity/callback contract.
- A disposable station that is absent from an isolated verifier may compile
  `OA_DEMO_VERIFIER_BYPASS=true` only with same-origin HTTPS routing. The build
  rejects production OA hostnames, points no request at the production
  verifier, labels the result as an unverified demo bypass, and prevents access
  sharing. This is an explicit test-only privacy/assurance deviation requiring
  user acceptance; omit it when an isolated verifier is available.
  The guard rejects `openanonymity.ai` and every subdomain, not only the known
  production frontend names, so a demo-bypass artifact cannot be hosted under
  any OA production namespace.
- Same-origin builds strip the production-org DNS prefetch from built HTML.
  The production build keeps that hint. `scripts/build.mjs` must preserve the
  tracked `chat/nanomem` symlink rather than copying over it and dirtying the
  source tree.

Packaged OA Desktop builds may instead set `OA_ORG_ORIGIN` to an exact HTTPS
oa-org origin. This is mutually exclusive with disposable same-origin mode and
is recorded in `dist/build.json`; the Electron main process independently
allowlists that origin before storing or attaching any account credentials.
- Immutable station archives still need an empty, secret-free `station/.env`
  marker (`root:root`, mode `0444`) before service start, even when systemd
  provides the real protected environment file. See the run record before a
  clean redeploy; omitting the marker causes a restart loop.

See [DEMO_DEPLOYMENT.md](DEMO_DEPLOYMENT.md) for the deployment contract and
[DEMO_ENVIRONMENT_2026-08-11.md](DEMO_ENVIRONMENT_2026-08-11.md) for the
secret-free record and teardown targets of the integrated disposable run.

## 2026-08-07: Monthly Premium Ticket-Key Epoch

- Premium renewal and the global Privacy Pass ticket generation share the
  first-of-month 00:00 UTC boundary in oa-org. This must remain a global epoch,
  not a per-account rotation: every subscription and invitation ticket uses the
  same unlinkable issuer public key, and rotating it invalidates all earlier
  generations immediately.
- The Redis epoch marker includes both the UTC billing month and Stripe mode.
  Changing a deployment from test to live rotates under the ordinary global
  fence even within the same month, preventing sandbox-issued tickets from
  crossing into live billing resources.
- `BillingClient.runPreparation(...)` verifies the current RFC 9578 public-key
  ID before generation, at the signed/finalization transition, and immediately
  before durable wallet import. The same expected key ID is sent with the blind
  claim so oa-org's generation fence can reject a rotation race before signing.
  `BILLING_ISSUER_ROTATED` deletes the obsolete account-scoped pending record
  and asks the user to retry the current allowance.
- Pending records without `issuerFingerprintVersion: 2` use the pre-integration
  hash-of-base64 convention. Accept one only when that legacy hash matches the
  currently fetched key, then persist the RFC key ID and version before any
  further recovery work; otherwise an already consumed signed allowance could
  be discarded during upgrade.
- An exact boundary race remains recoverable: oa-org rotates before reservation
  and signing, and the claim completion transition is also atomically fenced
  on the same key/month. Requests blinded to the old key fail without consuming
  the entitlement; an issuance counted immediately before rotation is rolled
  back, and the next browser attempt regenerates. Keep the issuer fingerprint
  local-only and never add billing or account metadata to finalized tickets.
- Invitation/ticket-code issuance and request-key, confidential-key, and split
  redemption use exact-batch server replay records. Client retries must reuse
  the identical serialized blind/ticket batch so a lost HTTP response cannot
  consume a one-use credential, tickets, or an ephemeral key irrecoverably.
  Ticket codes created by splitting are bound to their source key generation
  and billing month so they cannot carry an allowance across rotation. The
  split response carries that UTC month-end expiry and the right panel displays
  it beside the one-show code.
- oa-org keeps an owner-fenced, exact-request ticket-spend lease before any
  downstream one-show key/code side effect. A crashed worker can be resumed by
  the identical ticket batch; a completed request leaves a tombstone longer
  than the spent-nonce record. After the secret replay window expires, the UI
  must treat the request as completed/unrecoverable rather than trying to reuse
  or release those tickets.

The active lifecycle is documented in `oa-commercial/docs/BILLING.md`.

## 2026-08-05: Premium $7 / 50-Ticket Top-Ups

- The Premium modal renders the one-time pack only when both public
  `plan.ticket_pack` exists and authenticated `status.ticket_pack.eligible` is
  true. Price and count are server data; ineligible and signed-out users see no
  pack copy or action.
- Checkout recovery is now version 3:
  `sessions[accountScope].subscription` and
  `sessions[accountScope].topup` are independent. Version-2 and legacy records
  migrate into the subscription slot. Reconciliation, clearing, frozen auth,
  and account-switch abortion are scoped to both account and purchase kind.
- A top-up claim is an explicit 50-ticket operation. Local IndexedDB recovery
  adds `source: "topup"`, `claimRef`, and `targetCount: 50`; the claim request
  sends that reference, while finalized wallet records retain the same four
  ordinary ticket fields. The reference must never enter exports, shares,
  redemptions, tickets, or logs.
- If oa-org has committed a claim and reports the pack `ready` before staged
  ticket publication finishes, the pending local record projects browser state back
  to `claiming` and disables another purchase. That override is cleared only
  after durable wallet write/read-back and archive-precedence verification.
- Top-up and subscription work share the existing account-scoped Web Lock,
  frozen authentication context, ten-ticket chunks, strict response allowlist,
  and account-switch abort behavior. A claimable pack takes precedence over an
  older implicit subscription entitlement, because only it has the explicit
  `claim_ref`.
- Stripe return values are distinct (`topup_success` / `topup_cancelled`). A
  successful return prepares the pack automatically. A canceled return uses the
  session ID saved by that specific tab in `sessionStorage`; it never guesses
  from the durable account slot, so an old tab cannot cancel a newer Checkout.
- `checkout_pending` has no manual Continue or Cancel controls. Returning with
  browser Back in the opening tab cancels the matching unpaid Session
  automatically; tab close, crash, and connectivity loss preserve durable
  recovery. Stripe expiration and status reconciliation clear older unpaid
  records, while payment winning a cancellation race proceeds to normal
  50-ticket preparation.
- Checkout recovery and durable IndexedDB claim/import recovery remain separate.
  No unload/beacon/tab-close cancellation exists, and the tab-scoped session ID
  never enters sync, exports, wallet state, tickets, or logs. Purchase fills the
  ordinary wallet and does not redeem a ticket or alter issuer-key rotation.

The active contract and privacy boundary are documented in
`oa-commercial/docs/BILLING.md`.

## 2026-07-31: Stripe Premium and Genuine Ticket Issuance

- The sidebar has one adaptive entry: signed-out users see `Register and upgrade`; any local
  account changes it to `Account` without a reload. Free accounts get an
  `Upgrade to Premium` action in Account, and subscribed accounts get
  `Manage billing`. Logging out restores `Register and upgrade`.
- `Register and upgrade` opens the public Premium modal without requiring an account, while
  starting Checkout routes through account creation or sign-in and resumes
  exactly once afterward. The initial Welcome screen uses the same
  `Register and upgrade` entry. Explicitly
  cancelling the account step clears the session-scoped Checkout intent and
  returns to Premium. Public price and interval data come from oa-org's
  Stripe-validated `/api/billing/plan`; the UI does not hard-code the amount.
  A failed plan request shows `Price unavailable`, offers a retry, and removes
  the Checkout action until a validated price and allowance are loaded.
- Stripe success and saved-Checkout recovery wait for account initialization
  and SuperTokens verification before reconciliation. Components mount before
  `accountService.init()`, so billing must not interpret the initial
  `sessionVerified=false` state as an authenticated user having signed out.
  Explicit Checkout cancellation remains pending until the account scope is
  settled; it must not time out into generic saved-Checkout recovery.
- Signed-out registration currently exposes Google SSO only. Legacy direct
  passkey creation, account-number passkey login, and recovery-code entry points
  remain compatible in the service layer but are intentionally absent from the
  registration picker. Google-first accounts still create or use an encryption
  passkey after OAuth because that passkey protects synced ciphertext locally.
- Checkout, status, portal access, and paid claims use `BillingAuthProvider`.
  Local development may create a random identity only when both oa-chat and
  oa-org are loopback. Non-loopback deployments require the account adapter.
  Pending Checkout reconciliation is stored under that billing scope and resumes
  after reload only for the same identity.
- A full paid period creates a 300-ticket entitlement. The initial payment and
  allowance may be prorated to a smaller positive count. A claim sends exactly
  `next_claim_ticket_count` browser-blinded requests to the existing org issuer;
  no alternate RSA or demo issuer exists in oa-chat.
- Pending generation, signed responses, and finalization live in the separate
  local-only `oa-billing-local-v1` IndexedDB database. Work is persisted every
  ten tokens, survives reload, is scoped to the active billing identity, and is
  intentionally excluded from settings sync and export.
- Paid preparation freezes one authentication scope, holds a scope-specific Web
  Lock across the complete operation, and fails closed if Web Locks are
  unavailable in a browser. Account switches abort without deleting the old
  scope's recovery state.
- The ordinary ticket wallet receives only `blinded_request`,
  `signed_response`, `finalized_ticket`, and `created_at`. Redemption continues
  through the existing accountless endpoints and sends no billing metadata.
- Recovery state is cleared only after a strict IndexedDB write and read-back
  confirms every finalized ticket. Claim responses are field-allowlisted before
  finalization, so server-provided billing or finalized-ticket metadata fails
  closed.
- Checkout recovery is stored per account scope and uses frozen authentication;
  stale status responses are discarded after identity changes. Ticket recovery
  treats active and archived wallet records as imported, preserving archive
  precedence so a spent ticket is never resurrected.
- One available allowance is prepared automatically per billing activation and
  entitlement identity. Subscription auto-preparation is keyed by
  `current_period_end`, so a tab that survives into the next paid month can
  prepare the new period; top-ups remain keyed by `claim_ref`.
  Additional accumulated allowances require an explicit action labeled with
  the next server-provided count. The modal intentionally omits server allowance
  counters such as `Current paid allowance`; those are not browser wallet counts.
  See `oa-commercial/docs/BILLING.md` for the extracted implementation.

## How Agents Should Use This

1. Read this file before changing UI-heavy or stateful parts of the app.
2. Read any more specific doc in `docs/` that matches the feature area you are touching.
3. After meaningful work, update this file or the feature-specific doc with what changed,
   what was learned, and any non-obvious behavior the next agent should know.

If a lesson belongs in a dedicated feature doc, add it there and leave a short pointer in
this file so future agents can find it quickly.

## What To Record

- Subtle UI expectations or interaction rules that are not obvious from reading the code.
- State coupling across components, services, persistence keys, or responsive layouts.
- Known constraints, sharp edges, and regression risks discovered during implementation.
- Follow-up work or unresolved questions that the next agent should evaluate.

Keep entries concise and factual. Prefer short bullets over long narratives.

## Current Notes

- 2026-09-27: Verifier outage release validation was integrated onto main `33d44f1`
  in a separate worktree. The original `538aa9c` branch predates the current
  shared access-acquisition controller. Council now uses that existing controller
  for outage admission; current account, payment, and inference recovery behavior
  is retained. Newly acquired Council keys immediately register retry observers
  so a rejection cannot be lost before the next prompt. Regression checks cover
  live/stored rejection, deleted chats, replacement keys, and metadata preservation.
  Browser fixtures verified light/dark warnings and real IndexedDB persistence
  through reload, approval, and rejection without sending real requests. Retry deadlines are serviced by the existing broadcast polling
  interval rather than a dedicated five-second timer.

- 2026-09-27: Verifier outage behavior follows the deployed production client
  (`app-AU5ENDBB.js` inspected read-only), with explicit key-response binding.
  - Ordinary transport/timeouts and transient HTTP failures permit
    `verifier-unavailable` access only when issuance says `recentlyAttested === true`.
    As in production, HTTP 429 and the exact 503 `ownership_check_error` response
    can also continue while retrying. Explicit refusals, bans, invalid keys, and
    unknown/pending responses block; arbitrary exceptions are not outage approval.
  - Single-model and Council RHS cards show an orange warning. The key remains
    unverified until a matching successful per-key response arrives; a healthy
    broadcast alone cannot upgrade it. Expiry, credit limits, cached bans, and
    sharing restrictions still apply.
  - Broadcast polling processes bounded background retries: three total attempts
    for ordinary outages, ten for rate limiting/temporary ownership-check errors,
    with exponential backoff. Only retry fields are retained in browser memory.
    Using a saved pending key resumes retries after reload. Exhausted retries are
    persisted as `verification_retry_exhausted`, with an honest warning and no
    automatic requeue. Successful verification removes the warning; rejection
    clears the matching key. Late responses cannot replace renewed keys, and
    persistence updates existing rows atomically without recreating deleted chats.
  - Admin email delivery, station failover, deployment, and ticket-redemption
    changes are outside this change. The operator accepted the temporary loss of
    ownership/privacy verification described in PRIVACY_MODEL.md.

- 2026-08-30: Math rendering accepts conservative single-dollar inline delimiters.
  - `chat/services/mathRendering.js` is the shared KaTeX entry point for chat,
    reasoning, Quick Ask, navigation, and share previews. Keep new message
    surfaces on this helper so delimiter behavior does not drift.
  - Gemini can return `$...$` despite the system prompt requesting `\(...\)`.
    Text normalization protects valid single-dollar pairs before Markdown
    parsing, while code/preformatted content, escaped dollars, ordinary prices,
    and price ranges such as `$5-$10` remain literal text.

- 2026-08-30: The user's explicit Chat/Parallel composer choice now persists in
  the versioned `parallelModePreferenceV2` setting alongside the remembered lane models. A fresh chat or
  newly opened tab/window starts in Parallel when Parallel was the last chosen
  mode, and starts in Chat after the user switches back. Opening the view alone
  never sends a request or spends tickets. Legacy mode flags are deliberately
  ignored, and changing a lane/review model does not overwrite a newer explicit
  mode choice from another tab.

- 2026-08-11: Each chat session's sidebar options menu has an `Export as Markdown`
  action. It reads that session directly from local IndexedDB without switching the
  active chat, preserves message Markdown, and replaces user/model images and other
  attachments with readable placeholder lines instead of embedding binary data URLs.
  Exported messages use explicit plain-text delimiters with shared conversation turn
  numbers (`--- User turn 1 ---`, `--- Assistant turn 1 ---`). These remain literal
  text under CommonMark, which keeps them visible and deterministic for text parsers.
  Delimiter-shaped lines inside message content are prefixed with a Markdown backslash
  escape so they cannot be mistaken for transcript boundaries in the source file.

- 2026-08-04: Plain `Cmd/Ctrl+F` uses an app-owned find-on-page toolbar instead
  of the browser's native find UI, so a forgotten find field cannot retain
  keyboard focus after the user returns to the app. The toolbar follows standard
  next/previous, `Enter` / `Shift+Enter`, `Cmd/Ctrl+G`, `Escape`, close-button,
  and click-away behavior. It auto-dismisses after 10 seconds without find
  activity and restores the previously focused input when dismissed by timeout,
  Escape, or its close button; clicking elsewhere preserves the user's new focus.
  If that return target becomes unavailable (for example, a modal opens), focus
  moves to an eligible text control in the active dialog and never remains in the
  hidden find toolbar. True modal dialogs take precedence over visible non-modal
  `role="dialog"` surfaces such as quick ask. Tabbing out also dismisses find
  without later focus theft.
  Matching can span adjacent inline Markdown nodes and uses original-string
  offsets so Unicode case folding cannot create invalid DOM ranges.
  The deadline is rechecked when the tab/app becomes visible or focused so
  background timer throttling cannot leave a stale find toolbar open.

- 2026-08-07: The public chat shell now has an optional versioned extension seam.
  - `chat/publicApi.js` exposes `createChatApp`, extension API version 2, and
    stable slots including `sidebar.accountActions`, `account.menuActions`,
    `account.commercial`, `welcome.actions`, and `modalLayer`.
  - The sidebar footer remains core-owned. Signed-out users see Account;
    verified sessions see the available account or SSO email identity (or Account fallback).
    The full identity row opens a menu containing Account & security, extension
    actions, and Log out; there is no separate gear. The menu restores focus on
    Escape and supports arrow/Home/End keys.
  - The Account dialog ignores backdrop clicks so an accidental click beside
    the card cannot dismiss it. Its close button remains the explicit pointer
    action, while Escape remains available for keyboard users.
  - `account.menuActions` is the preferred commercial membership entry. It
    exposes no billing state or credentials to the core; older sidebar and
    account-modal slots remain available for compatible integrations.
  - Standalone startup passes no extensions. Empty slots are invisible and the
    public Account UI remains fully functional.
  - Account modal rerenders recreate their slot host and ask the slot registry
    to reattach the existing extension-owned node. Extensions must never query
    or import internal component/service implementation details.
  - Client-side entitlement ticket blinding/finalization remains public through
    `application/entitlementTicketPreparer.js`; downstream integrations supply
    the authorized count and claim operation.
  - Paid integrations can attach only `subscription` or
    `topup:<64-hex-reference>` as local claim-recovery context. Reload recovery
    reuses that saved context when invoking the blinded-claim callback. It stays
    in the separate recovery record and never enters finalized tickets, wallet
    exports, shares, redemptions, logs, or progress snapshots; progress exposes
    only a redacted `subscription` or `topup` source.

- 2026-07-31: Ticket signing-key rotation is an immediate invalidation
  boundary.
  - Every newly redeemed ticket stores the global RFC 9578 `token_key_id` as
    `ticket_key_id`. Legacy/imported tickets are normalized by extracting the
    same 32-byte field from the finalized token in
    `chat/domain/ticketKeys.js`.
  - Org ticket errors are unwrapped from FastAPI's structured `detail`. On
    `TICKET_KEY_INVALIDATED`, `TicketStore.consumeTickets(...)` atomically
    deletes every active or archived local ticket with `invalidated_key_id`
    and leaves tickets from newer generations untouched. Deleted generations
    cannot reappear through export or sync: the local, union-merged
    `tickets-invalidated-key-ids` list filters local loads, imports, and
    incoming sync blobs. Sync publishes one encrypted append-only record per
    invalidated generation (plus the legacy aggregate migration record), so
    concurrent devices cannot lose distinct tombstones through the org's LWW
    blob store. Account-data transitions and sync merges share the outer
    `oa-sync` Web Lock; local ticket mutations take their narrower ticket lock
    inside that boundary. This nesting prevents local/remote unions and account
    switches from overwriting each other. Sync schema v2 performs one full pull after upgrade
    so records skipped by older clients are rediscovered. Tombstones contain
    only global public-key fingerprints, never tickets or identity metadata.
    Never infer a batch from invite metadata or timestamps; the embedded
    public-key fingerprint is the grouping authority.
  - `acquireSessionAccess(...)` automatically retries when enough tickets from
    another generation remain. Otherwise it tells the user that the org
    rotated its key and that a new invite must be redeemed. The
    `ticket-key-invalidated` window event drives the seven-second removal toast.
  - Invite issuance binds each blinded batch to the public `key_id` fetched by
    the client. If rotation wins before issuance is committed, the org restores
    the single-use credential reservation and returns `TICKET_KEY_CHANGED`;
    the client tells the user the invite was not consumed and can be retried
    against the newly fetched public key.
  - The key ID is a shared public-generation fingerprint, not identity
    metadata. It stays in the user's local ticket store and does not weaken the
  blind-signature unlinkability boundary.
- 2026-08-04: Account session refresh is owned by SuperTokens. See
  [Account Sessions](ACCOUNT_SESSIONS.md). Browser requests use HttpOnly cookie
  mode; Electron renderer requests use the same `sessionService` API but run the
  SDK in the isolated desktop preload with header-mode tokens encrypted by the
  main process. Keep access/refresh tokens out of OA response bodies,
  IndexedDB/localStorage, renderer APIs, and hand-written `Authorization`
  headers. `encryptedSyncService` retains only non-extractable client-side
  derivation keys and relies on
  the SDK's automatic refresh/retry. Keep both the SDK interception override and
  `sessionService.fetch(...)` restricted to the org `/auth` and `/api/billing`
  account paths. Premium claims belong inside this identity boundary because
  they authorize paid blinded issuance; accountless redemption, request-key,
  sharing, and model paths must remain outside it.

- 2026-08-04: Local oa-org inference can bypass the external verifier only when
  both the oa-chat page and configured oa-org URL use exact loopback hostnames.
  The access proof is stored as `local-loopback-bypass`, not `verified`; the
  same credential is discarded on non-loopback startup and cannot enter shared
  access payloads. Ordinary Chat and Parallel/Council use the same policy.

- 2026-07-31: OpenRouter catalog labels for Anthropic models are normalized to
  include the `Anthropic:` prefix when upstream omits it. Already-prefixed names
  remain unchanged.
- 2026-07-16: Parallel/Council share and provider-display rebase notes.
  - Shared chat payloads serialize `responseMode` and `councilConfig`, and both
    first import plus update-import paths restore those fields. Otherwise imported
    Parallel/Council transcripts render old aggregate messages but silently continue
    as single-model chats.
  - Parallel/Council composer and response labels should use catalog provider
    metadata or `resolveProviderFromModelReference(...)` for explicit provider
  prefixes/model IDs. Do not infer providers from bare model-family words such
  as Llama, Gemini, Claude, or Nemotron; bare names should fall back to neutral
  initials when catalog metadata is unavailable.

- 2026-08-17: Insufficient-ticket preflight exposes a redacted commercial hook.
  - After synchronized budget calculation blocks a send or regeneration,
    `context.tickets.registerShortageHandler()` receives only aggregate
    `availableTickets` and `requiredTickets` counts. Prompts, model identities,
    Memory context, sessions, and account data stay inside core.
  - The original inference request remains unsent. A commercial build may use
    this user-initiated event to start an already-consented refill or show an
    explicit purchase surface without risking a duplicate model request.
  - Signed-in preflight never treats the temporary pre-sync balance as a
    shortage. It asks the user to wait for ticket loading (or unlock) and does
    not notify the commercial handler until account scope and ticket sync are
    ready.

- 2026-08-17: Commercial Checkout recovery can render beside the public ticket count.
  - `rightPanel.ticketStatus` is a generic extension slot below the compact
    Inference Tickets launcher. Core owns its location and reattaches mounted
    nodes after each top-section rerender; it contains no billing copy or state.
  - The commercial extension sends only aggregate preparation progress and
    ticket counts into its own slot node. The slot never receives ticket
    records, billing identifiers, account credentials, or inference content.
  - Post-sign-in plan routing must wait for verified unlock, account-scope
    activation, the first encrypted ticket sync, and a billing-ready ticket
    snapshot. A transient startup zero must never open Membership.

- 2026-08-18: Submitted prompt bubbles keep the normal chat reading width.
  - Normal, manual-wide, and Parallel/Council layouts cap user prompts at the
    shared `44rem` reading width. Short prompts remain content-sized and
    right-aligned; only assistant lane responses use the expanded transcript
    width in Parallel/Council.

- 2026-08-16: Ticket-code share links stay within their issuing environment.
  - Ticket codes are one-time and environment-scoped, so the sender's current
    origin is retained instead of hard-coding the production chat host.
  - Commercial/preview chat links use `/chat/?tickets=<code>`; root-mounted
    public chat links use `/?tickets=<code>`. This keeps Sandbox codes on the
    Sandbox backend and preserves automatic recipient redemption.
  - A code that was already consumed is reported separately from a code that
    is expired, missing, or belongs to a different OA environment.

- 2026-08-16: The chat toolbar no longer draws a horizontal separator.
  - The toolbar still switches between opaque and floating presentation as
    side panels change the available width, but neither desktop nor mobile
    adds a rule above the conversation content.

- 2026-08-16: Extensions can subscribe to redacted ticket-count changes.
  - `context.tickets.subscribe()` waits for local ticket storage, then emits
    only the existing count/max-share/busy snapshot, never wallet records or
    ticket cryptographic material. A transient startup zero is not emitted.
  - Signed-in snapshots remain ineligible for automatic billing until the
    account's initial encrypted sync succeeds. Returning accounts therefore
    cannot be charged against a temporary empty wallet before remote tickets
    arrive.
  - This supports downstream opt-in zero-ticket refill UX without putting
    Stripe, billing identity, or charging logic into the public client.

- 2026-08-16: Parallel per-model regeneration uses the same combined ticket
  preflight as send and full regeneration.
  - The preflight counts a fresh Memory key when needed plus only the selected
    lane's fresh model access, and runs before later messages are deleted.

- 2026-08-21: Citation and inline-link rendering is network-silent.
  - URL display metadata is derived locally from the hostname. The client no
    longer sends response-derived URLs to CORS preview proxies or loads remote
    favicons automatically.
  - Keep source cards and inline links on local SVG/domain markers. The cited
    origin should see the browser only after the user explicitly opens a link.

- 2026-08-16: The full signed-in identity row opens the account action menu.
  - The email/avatar/settings affordance is one button with one hit target;
    signed-out clicks still open Account.
  - Focus returns to that control, and the identity row
    exposes menu semantics only while a verified, unlocked account is active.
- 2026-08-16: Commercial Membership can host the public ticket tools.
  - The extension context exposes count-only ticket-tool state plus the existing
    import, split/share, and access-code operations. It never exposes
    wallet records, account credentials, billing identifiers, or inference data.
  - Ticket counts remain billing-unready until account startup finishes. For an
    anonymous session, startup first archives any stale account-bound wallet and
    restores the anonymous scope; for a signed-in session, readiness additionally
    requires verified unlock, scope activation, and the first encrypted ticket
    sync. This prevents checkout recovery or automatic refills from acting on a
    transient zero balance.
  - The account-data guard canonicalizes a missing persisted scope to the
    anonymous `null` scope. It still rejects every real account mismatch while
    allowing a clean anonymous wallet to accept prepared tickets.
  - A commercial extension can register one compact right-panel ticket-count
    action that opens Membership. While registered, the right panel omits its
    ticket-code controls but keeps a collapsed question-mark explanation of
    inference tickets. Membership supplies Import, Share, and
    account-free access-code redemption in one place.
    Standalone public builds still render their original access-code controls.
  - Signed-out commercial actions may transition from the Account dialog into
    Membership through `context.ui.closeAccount()`. They must capture
    `getAccountMenuReturnTarget()` first, close Account, and then open the next
    dialog so only one modal and one keyboard focus trap are active.
  - The compact ticket launcher's icon and label share the same left edge as
    the Ephemeral Access Key heading below it; avoid adding nested horizontal
    padding to the launcher.
  - The commercial launcher uses its original `text-xs font-medium` heading
    treatment, with its original compact question-mark control
    immediately after the count. Do not replace it with a full-width navigation
    row or move the help control to the far edge of the panel. Standalone
    public ticket controls retain their existing compact typography.


- 2026-08-07: Google is the only supported SSO provider.
  - The account UI and client account state no longer expose GitHub sign-in,
    GitHub-linked flags, or GitHub compatibility wrappers.
  - The org no longer mounts `/auth/github/*` routes or accepts GitHub OAuth
    configuration. Access and refresh tokens carrying GitHub authentication
    provenance are rejected. Older provenance-less refresh records are also
    retired because their original provider cannot be distinguished safely, so
    sessions issued before provider removal cannot outlive the route removal.
    Existing identity rows remain opaque storage records, but there is no
    GitHub authentication path into them.

- 2026-08-11: Popup OAuth completion creates the SuperTokens browser session
  through an intercepted API response.
  - The callback navigation cannot deliver its `front-token` header to the
    Session SDK. It instead posts a short-lived, opaque single-use completion
    token to its exact opener. The client sends that token in the body of
    `/auth/google/complete`; the backend atomically consumes it and creates the
    HttpOnly session on that SDK-intercepted response.
  - Keep the order `complete -> verify -> provider session read`. Creating the
    session on the callback navigation or checking `doesSessionExist()` first
    leaves the SDK unaware of a valid Core session.
  - `/auth/google/start` is deliberately session-independent. It must remain
    usable when a browser carries a stale invalid SuperTokens access cookie;
    linking mode is still rejected, and an `expectedAccountId` is only a
    continuity hint that cannot create or retarget an identity mapping.

- 2026-07-30: SSO encryption passkeys use the provider email as their WebAuthn
  username and display name.
  - Google requests `openid email`. The org stores the verified email with the
    provider identity and returns it from the authenticated provider session.
  - `accountService.oauthEmail` is populated by the Google session path and
    is passed explicitly into every SSO encryption-passkey creation, including
    legacy SSO migration. `encryptionPasskey.js` has no generic label fallback;
    missing email requires a fresh SSO sign-in.
  - Existing identity rows gain a nullable email column. If an older refresh
    session restores `PRF_PENDING` or `LEGACY_SSO` before a new OAuth callback
    has populated it, the client returns to the provider sign-in screen instead
    of entering a passkey flow that cannot be labeled.

- 2026-07-30: SSO accounts now sync encrypted inference tickets across devices.
  - The SSO-only `syncTickets` gate was removed. Active and archived tickets,
    preferences, and their timestamps use the same version-1 encrypted blob
    format for identity-backed and legacy account-number accounts.
  - Ticket additions/imports/clears schedule the normal debounced sync.
    Redemption consumption deliberately does not for identity-backed accounts:
    its encrypted archive record is uploaded by the next initial/periodic sync,
    avoiding a deterministic
    identity-authenticated request two seconds after anonymous redemption.
    Legacy identity-free accounts retain immediate consumption sync.
  - Empty wallet arrays are encrypted too. Cash-style clear/export removes
    redeemable ticket secrets locally and syncs a separate encrypted SHA-256
    deletion-tombstone blob so stale devices cannot resurrect them. Remote
    active/archive merges always apply those tombstones.
  - A new device must authenticate with Google and unlock the shared
    master key with the PRF passkey before it can decrypt the restored wallet.
    A newly created SSO account adopts and uploads tickets already on that
    device, matching legacy account creation. Remote ticket merges immediately
    broadcast a cache invalidation to other tabs; stale notifications for a
    prior account are ignored instead of clearing the current account cache.
  - The org sees identity-bound sync metadata (request timing, ciphertext size,
    and stable opaque blob IDs), but not ticket plaintext or the HMAC-derived
    logical IDs. Redemption remains separate from account authentication, but
    optional identity-backed ticket sync weakens the strict metadata-level
    unlinkability claim: a malicious org can still attempt timing/size
    correlation around later syncs.

- 2026-07-29: SSO uses a Confer-style authentication/encryption split; see
  [ENCRYPTION_PASSKEYS.md](ENCRYPTION_PASSKEYS.md).
  - Google authenticates and authorizes opaque account storage. A
    separate client-only WebAuthn PRF passkey wraps the random sync master key.
    The org stores `credentialId` plus the versioned AES-GCM wrapper and never
    receives a WebAuthn assertion, PRF output, or plaintext key.
  - New SSO users are no longer shown an OA account number or recovery code.
    The required post-OAuth step is create/unlock encryption passkey. Losing all
    copies of that passkey is unrecoverable by design.
  - `oauthSetupRequired` means the authenticated account has no keyring and must
    create its first encryption passkey. `oauthKeyringRequired` means wrappers
    exist and a passkey must unlock one. `oauthRecoveryRequired` is only the
    one-time migration path for SSO accounts from the recovery-wrapper build.
    `oauthLegacyPasskeyRequired` is distinct: a legacy linked account still
    authenticates through its original WebAuthn credential.
  - `encryptionPasskey.js` handles the PRF-specific WebAuthn flow. Keep the
    follow-up `credentials.get()` after creation: some authenticators report
    PRF support at creation but return output only from an assertion.
  - IndexedDB persists non-extractable AES-GCM, HKDF, and HMAC `CryptoKey`
    objects in one account-bound `account-key-bundle-v1`, never new raw
    master-key bytes. Loading rejects a bundle for any other account. A
    one-time migration imports and deletes the old independent key values.
    Logout/token invalidation deletes the bundle.
  - Syncable tickets/preferences and their metadata now have per-account local
    snapshots (`sync-account-data:<accountId>`). OAuth reauthentication and
    logout must deactivate the active scope before clearing sync credentials,
    or unsynced local wallet state can be lost. Clear credentials first to
    invalidate in-flight work. Scope transitions and sync share the `oa-sync`
    Web Lock, and sync verifies its account against the persisted active marker
    before reading live values. Ticket mutations and syncable-preference writes
    also take this lock; scope snapshot/live-key/marker changes commit through
    one settings transaction, and stale store caches are cleared.
  - Superseded by the 2026-07-30 entry above: identity-backed accounts now sync
    encrypted ticket wallets as well as preferences. Google linking
    remains rejected to preserve dedicated account identity/recovery semantics.
  - Legacy unscoped values are adopted when the user creates a new account on
    that device, matching the original account-number flow. For a returning
    account, adoption requires persisted settings proving continuity with the
    same account. Otherwise values are preserved under `sync-unclaimed-data`
    and restored on logout; canceling setup before scope activation leaves them
    untouched.
  - Keep the legacy server-authentication `credentialId` separate from the
    client-only `encryptionCredentialId`. A linked legacy account still needs
    its original ID as the `/auth/challenge` hint and still displays its account
    number.
  - The sync blob format itself remains version 1. The service accepts the new
    non-extractable key bundle while retaining raw-byte input only for existing
    tests/compatibility.
  - An OAuth refresh token records its original auth method and time. Refresh
    preserves those claims, so a stale cookie cannot become a fresh provider-
    linking step-up merely by calling `/auth/refresh`.

- 2026-07-28: Account authentication supports Google OAuth in addition to
  passkeys; see [GOOGLE_SIGN_IN.md](GOOGLE_SIGN_IN.md).
  - `accountService.authenticateWithOAuth(provider, ...)` owns the shared popup,
    setup, recovery-unlock, account-mismatch, and local-key restoration flow.
    The Google-linked flag plus `lastOAuthProvider` are persisted so a locked
    browser can recover through Google.
  - Superseded by the 2026-07-30 passkey-label entry above: Google now requests
    `openid email`, and the org retains the verified email with `sub` so it can
    label the user's encryption passkey.
  - `npm run dev` serves static assets and proxies non-static requests to the
    local org on port `8005`. The browser therefore uses its own origin for
    passkey, OAuth, ticket, and sync API calls, avoiding local-network/CORS
    restrictions. OAuth callbacks still come directly from port `8005`, so
    `ORG_AUTH_ORIGIN` remains separate from the local `ORG_API_BASE`.
    The dev server injects a runtime-only proxy marker, so `npm run preview` on
    localhost still uses `https://org.openanonymity.ai`. The callback host is
    canonical `localhost`; requests to the dev server via `127.0.0.1` redirect
    there before the app loads.
  - `authenticateWithGoogle(...)` uses the shared popup
    flow and the org's HttpOnly refresh cookie. OAuth/access tokens never travel
    through the popup message or app URL.
  - Superseded by the 2026-07-29 encryption-passkey entry above: new or
    logged-out SSO browsers now unlock with WebAuthn PRF, not a recovery code.
  - Superseded by the 2026-07-29 identity-partition rule above: provider linking
    is rejected. A legacy passkey account and an OAuth identity account remain
    separate namespaces.
  - Refresh preserves the original provider/passkey method and authentication
    time; refresh does not manufacture newer authentication provenance.
  - Opting into Google makes the sync account identifiable to the org,
    but does not put identity into blinded ticket redemption or inference
    traffic.
  - Superseded by the 2026-07-29 account-scope entry above: syncable local state
    is now snapshotted and restored per account.

- 2026-08-16: Sticky Parallel width can be collapsed with the existing width icon.
  - Active Parallel/Council with two model columns stays wide and hides the
    manual width control. A one-model Parallel configuration, or a session
    returned to Chat after Parallel, shows the existing expand/collapse icon.
  - The control has no visible label. Its assistive name switches between
    `Expand view` and `Collapse view`, and a per-session collapsed hint keeps
    old Parallel transcripts narrow until multi-column mode is active again.


- 2026-07-11: OpenRouter `~author/*-latest` aliases normalize in the catalog adapter,
  while provider display/icon metadata resolves through the shared provider registry;
  cached OpenRouter catalog entries also recompute provider metadata from their model
  IDs when used as a network fallback. Legacy UI paths must prefer catalog metadata,
  then resolve model IDs by author or explicit `Provider: Model` prefixes; do not infer
  a company from family keywords such as `llama`, and do not default unresolved names
  to OpenAI. Clean unknown display names keep their initial, while malformed/empty or
  explicitly `Unknown` providers use the generic `A` badge. All runtime provider
  assets are self-hosted. Unknown or missing providers fall back
  to neutral initial badges. Image load failures are handled by one capture-phase
  delegated listener, which swaps the failed image for its neutral initial badge;
  keep this fallback free of inline event handlers for strict-CSP compatibility.
  The image-failure badge uses an explicit dark foreground because known-provider
  consumers retain their white icon-circle background after the image is hidden.

- 2026-07-13: Provider logos hydrate from the local model-catalog cache before a saved
  model choice is rendered. `inferenceService.getCachedModels(...)` delegates to the
  restored session's backend; OpenRouter normalizes cached provider metadata before
  returning it. The result lives in `cachedModelDisplayMetadata`, not `state.models`, so
  stale cache entries cannot influence request-time availability or model selection.
  Session switches refresh this display-only cache for the new backend, and clearing the
  current session restores the default backend's cached metadata.
  Keep the live catalog fetch as a background refresh so saved choices such as `Auto
  Router` never flash an unknown initial while waiting on the network.

- 2026-07-02: Memory retrieval fallback now shows a safe, calm note in-chat.
  - `runMemoryAugmentFlow(...)` still logs the raw exception to the browser
    console as `Memory augment query failed:`, but the persisted local Memory
    Agent message now also carries `memoryRetrievalFailure`.
  - The failure note is classified by `chat/services/memoryRetrievalError.js`
    into safe categories such as auth, network, timeout, service, request,
    storage, runtime, and unknown. User-facing copy should stay calm and avoid
    scary diagnostic wording such as raw HTTP statuses or provider exception
    strings. Do not render raw provider error bodies, prompts, memory file
    contents, URLs with secrets, or API keys in the chat.
  - The visible Memory Agent fallback deliberately matches the normal empty
    retrieval state: `No added memory. Sending original prompt.` Structured
    failure metadata remains available for safe diagnostics and shared-payload
    compatibility, but the chat does not add a second bordered `Note:` card.
  - `buildSharePayload(...)` now routes through `chat/services/sharePayload.js`
    so shared Memory Agent messages preserve this safe reason metadata without
    pulling share-service network side effects into payload tests.
- 2026-06-27: Memory now has a global feature gate.
  - IndexedDB setting `memoryFeatureEnabled` defaults on. When false, app
    initialization and `setMemoryFeatureEnabled(false)` force `memoryMode` false
    and persist that reset so reloads stay in Chat mode.
  - The settings menu has a dedicated `Memory` section. Its first row is the
    global `Memory feature` switch; `Always attach retrieval`, the memory agent
    model, and memory import/export controls are flat rows beneath it rather
    than nested behind a vertical rule, and become disabled when the feature is
    off.
  - `triggerPostTurnMemoryExtraction(...)`, `runPostTurnMemoryExtraction(...)`,
    and `runMemoryAugmentFlow(...)` all check the feature gate before requesting
    confidential memory keys or constructing retrieval/extraction memory banks.
    Disabling the feature increments a memory-work generation, aborts in-flight
    memory retrieval/extraction signals, clears pending memory prompt overrides,
    resolves pending approval prompts as skipped, and closes/aborts memory-editor
    backfill work. The bottom chat/memory slider remains hoverable but locked to
    Chat with `Memory is off in settings` copy on the Memory icon.
    Confidential memory-key redemption now receives those abort signals, and
    returned keys are not stored if the feature is disabled during redemption.
    Memory-editor local storage operations also use an operation generation and
    abort signal so stale saves, imports, maintenance, and folder operations do
    not continue their UI completion path after the global feature flips off.
    `memoryBridge`, `memoryInstances`, and OMF import helpers lazy-load
    `chat/nanomem/browser.js` only inside active memory operations. Importing
    the app shell, constructing `MemoryEditor`, toggling settings, or validating
    disabled controls must not evaluate nanomem while the global feature is off.
    The memory panel/import/export storage bank is also lazy and only constructs
    when the feature is enabled and the user explicitly opens or uses memory
    management.
- 2026-09-14: Quick Ask caps its growing panel at the space below its positioned
  top edge, leaving 16px at the viewport bottom. Chat scrolling and window resize
  re-fit the panel while retaining its content anchor. The mini-chat scrolls
  internally and is keyboard focusable. Streaming follows the end only while
  the reader is within 24px of the bottom; scrolling upward preserves their place.
- 2026-06-03: Inline quick ask is a non-persistent mini-chat for selected
  assistant text.
  - Selecting text inside an assistant `.message-content` shows a compact
    fixed-position `Ask` popover. User-message selections, selections inside the
    quick-ask window, scrubber-restored assistant responses, and collapsed
    selections are ignored.
  - Clicking `Ask` opens a small force-touch-style panel near the selection
    as a body-level fixed overlay with a saved chat-scroll anchor, with a single unsaved user turn,
    `Briefly explain "<selection>" in context.`, and a streamed assistant
    answer. The panel is portaled out of the message container so it paints
    above the composer and message chrome while staying below modal layers, but
    `ChatArea` updates its saved anchor on chat scroll so it still moves with
    the selected response instead of staying pinned to the screen. Clicking
    elsewhere in the chat UI hides the panel without aborting the in-flight
    answer. While the popover or panel is visible, `body.quick-ask-layer-active`
    lowers the composer-specific z-indexes below the quick-ask layer; keep quick
    ask below modal `z-50` surfaces.
  - The panel intentionally has no title/selected-term header; the selected text
    is already represented by the generated user question. Keep the panel shadow
    restrained and reuse the main `.message-user` bubble styling for the quick
    user prompt so it stays visually consistent with normal chat turns. Pending
    labels and reasoning traces reuse the main chat `.pending-response-*` and
    `buildReasoningTrace(...)` formatting rather than custom quick-ask labels.
    The panel has no close control; outside clicks and Escape hide it without
    aborting the request, and reopening the same selected text restores the same
    in-memory quick-ask state. Same-session message rerenders must preserve and
    reconnect the cached quick-ask panel; otherwise key acquisition or storage
    refreshes can leave `this.quickAsk.window` pointing at a detached DOM node
    and make later `Ask` clicks appear to do nothing. Restores should reattach
    the panel without recomputing its position because its saved absolute
    `left/top` are already content-relative and should continue to scroll with
    the message.
  - `ChatApp.inlineQuickAsk(...)` appends the quick question to the sanitized
    current transcript in memory only. It reuses the current session backend,
    scrubber redaction, file-to-API processing, search and reasoning toggles,
    and the current ephemeral access credential when one is active, but it
    resolves inference to the first pinned GPT Instant model instead of the
    session's selected model. If no pinned GPT Instant model is loaded, it falls
    back through the normal pinned default path. For older sessions with a
    missing or expired key, quick ask goes through the same
    `acquireAndSetAccess(...)` ticket redemption path as a normal send with a
    model id override so ticket cost is based on the resolved instant model even
    when catalog display names differ from normalized names, shows the standard
    `Requesting ephemeral key` pending state, and re-checks the panel abort
    before inference begins. Access acquisition is keyed by backend, session,
    and model so callers with different ticket-cost models do not incorrectly
    share a redemption; same-model callers still share via
    `accessAcquisitionInFlight`. Normal send/regenerate call
    `reserveAccessAcquisitionHandoff(...)` before closing the quick-ask panel so
    same-model key requests can survive the handoff. The underlying key request
    receives an abort signal and is cancelled when the last waiter aborts
    outside that handoff window.
  - Quick-ask answers are not written to IndexedDB, do not create sessions, and
    do not update session search/title state. User close only hides the panel and
    lets the request finish in memory. Full `ChatArea.render()` calls abort/reset
    the panel so a quick ask cannot linger across session switches. Starting a
    normal send or regeneration hides any active quick ask before the main
    session stream begins.
- 2026-08-14: Fresh-chat default model is OpenRouter Auto Router.
  - `modelConfig.getDefaultModelConfig()` returns `openrouter/auto` / `Auto Router`
    unless the org explicitly disables that model. The pinned model order is an
    availability fallback rather than an override of the product default.
  - Send-time fallback tries Auto Router first, then walks pinned model IDs in
    order if Auto Router is absent from the loaded catalog, and finally uses the
    catalog's first selectable model.
  - `ModelPicker` refreshes its default label when pinned-model config updates
    and asks `ChatApp.getDefaultModelName()` for empty-session display, keeping
    the button aligned with the rendered pinned section after models load.
  - Stored preferences matching recent default labels (`GPT-5.1/5.2/5.3
    Instant`) upgrade to Auto Router. Explicit custom preferences and
    per-session model choices are still left intact.
  - When fresh pinned-model data arrives after a stale local cache, the
    availability refresh reruns the stored default preference upgrade and updates
    the no-session pending model if it was still tracking the old default.
    Initial model-catalog load also drains pinned updates that arrived while
    `modelsLoading` was true.
- 2026-08-04: Parallel/Council lane access is bound to its selected model.
  - Ordinary Chat keeps the existing key-based charging behavior: changing its
    model does not redeem immediately, and a valid verified session key can be
    tried until expiry or credit exhaustion. Parallel/Council is stricter for
    cost preflight and lane isolation. Each lane reuses access only when its
    verifier proof is approved, its station is not banned, it has not expired,
    and its recorded model matches that lane's selected model. A lane model
    change therefore makes only that lane stale and the next Parallel send
    acquires a fresh key at the new model's ticket cost.
- 2026-05-29: Parallel/Council response mode is wired as a session-level opt-in.
  - The bottom response-mode slider has `Chat` and `Parallel` states. Memory is
    a separate book-icon toggle immediately to the left of that slider, so users
    can combine `Chat + Memory` or `Parallel + Memory`; clicking Parallel no
    longer turns Memory off, and clicking the book no longer leaves Parallel. A
    single book click toggles memory auto-attach; a quick double-click opens the
    memory panel and leaves auto-attach on. Turning on user-facing `Parallel`
    from the composer exposes an inline second-model picker beside the primary
    model picker and, by default, keeps output to Stage 1 only: two model
    responses, no synthesis/chairman request. Council is no longer a visible composer mode;
    the settings menu has a `Parallel` section with a `Council review` switch.
    Turning that switch on also turns Parallel on, writes
    `outputMode: 'synthesis'`, reveals a Council model select inside settings,
    and enables the existing review pass below the two first responses. The
    primary picker uses `⌘K`, the secondary picker uses `⌘J`, and `⌘L` still
    opens the shared searchable model picker for Council selection when Council
    review is enabled or the settings menu is open. The visible Council setting
    itself follows the Scrubber/Memory settings pattern: a compact native
    select row, not a composer-style model chip. Its option values stay as raw
    catalog names for model matching, but visible option labels omit provider
    prefixes/company names like `OpenAI:` or `Anthropic:`. Secondary and Council selection can
    choose any selectable model, including the current primary model. If a
    persisted Council model is
    no longer selectable, settings fall back to the same primary/default model
    the controller will charge for instead of displaying a stale model name.
    Ticket costs remain shown inside the modal options. While Parallel is
    active, the composer shows primary and secondary model chips with provider
    icons, provider-stripped names, and full model names in tooltip/aria labels;
    the Council model is never shown in the composer. Turning Council review
    off leaves the user in Parallel but skips the Council answer. Switching the composer
    from Parallel back to Chat resets `outputMode` to plain Parallel, so the
    next Parallel use starts as two-model comparison unless the user re-enables
    Council review; synthesis access is still only preflighted/acquired when
    Parallel is active with Council review on. Toggling Council review does not
    alter the independent Memory book state.
    The picker derives the same fallback secondary model as the controller,
    including legacy model-id members and stale-member skipping, so its
    displayed model matches the lane that will be charged, and refreshes when
    model ticket tiers update. When there is no configured second model,
    Parallel prefers Google Gemini 3.5 Flash as the secondary lane if it is
    available and not already the primary model; otherwise it falls back to the
    first available non-primary model. This keeps GPT OSS from becoming the
    implicit second lane just because it appears earlier in the catalog. If the
    session's primary model is stale or unavailable, both the composer and
    controller resolve the primary lane to the default/fallback model before
    assigning the secondary lane.
    The settings menu no longer exposes duplicate legacy multi-model rows.
    Parallel is an explicit composer choice. A new chat/tab/window inherits the
    last explicit Chat/Parallel choice from the versioned
    `parallelModePreferenceV2` setting; an older global `parallelModeEnabled`
    value is ignored so historical state cannot opt a user into extra requests.
    Only the mode control writes the versioned preference, so model changes in
    another tab cannot overwrite it. The last secondary model, Council model,
    and Parallel/Council output mode are persisted as
    `parallelSecondaryModel`, `parallelSynthesisModel`, and
    `parallelOutputMode`. New single-chat sessions still keep the saved
    secondary model in their disabled `councilConfig`, so turning Parallel on in
    that session reuses the user's last secondary model instead of reverting to
    the default. The empty New Chat composer rebuilds its pending council config
    from those persisted model defaults and the versioned mode preference before
    rendering. Composer components update
    the in-memory persisted defaults through `ChatApp.setParallelDefaults()`;
    direct writes like `this.app.parallelModeEnabled = ...` will fail through
    the strict component facade.
  - The switch can be set before a session exists; `ChatApp.pendingCouncilConfig`
    carries that choice into the first created session. Enabled sessions persist
    `responseMode: 'council'` plus `councilConfig` with up to two member display
    names, `outputMode`, `synthesisModel`, and `reviewEnabled` derived from
    whether output mode is `synthesis`. The
    active session model is the primary lane; the selected second model is the
    comparison lane. Parallel with Council review off writes
    `outputMode: 'parallel'`, so synthesis is skipped and no synthesis key is
    acquired. Parallel with Council review on writes `outputMode: 'synthesis'`,
    so the selected Council model gets its own synthesis key and writes the
    final answer. Missing/legacy `outputMode` still normalizes to `parallel` to
    avoid unexpected third-key redemption. If a config only names the primary
    model, the controller adds the first available non-primary model as the
    secondary lane.
  - The Council synthesis prompt lives in `chat/domain/councilPrompts.js`. It
    asks the synthesis model to act as an independent reviewer over anonymous
    `Response A` / `Response B` drafts, briefly compare only material
    differences, errors, missing caveats, and useful synthesis, then produce a
    concise final answer to the original request. The review should be fair,
    critical, concise, and evidence-oriented, but avoid generic praise, model/provider identities,
    scores/grades/ranked lists, chatty phrasing, and generic follow-up offers.
    Partial synthesis is supported when only one draft response is available.
  - `chat/application/councilController.js` runs the selected models in
    parallel through `inferenceService.streamCompletion(...)`, preserving the
    browser-only OpenRouter path and the existing ephemeral access flow. Strict
    completion remains only as a fallback for tests or future backends that do
    not expose streaming.
  - Council access is lane-scoped under `session.councilAccess.primary` and
    `session.councilAccess.secondary`, plus `session.councilAccess.synthesis`
    for the Council answer. Each lane stores its own ephemeral key, access
    metadata, expiry, and last-issued model id. Lane keys are both lane-scoped
    and model-bound: primary only uses `councilAccess.primary`, secondary only
    uses `councilAccess.secondary`, synthesis only uses
    `councilAccess.synthesis`, and a model change refreshes that lane before
    inference. There is no cross-lane key pooling.
    `RightPanel` renders these lane records as separate Ephemeral Access Key
    rows when Parallel/Council is active: `Model 1`, `Model 2`, and `Council`
    only when synthesis/Council review is enabled. This is display-only and
    does not change key acquisition, ticket preflight, or lane isolation. The
    RHS panel intentionally shows lane roles, not model names; the current model
    choice belongs in the composer/settings while the RHS panel represents
    access-key state. The multi-lane panel notes that keys persist until expiry,
    model change, or exhaustion. When there is no active session, the RHS panel
    mirrors `pendingCouncilConfig` and shows pending `Model 1` / `Model 2` /
    optional `Council` rows only after Parallel is explicitly selected. These no-session rows
    are a preview only: they do not create a session, redeem tickets, or acquire
    access until the first send.
    Lane rows mask the actual lane token rather than the session's primary
    ephemeral alias, and use their own lightweight expiry refresh when there is
    no single-chat key timer active. If a single-chat key timer is active while
    lane rows are displayed, that timer refreshes the lane panel instead of
    looking for the single-key expiry chip; when the single key expires, it
    forces one lane-panel refresh and lets the lane timer take over. Each lane
    row owns its own verifier-attestation button and passes that lane token and
    access metadata to the modal; do not reuse the single-session key
    attestation context for the multi-lane panel.
  - If a lane key is missing, expires, is banned, or OpenRouter reports credit
    exhaustion, only that lane is cleared and refreshed. Reused lane keys are
    also checked against the verifier's live/cached banned-station state before
    use; a now-banned lane key is treated as stale, cleared, included in ticket
    preflight, and replaced before inference. A lane model switch also counts
    as stale access for ticket preflight and causes that lane to acquire a fresh
    key priced for the selected model before inference.
    Before acquiring any missing/expired/banned lane keys, the controller checks
    that enough tickets exist for all fresh primary/secondary/synthesis lanes so
    it does not partially charge one lane and then fail on another. Parallel
    with Council review off preflights/acquires only the primary and secondary
    lanes. Changing the Council model or toggling Council review does not
    proactively clear `councilAccess.synthesis`; synthesis access refreshes only
    when that lane actually needs a fresh key.
  - Parallel/Council reasoning uses the same collapsed reasoning trace UI as
    normal chat. Stage 1 lanes render `entry.reasoning` above each lane
    response with lane-specific IDs, and Council synthesis stores and renders
    `council.synthesis.reasoning` above the Council answer. Lane responses now
    stream through lane-scoped DOM targets (`primary`, `secondary`, and
    `synthesis`), so content and reasoning can appear token-by-token without
    clobbering the other lane. `ChatArea` keeps a separate
    `councilReasoningStreams` map for those concurrent traces while the normal
    single-chat `reasoningBuffer` remains unchanged. Final lane/synthesis
    completion still saves parsed reasoning, duration, citations, and canonical
    message content as before.
  - Persisted Memory mode can remain enabled globally, and send/regenerate now
    run memory augmentation once before a Parallel/Council turn fans out to
    model lanes. The approved `_lastApiContent` override is applied by
    `processMessagesWithFiles(...)` to the shared last user turn, so primary
    and secondary lanes receive the same memory-augmented prompt. The Council
    synthesis prompt still uses the canonical chat context plus Stage 1
    responses; memory is not injected a second time into synthesis. The
    override is cleared by the app-level send/regenerate `finally` block after
    the full turn completes, fails, or is cancelled. Council regenerate
    preserves the current local-only Memory Agent status row while pruning old
    model responses. A single book-toggle click only changes `memoryMode` and
    does not alter Parallel/Council session config; double-clicking the book
    opens the memory panel and keeps `memoryMode` enabled. Post-turn background
    memory extraction still runs after successful Parallel responses, so a
    separate confidential memory key redemption can appear after the visible
    model requests finish; that is memory ingestion, not a hidden response lane.
  - If Parallel is enabled after a normal single-model turn, the primary
    lane can seed from the existing `session.apiKey` when the key is valid and
    the access metadata identifies the same primary model. In that case,
    opening Parallel only redeems tickets for missing/new lanes such as the
    secondary model; seeded primary lane access records use
    `ticketsConsumed: 0`. Newly acquired single-model access records are stamped
    with `modelId`/`modelName` so council does not seed an old key whose model
    ownership is ambiguous.
  - If Parallel is disabled, `ChatApp.setCouncilModeForCurrentSession(...)`
    seeds normal single-chat access back from a valid `councilAccess.primary`
    record. Returning to single chat should therefore keep using the primary
    lane key instead of redeeming a new ticket, unless that primary lane key is
    missing, expired, banned, or later rejected by OpenRouter for exhausted
    credit. Secondary and synthesis keys are never pooled into single-chat
    access.
  - A Stage 1 council turn is stored as one assistant message with
    `message.council` metadata. `message.council.stage1` keeps the two
    first-opinion responses. In Stage 1-only mode, each future lane request
    builds API history from that lane's own prior Stage 1 responses, so the
    secondary lane does not inherit the primary lane's previous answer.
  - With Council review enabled, `message.council.synthesis` keeps the Council
    answer status/response/error. When synthesis succeeds,
    `message.content` is the Council answer and `message.model` is `Council`, so
    future turns use the prior Council answer as normal assistant context. If
    synthesis fails or the user chose Stage 1-only mode, `message.content` falls
    back to the first completed Stage 1 response; synthesis failures set
    `message.council.synthesis.fallbackUsed` to true.
  - The current implementation covers Stage 1 "first opinions" plus one
    Council review pass. It does not yet run Karpathy-style peer ranking or
    scoring.
  - `MessageTemplates` renders two council lanes side by side on desktop and
    stacked on narrow screens, then renders the Council Answer below them only
    after synthesis actually starts. Stage 1 response headers include provider
    icons. Parallel/Council does not use the generic typing-indicator row during
    access acquisition; `CouncilController` saves the assistant message before
    lane access is acquired so the selected model cards and `Waiting for
    response` shimmer appear immediately. The aggregate assistant row
    intentionally omits a visible `Parallel`/`Council` text label and redundant
    top-left mode icon; the lane cards and optional Council Answer section
    already identify the mode. Completed lane and synthesis status chips are
    also hidden, while error/cancelled/partial/fallback status remains visible.
    Pending lane cards reuse the normal chat `Waiting for response` shimmer
    instead of showing a `Pending` chip or custom `Waiting for this model to
    finish...` copy. Stage 1-only mode removes the aggregate status/note row
    instead of showing a waiting row, completion label, lane-history
    implementation note, or canonical-context explanation. While synthesis
    runs, the Council answer section is separated from the two draft responses
    by a subtle horizontal rule, then shows the selected synthesis model with
    its provider icon, providerless model name, and a visible `Council` role
    badge. It reuses the normal chat `Waiting for response` shimmer while
    omitting the aggregate `Council`/ready status row. Once the Council answer
    is available, the same selected-model row remains above the answer,
    matching the model the user chose and was charged for; redundant `Council
    Answer` header copy and completed-status text stay hidden. On synthesis failure it shows `Council synthesis failed.
    Continuing from Response A.` (or the actual fallback label). Council
    review suppresses the aggregate copy/regenerate/fork action row while
    synthesis is waiting/pending/running, then restores copy/regenerate inside
    the Council synthesis block once synthesis reaches a final or fallback
    state; fork stays disabled. Plain Parallel keeps normal actions directly
    under each completed lane response instead of on the aggregate message,
    because aggregate copy/regenerate/fork is ambiguous when two drafts are
    visible. Both the synthesis and lane action rows reuse the normal
    `assistant-actions-row` anchor so their spacing matches single-chat
    assistant actions.
    Web-search sources are also lane-local: each Stage 1 lane renders its own
    Sources button and citation carousel at the bottom of that response only
    when that lane produced citations. Council synthesis renders its own
    separate Sources button when the synthesis response has citations; aggregate
    Council/Parallel messages no longer reuse one canonical sources button for
    all visible responses.
    The Council answer block is width-capped, centered, and given extra top
    spacing below the two lanes so synthesis reads like the normal narrow
    transcript even when Parallel keeps the page wide. Lane copy copies only that lane response. Lane fork is
    intentionally disabled for Parallel lanes for now, and completed aggregate
    Council answers also omit fork; normal fork remains on single-chat
    assistant messages only.
    Lane regenerate refreshes only that lane, reusing or refreshing only that lane access; if the lane was not canonical, the
    existing canonical response stays canonical. Like normal regenerate, lane
    regenerate prunes later messages before rerunning so future context cannot
    depend on the replaced answer. Canonical citation controls stay available
    with the aggregate message.
  - Parallel/Council layout has two separate stability rules. Selecting
    Parallel changes the composer without changing transcript width. Submitting
    a turn with more than one model sets `session.hasCouncilLayoutPreference`
    and expands the transcript before the prompt and response lanes render.
    That preference preserves the wider layout when the user toggles back to
    Chat, even before a Parallel response is saved. Pending no-session Parallel
    configuration is transferred into the first session without widening the
    empty page; the submitted turn activates the layout. `session.hasCouncilTranscript`
    separately tracks saved `message.council` output across session switches and forks, and
    `ChatArea.render(...)` backfills/recomputes it from stored messages for
    older sessions. Regenerate, resend, prompt edit, and cancelled Council turns
    recompute the transcript hint after pruning, but they do not clear the
    user's sticky layout preference. The manual wide-screen toggle and
    Parallel/Council share the production transcript cap (`66rem`) so switching
    modes keeps a consistent readable measure. The top-left manual wide-mode
    button remains available while Parallel is only being configured, then is
    hidden while a submitted multi-model layout owns the wider transcript.
    Background saves may mark a non-visible session as having a council
    transcript, but root layout classes should only update for the currently
    viewed session. Composer controls are
    stable independently: the default composer keeps attachment and Settings
    visible inline, while Web search moves to the bottom of the existing
    Settings menu; there is no separate `+` menu. File upload, settings, and
    web search keep their original element IDs/handlers, and response mode and
    Memory stay visible beside them. Web search defaults on, but only the Web
    search row shows `On`/`Off` and active styling. Compact model pickers sit on
    the left side of the composer, with file/settings/mode/memory/send controls
    anchored together on the right to reduce layout flash. Chat mode shows the
    primary model icon plus a compact name; Parallel reveals the secondary
    model chip after primary. Model chips use `fit-content` natural width up to
    a shared responsive max width (`12.25rem` on desktop, `8.75rem` on small
    screens) so short model names produce short buttons while long names cap
    cleanly. The root `data-composer-mode` is refreshed from both the mode
    toggle and the multi-model settings refresh so Chat/Parallel layout rules
    apply immediately after switching modes. The composer label is the
    full provider-stripped catalog name; JavaScript does not apply a character
    budget or semantic/family-name rewrite. CSS owns the
    visual ellipsis via the label span (`overflow: hidden`, `white-space:
    nowrap`, `text-overflow: ellipsis`), so truncation follows actual rendered
    button width across devices. Labels must not wrap to multiple lines. The
    chip should not hide overflow at the button level because that clips
    descenders in labels with letters like `g`, `p`, and `y`; horizontal
    clipping belongs on the label span. The composer left action group allows
    visible overflow so model-chip tooltips are not clipped. Composer model
    chips set both
    `data-tooltip` and native `title` to the full provider-stripped catalog
    name, with no lane label like `Primary model:` or `Secondary model:` and no
    provider prefix like `OpenAI:` or `Anthropic:`. Those hover labels stay on a
    single line. When a user edits/rewrites a prompt, the edit box mirrors the
    models that will receive the regenerated turn: Chat shows the primary chip,
    while active Parallel/Council sessions show primary and secondary chips.
    The Council/chair model remains Settings-only and is not shown in the edit
    box. Changing either model while edit mode is open refreshes those edit
    chips from the composer chips. Full provider names remain visible in the shared model picker. Run
    `npm run audit:model-labels` to check the current live OpenRouter catalog
    for labels that fail providerless normalization and to inspect the longest
    CSS-truncated label. Chat mode primary chips use natural width and can grow
    up to the same width as two Parallel chips plus their gap; Parallel stays
    unchanged. Chat max width is calculated as two Parallel chip maxes plus
    `--composer-model-chip-gap`, the same variable used for the actual Parallel
    model-chip gap. Short model names still use natural button width. Keep the
    Chat width selector at ID-level specificity because the base composer chip
    width rule is also ID-scoped. The send button has a small
    left margin (`0.9rem`) so the Memory-to-send gap is wider without changing
    spacing between Memory and the other right-side controls. This targets only
    `.composer-right-actions #send-btn`, not the shared right-side control gap.
    The Chat/Parallel slider also has a small left margin so it breathes after
    the Memory/book button without changing spacing between the other tool
    buttons. The Memory book tooltip is two-line copy: the first line names
    auto-attach, and the second line says double-click opens Memory with the
    Beta badge. If the global Memory feature switch is off, only the Memory
    book is marked disabled; the Chat/Parallel slider remains interactive.
    OpenRouter catalog display names are trimmed on live ingest and cache
    load/save, and model selection helpers compare by id plus trimmed display
    name so provider catalog quirks
    like `Baidu: ERNIE 4.5 VL 424B A47B ` do not make secondary selection fail
    when the visible label omits the trailing whitespace. Parallel mode permits
    the same model in both lanes. `session.councilConfig.members` may therefore
    contain duplicate model names, and the controller preserves them as separate
    primary/secondary lane entries with separate lane access records. If both
    lanes need fresh access, they are still charged independently even when the
    selected model is the same.
  - The old `?composerVariant=...` and `?composerWidth=...` design comparison
    knobs were removed after the composer direction settled. The fixed behavior
    is full model-name chips, attachment and Settings visible inline, Web
    search inside Settings, and wider Chat-mode model-chip capacity by default.
  - Completed assistant Markdown finalization now funnels in-place content
    updates through `ChatArea.renderCompletedAssistantContent(...)`, the same
    citation -> Markdown/LaTeX -> inline-citation -> link-enhancement pipeline
    used by the normal full render path. This guards the single-chat path where
    finalized reasoning can otherwise update only `.message-content` in place.
    Normal send completion must always call `finalizeStreamingMessage(...)`,
    even when text content exists, because the streaming DOM may contain only a
    partial Markdown render from the last chunk; regenerate already followed
    this final-render pattern. Run that final message render before
    `finalizeReasoningDisplay(...)` so the final action row and Sources UI are
    rebuilt before the reasoning trace is polished. Citation metadata
    enrichment must call `finalizeStreamingMessage(message, { forceFullRender:
    true })`, because enriched source cards live outside `.message-content` and
    would otherwise be skipped by the no-flash finalized-reasoning branch.
  - `CouncilController` receives `chatDB`, `inferenceService`, and
    `ticketClient` from `ChatApp` instead of importing the service singletons
    directly. This keeps browser storage/network singleton initialization out
    of unit tests and lets `test/application/councilController.test.js` lock
    down mixed lane costs, model-switch refresh, synthesis 402 retry,
    insufficient-ticket preflight behavior, lane-specific Stage 1 history,
    partial synthesis, and synthesis fallback behavior with small stubs.
  - `chat/domain/councilPrompts.js` defines the Council synthesis prompt. It
    intentionally omits Stage 2 peer-ranking inputs, anonymizes first-opinion
    drafts as `Response A`, `Response B`, and asks the Council model to briefly
    compare only material differences, errors, missing caveats, and useful
    synthesis before writing a concise final answer. It avoids model/provider identities,
    scores/grades/ranked lists, chatty phrasing, and generic follow-up offers.
- 2026-05-26: Prompt edit file drag feedback is scoped to the inline editor.
  - While a prompt edit draft is open, file drags highlight the edit prompt card
    and keep the bottom composer drop overlay hidden, matching the drop target.
  - The edit form does not replay its enter animation on attachment add/remove
    refreshes, avoiding a post-drop flash when the attachment list rerenders.
- 2026-05-25: Memory-agent status summaries were shortened.
  - Approved/reused memory sends now use compact copy such as `No new retrieval.
    Using previously approved memory.` instead of spelling out minimized
    personal context or generic sending state.
  - No-memory adaptive sends now say `No added memory. Sending original prompt.`
    so the status row stays easier to scan.
- 2026-05-25: Pulled `nanomem` to `dbdbd4b` on top of latest upstream
  `origin/main` `9dd3581`.
  - Upstream added ingestion prompt/version-log cleanup and temporal wording
    changes. Root still depends on cancellation propagation through
    `memoryBridge`, so the abort-support patch was carried forward on top of
    upstream and verified with `test/engine/retrieveAbort.test.js`.
  - While integrating, `nanomem` version-log mutation paths were adjusted to
    respect stored bullet `v=` metadata as well as existing `_vlog` entries.
    This keeps delete/update/corroboration/compaction entries monotonic for
    memories that already have inline versions but no companion vlog yet.
  - `_vlog/` audit files are now treated as internal storage: they stay readable
    through raw storage/export paths but are excluded from the memory tree,
    search/list surfaces, bullet index, deletion deep scans, and portable
    text/ZIP exports so the agent does not ingest its own audit log. OMF export
    in the browser/IndexedDB app still preserves vlogs under
    `extensions.nanomem.vlogs` for round-trips.
  - Agent-facing memory tools normalize path strings before internal-path
    checks and reject `_tree.md` / `_vlog/` paths across read and write tools,
    including `./_vlog/...` and `work/../_vlog/...` forms.
  - Storage writes canonicalize internal paths before persisting, so OMF vlog
    extension keys like `./_vlog/...` are restored as canonical `_vlog/...`
    records instead of becoming normal memory files.
- 2026-05-25: User prompt edit mode now has an attachment draft.
  - `ChatApp.editDrafts` keeps edited text plus attachment metadata in memory while
    the inline editor is open; IndexedDB is not updated until the user saves.
  - The edit form can add newly validated files and remove existing attachments.
    On save, `message.content` and `message.files` are committed together before
    later turns are truncated and `regenerateResponse()` runs.
  - Empty-text prompts are valid only when at least one attachment remains, matching
    normal send behavior for file-only turns.
  - Edit attachments render inside the same bordered prompt editor surface as the
    textarea and controls. Global file paste routes to the active edit textarea's
    draft instead of the main chat input.
  - Edit-mode file drop routes to the hovered edit prompt card, falling back to
    the focused edit textarea. The attachment count label opens the same file
    picker as the paperclip icon.
- 2026-05-25: Forked conversations preserve generated/manual titles.
  - `ChatApp.forkConversation(...)` now asks `chat/domain/sessionSearch.js` for
    fork title fields instead of rebuilding every fork title from the first user
    message.
  - Source sessions with `titleSource: 'generated'` or `manual` keep that
    visible title plus ` (fork)`. Local fallback titles still derive from the
    first copied user prompt.
  - Forks explicitly set `titleGenerationPending: false`; copied historical
    messages are saved directly and should not restart async title generation.
- 2026-05-21: The left chat sidebar can now be toggled with `Cmd/Ctrl+\`.
  - The shortcut calls the same `showSidebar()` / `hideSidebar()` paths as the
    toolbar buttons, preserving the existing desktop persistence and mobile
    overlay behavior.
  - Superseded on 2026-09-21: a single fixed toggle stays available during the
    close animation. `data-left-sidebar-closing` only suppresses rail tooltips.
  - The sidebar toggle uses real tooltip markup, not
    `[data-tooltip]`, so the shortcut can match the model-picker style with
    separate muted `⌘` and key glyphs.
  - The delete-history sidebar icon uses the shared `[data-tooltip]` hover
    bubble, right-aligned to stay inside the sidebar edge.
  - While `data-left-sidebar-closing` is set, sidebar hover bubbles are
    suppressed so a hovered icon does not leave tooltip feedback during the
    collapse animation.
- 2026-05-18: Memory-mode stop now cancels the active memory retrieval itself.
  - The input stop button's existing chat-stream `AbortController` is threaded
    from `ChatApp.runMemoryAugmentFlow(...)` through `chat/services/memoryBridge.js`
    into `nanomem` `augmentQuery(...)` / `augmentQueryAdaptive(...)`.
  - `nanomem` now accepts optional `{ signal }` on retrieval/augment entrypoints
    and forwards it through the tool loop, adaptive no-op check, direct answer
    rendering, and the inner `augment_query` prompt-crafter request/retry sleep.
  - Aborted retrieval normalizes back to the app's cancelled-error path, persists
    `Memory retrieval cancelled.`, and does not continue into the frontier-model
    send.
- 2026-05-18: Resending a user prompt prunes approved memory context linked to
  the resent turn and any later user turns before regenerating.
  - First-turn resend clears `session.memoryRetrievedContext.entries` because
    there is no earlier approved chat context that should be reused.
  - Later-turn resend keeps entries from earlier user turns, so adaptive memory
    can still reuse context the user already approved before the resend point.
  - The resend action button is blurred and given a stable pressed/busy style
    before the message list rerenders to avoid a transient white focus flash.
- 2026-05-18: Pulled `nanomem` to `24871d9` / `v0.1.3-26-g24871d9`.
  - The latest commit tightens adaptive retrieval: before re-querying memory, it
    runs a small no-op check to skip only obvious already-covered follow-ups.
    If the adaptive agent skips with partial/low coverage before trying a
    targeted retrieval, `nanomem` now falls back to keyword search instead of
    silently reusing incomplete context.
  - `augmentQueryAdaptive(...)` now returns retrieval sufficiency metadata more
    consistently on skipped/no-new-memory paths (`retrievalConfidence`,
    `coverage`, `missingVariables`, `retrievalReason`). Root already normalizes
    these into `memoryRetrievalAssessment`, and the revised-prompt header only
    shows confidence when metadata is explicitly present in the retrieval
    result.
  - First-turn `augmentQuery(...)` still crafts prompts through the
    `augment_query` terminal tool and does not yet forward retrieval confidence
    into successful prompt results. Keep the UI quiet for that path unless
    `nanomem` later adds explicit metadata there.
- 2026-05-17: Pulled `nanomem` to `3510fb2` / package `0.1.3`.
  - The browser seam remains compatible with root `oa-chat`; `src/browser.js`
    still exposes `createMemoryBank`, `stripUserDataTags`, OMF helpers, and
    `augmentQueryAdaptive(...)`. It now also exposes `memoryBank.pruneExpired()`,
    which root uses for deterministic expired-memory cleanup.
  - Retrieval keyword search tool calls are now named `search_memory` instead of
    `retrieve_file`. Keep both labels in `MessageTemplates` so new streaming
    traces render polished names while older persisted traces remain readable.
  - Retrieval results may include sufficiency metadata
    (`retrievalConfidence`, `coverage`, `missingVariables`, `retrievalReason`,
    `uncertainFacts`). Root normalizes this into `memoryRetrievalAssessment` on
    local Memory Agent messages and `ciPromptDraft`. The UI only surfaces
    confidence as a small badge in the revised prompt header when the retrieval
    result explicitly includes confidence metadata; conservative fallback
    defaults stay internal. Coverage and missing/uncertain details remain
    internal metadata.
  - The Memory panel now understands numeric `confidence=0..1` metadata while
    preserving legacy `low` / `medium` / `high` bullets, and exposes a
    deterministic `Clean expired` action backed by `memoryBank.pruneExpired()`.
- 2026-05-10: The first UI-facing app interface seam is in place.
  - `chat/ui/appInterface.js` exposes component-specific facades for
    `ModelPicker` and `Sidebar`.
  - `chat/ui/vanilla/VanillaChatUi.js` now owns concrete component construction;
    `chat/app.js` should not import files from `chat/components/` directly.
  - `ModelPicker` now selects models through `ui.actions.selectModel(...)`
    instead of importing `chatDB`, so UI rewrites can call the same action
    without inheriting persistence details.
  - `Sidebar` still renders the current DOM, but it now receives a sidebar-only
    interface instead of the whole `ChatApp` object.
- 2026-05-10: The vanilla shell now has explicit persistence and backend ports.
  - `app.data` is supplied by `chat/ui/appInterface.js` and is the only path
    shell components should use for message/session/settings persistence.
    `ChatArea`, `ChatInput`, `MessageNavigation`, `RightPanel`,
    `MemoryEditor`, and `ChatHistoryImportModal` no longer import `chatDB`.
  - `app.services` groups ticket, network logger, proxy, and inference gateways
    for the vanilla shell. `RightPanel`, `WelcomePanel`, `ThanksPanel`,
    `ChatInput`, and `MemoryEditor` should call the injected services instead
    of importing those gateways directly.
  - The same service port now also covers verifier attestation, share URLs,
    account state, and sync. `TLSSecurityModal`, `VerifierAttestationModal`,
    `ShareModals`, `AccountModal`, and `MessageTemplates` should be configured
    through the vanilla adapter rather than reading backend modules/globals.
  - The architecture tests in `test/architecture/uiBoundary.test.js` enforce
    the current boundary: `app.js` cannot construct concrete components,
    domain/application modules cannot import UI, shell components cannot import
    `chatDB`, and gateway-heavy shell components cannot import backend gateway
    modules directly.
- 2026-05-06: The frontend architecture refactor has started with tested domain
  seams.
  - See [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md) for the target
    component map and progress tracker.
  - `chat/app.js` now delegates message API payload shaping, session search/title
    helpers, model-selection helpers, and streaming pending-phase normalization
    to pure modules under `chat/domain/`.
  - Access acquisition now goes through `chat/application/accessController.js`;
    keep UI notifications as injected callbacks so ticket redemption and verifier
    behavior remain testable without DOM dependencies.
  - `npm test` runs unit tests through `scripts/run-unit-tests.mjs`, which
    bundles browser-style ES modules with esbuild and executes Node's built-in
    test runner. This avoids adding a framework test dependency while the app is
    still HTML-first.
- 2026-05-06: `.docx` attachments are supported by local text extraction.
  - `chat/services/fileUtils.js` reads the DOCX ZIP in the browser, inflates
    `word/document.xml` plus headers/footers/notes, and extracts plain text from
    WordprocessingML before inference. The original document still stays in the
    stored attachment `dataUrl` for preview/download.
  - `chat/app.js` persists `file.extractedText` on the user-message file metadata
    for DOCX uploads. `chat/domain/messageContent.js` uses that cached text for
    normal sends, reloads, and regeneration; it does not send the DOCX binary as
    an OpenRouter file part.
  - DOCX parsing requires browser `DecompressionStream('deflate-raw')`; upload
    validation rejects unreadable documents before they enter the draft.
- 2026-05-06: Sending or regenerating a prompt now starts a prompt slide-up effect.
  - `ChatApp.startPromptSlideUpEffect(...)` anchors the active user prompt at roughly 25%
    from the top of `#chat-area`, then keeps `isAutoScrollPaused` true while the response
    streams so long model output does not pull the viewport down.
  - The effect uses a DOM-only `.prompt-scroll-spacer` at the end of `#messages-container`.
    `ChatArea` streaming/append hooks call `updateActivePromptScrollSpacer()` so the spacer
    shrinks as assistant content appears; once output is tall enough, the spacer is hidden.
  - Explicit bottom-following should go through `ChatApp.shouldAutoScrollChat(...)`.
    A live prompt slide-up effect always returns false for non-forced auto-scroll.
    `#chat-area.prompt-slide-active` and `.prompt-scroll-spacer` use `overflow-anchor: none`
    so browser scroll anchoring does not nudge the viewport as the spacer shrinks near the
    bottom of the screen.
  - While the active prompt-slide response is streaming, `updateScrollButtonVisibility()`
    suppresses the scroll-to-bottom button. That button otherwise appears exactly when the
    streamed assistant output reaches the fixed input box and can cause a one-time visual
    flicker at the bottom edge.
  - Once streaming is over, automatic visibility checks may hide the scroll-to-bottom button,
    but they must not clear a visible spacer. The minimally sized spacer often makes the
    anchored prompt technically sit at the scroll container's real bottom; clearing it there
    drops the prompt back down after stream completion. Only clear automatically when the
    spacer is already gone/tiny, or clear explicitly from the scroll-to-bottom button/new
    prompt/session cleanup paths.
  - Final stream cleanup can replace streaming DOM with shorter final markdown/reasoning DOM.
    `ChatArea.finalizeStreamingMessage(...)` and `finalizeReasoningDisplay(...)` must wrap
    those mutations with `captureActivePromptScrollAnchor({ primeRunway: true })` and
    `restoreActivePromptScrollAnchor(...)`; otherwise the browser can clamp `scrollTop`
    before the prompt spacer is recomputed and visually drop the prompt at stream end.
  - Do not persist this spacer in IndexedDB or message records. It is only a viewport runway
    for the current tab. `sessionPromptScrollAnchors` remembers the active prompt per
    session in memory, and `session.promptSlideAnchorMessageId` persists the anchor message
    id so refresh can rehydrate the viewport runway. Switching sessions detaches the DOM
    spacer, and switching back rehydrates it before scroll restoration so an in-flight or
    just-finished response does not snap downward. Reaching the real bottom or clicking the
    scroll-to-bottom button clears the per-session anchor; sending another prompt retargets
    the existing spacer rather than clearing it first.
  - When appending while a prompt-slide spacer is present, insert new message DOM before the
    spacer. Appending after the spacer and then retargeting/removing it causes a visible
    lower-then-slide-up motion on follow-up prompts.
  - Do not detach the old prompt-slide spacer at the start of `switchSession()`. `ChatArea`
    may await IndexedDB before replacing messages, and early detach creates a visible flash
    where the old session drops down. Instead, `ChatArea.render()` calls
    `detachStalePromptSlideUpEffect()` immediately before writing the new session DOM.
  - Stream cancellation must preserve any chunks already received. `chat/api.js` normalizes
    non-Error abort throws before setting `isCancelled`; otherwise a thrown abort string can
    become a generic TypeError and make `ChatApp` replace the partial assistant output.
- 2026-05-04: Sidebar filtering now combines text search, starred-only, quick
  updated-time ranges, and an exact local-date picker.
  - Star state is stored directly on session records as `session.starred` with
    optional `starredAt`; toggling it does not change `updatedAt`, so starring a
    chat does not reorder history.
  - The filter popover lives at the right edge of the sidebar search field. The
    shortcut hint is shifted left to make room for the filter button.
  - Session rows show a separate star affordance on hover/focus so users can
    discover starring without opening the overflow menu. Starred sessions keep
    that star visible. The adjacent overflow menu remains compact.
  - The popover is intentionally compact: a single `Starred only` toggle, one
    `Updated` select, and one exact-date input. Avoid expanding quick ranges
    into a grid of buttons; it makes the sidebar feel like a panel instead of a
    small filter menu.
  - When search, starred-only, or date filtering is active, the sidebar scans
    all session records from IndexedDB so older chats outside the paged sidebar
    are still eligible. Message loading is still avoided unless a text query
    needs lazy `conversationSearchText` backfill.
- 2026-04-30: Memory mode now uses `nanomem.augmentQueryAdaptive(...)` for multi-turn follow-ups.
  - New sessions initialize `session.memoryRetrievedContext = { version: 1, entries: [] }`.
  - A memory context entry is appended only after the user approves the memory prompt or auto-include sends it. Denied/skipped prompts are not reusable context.
  - First memory turns still use `nanomem.augmentQuery(...)`. Once a session has approved memory context, later turns call `augmentQueryAdaptive(query, previouslyRetrievedContext, conversationText)` so adaptive skip decisions and prompt crafting both stay behind the nanomem seam.
  - If adaptive retrieval returns `skipped: true` because previously retrieved context already covers the follow-up, root does not create another review prompt, but it does set a one-shot API override from the already-approved context so the frontier model still receives it. `No new relevant memory found` / `No new memory context needed` skips still send the plain prompt.
  - Turns with newly retrieved `assembledContext` receive a review prompt from nanomem that contains only that new context, and root appends only that new context, so the session context does not duplicate itself every turn.
  - The root app relies on the browser entrypoint exposing `memoryBank.augmentQueryAdaptive(...)`; keep `nanomem/src/browser.js` in parity with `nanomem/src/index.js` when adding new browser-safe APIs.
- 2026-04-27: First-user-message chat titles now get an async model-generated summary.
  - The app still writes an immediate local fallback title from the first user message, then after the session has a valid ephemeral OpenRouter key it requests a short title from `google/gemini-3.1-flash-lite-preview`.
  - Title generation is fire-and-forget and failure-tolerant: a failed title request leaves the local fallback title unchanged and does not block the main chat stream.
  - `session.titleSource` protects user edits. Local automatic titles use `local`, generated titles use `generated`, and sidebar/manual renames use `manual`; async generation only overwrites the unchanged local title it started from.
  - Sidebar search matches the visible title, the legacy first-prompt `session.titleSearchText` for non-manual titles, and the bounded full-conversation `session.conversationSearchText` index.
  - `session.conversationSearchText` is built from non-local user/assistant message text, capped at 12k chars per session and 2k chars per message. Long chats preserve the first searchable message plus the most recent turns, trading complete recall for bounded IndexedDB size and predictable search cost.
  - Sidebar search uses literal/token matching, not arbitrary subsequence matching. Otherwise queries like `meaning` can match characters scattered across `means. In ... GPU`.
  - Existing sessions without `conversationSearchText` are lazily indexed during sidebar search and persisted through `chatDB.updateSessionSearchIndex(...)` without broadcasting a session reload.
  - See [SIDEBAR_SEARCH.md](SIDEBAR_SEARCH.md) for the current search algorithm and cap policy.
  - While a local fallback title is waiting for model generation, `session.titleGenerationPending` applies the sidebar title shimmer. Clear that flag on success, failure, empty-title output, missing/expired access, access-acquisition failure, or manual rename so the temporary-title animation does not persist indefinitely.
- 2026-04-26: Sidebar session titles must use attribute escaping when rendered into input values.
  - First-turn titles are generated from the raw user prompt, so prompts that begin with a double quote can produce titles like `"A CPU TEE ...`.
  - `Sidebar.escapeHtml()` is text-node escaping and is not sufficient inside `value="..."`; use the attribute-safe helper for session title inputs or quoted characters will break the attribute and the browser will show the `Untitled Chat` placeholder.
- 2026-04-26: Chat send now treats OpenRouter 402 credit exhaustion as a recoverable ephemeral-key condition.
  - When a pre-stream inference call fails with a 402 whose provider message mentions credits / affordability / `max_tokens`, `ChatApp.sendMessage()` clears the exhausted session key, shows a toast, redeems a fresh key through the normal inference-ticket flow, advances the pending UI from `Requesting ephemeral key` back to `Waiting for response`, and retries the same turn once.
  - The refresh is intentionally limited to pre-stream failures so an already-started partial assistant response is not discarded or replayed unexpectedly.
- 2026-04-20: Investigated where a future pre-ingestion memory gate should live.
  - Root conversation ingestion currently happens through live post-turn extraction and manual `Backfill`; OMF import and panel edits are explicit storage writes, not chat-session extraction.
  - Live extraction runs after successful `sendMessage()` / `regenerateResponse()` completions while the global memory feature is enabled, re-reads the normalized session, and calls `memoryBridge.ingestMessages(...)` regardless of the chat-vs-memory mode toggle.
  - `memoryProcessedAt` is written after live extraction but only consulted by manual backfill; live dedupe is limited to `memoryExtractionInFlight`.
  - Keep semantic "is this worth remembering?" policy in `nanomem`. Root `oa-chat` should only handle session/UI dedupe such as "did a new user turn appear since the last ingest?"
  - `nanomem` still has no semantic pre-gate or ingest-side progress/decision event, and a no-write tool loop returns `status: 'processed'` with `writeCalls: 0`.
- 2026-04-18: Root memory backfill now runs newest-first and can be stopped mid-run.
  - `chat/components/MemoryEditor.js` now sorts backfill candidates by `updatedAt` / `createdAt` descending before calling `nanomem.importData(...)`, so the freshest chats are processed first.
  - The memory-panel `Backfill` button is now a stop control while the run is active. Clicking it aborts the in-flight confidential import request instead of waiting for the entire batch to finish.
  - Closing the memory panel no longer stops that run. `ChatApp` keeps a single long-lived `MemoryEditor` instance, so the current backfill state/controller stay on that object while the modal is hidden.
  - Abort now threads through `nanomem`'s import loop, ingestion tool loop, and OpenAI-compatible fetch client. This is currently used by root backfill; completed chats still get `memoryProcessedAt`, while the interrupted current chat stays eligible for the next resume run.
  - Root now persists `memoryProcessedAt` on each successful/skipped item completion instead of waiting for the entire backfill call to return. That way, if the user stops and immediately starts backfill again, already-finished chats are skipped on the next candidate scan.
  - Root backfill no longer relies on one confidential key for the whole batch. It now ensures a valid key before each chat import, and if a chat fails with `401` / `403`, it invalidates that key, redeems a fresh one when tickets remain, and retries that same chat once before stopping the run.
- 2026-04-13: Dev startup now hard-requires the `nanomem` submodule, not just production build.
  - `npm run dev` now runs the same submodule init step as build before launching `python3 -m http.server -d chat`.
  - This avoids the misleading browser-side `GET /nanomem/browser.js 404` that happened when `chat/nanomem` still pointed at an uninitialized empty submodule directory.
  - If a local clone does not include submodule contents, dev should now fail immediately at startup and point the user at submodule setup instead of looking like an asset-path bug.
- 2026-04-10: Root `oa-chat` now has a browser-only memory mode wired through the `nanomem` submodule.
  - Read [MEMORY_MODE.md](MEMORY_MODE.md) before touching this path.
  - The app-side contract is `chat/app.js -> chat/services/memoryBridge.js -> chat/nanomem/browser.js`; do not import `nanomem/src/...` from app code.
  - `chat/nanomem` is a tracked symlink and production build now hard-requires the `nanomem` submodule. If the bundle suddenly starts failing on `node:*` imports from `nanomem`, check that the browser entry is still pointing at `nanomem/src/browser.js`, not the generic index.
  - Memory mode is a global book toggle persisted in IndexedDB setting `memoryMode`, not a per-session mode.
  - Memory mode now also persists `memoryAutoInclude` and `memoryAgentModel`. The first short-circuits the in-chat approval wait, and the second is used by both live retrieval and memory backfill/import.
  - The retrieval summary is a local-only assistant message with an agent trace and explicit include/skip controls. Regeneration clears older local-only memory status messages after the last user turn before rerunning retrieval.
  - The pending approval row now has `Include memory`, `Always include`, `Skip`, and `Edit prompt`. After memory is approved/sent, the revised prompt remains visible in the local status message, so the approved row only shows the status chip and omits a separate view/edit button. `Always include` is not just a one-shot approve: it flips the global `memoryAutoInclude` setting on and the settings-menu switch should reflect that immediately.
  - Confidential retrieval keys are cached per session on `memoryKey` / `memoryKeyInfo` and must be invalidated on `401` / `403` auth failures.
  - Root `oa-chat` currently does not use that attested SDK path for memory mode. `chat/services/memoryBridge.js` intentionally forces the confidential memory client onto the plain OpenAI-compatible HTTPS path against `https://inference.tinfoil.sh/v1` (`provider: 'openai'`, not `provider: 'tinfoil'`).
  - `nanomem` still supports the SDK-backed, attested Tinfoil transport, but the root app is not opting into it right now.
  - The generic root-app fallback text `No added memory. Sending original prompt.` logs the underlying exception to the browser console as `Memory augment query failed:`. Check that before assuming the failure is in the retrieval prompt itself.
  - Root `oa-chat` now also has the memory filesystem modal shell from `memory-chat`, opened by `Cmd/Ctrl+Shift+M`. Storage editing and local-chat backfill are ported there, but the old `memory-chat` extractor/cancel UI is still not.
  - The settings menu `Data Controls` section now has a dedicated `Memory` row. `Export` uses the same OMF exporter as the memory panel header. `Import` uses a hidden settings-menu file input, then opens the memory panel and hands the selected file into the same OMF preview/merge flow as the panel header import button.
  - The root memory panel now also uses `memory-chat`'s OMF import/export UX, but the actual OMF logic has been moved into `nanomem`. `Export` now goes through `memoryBank.exportOmf()`, and import preview/merge go through `memoryBank.previewOmfImport()` / `memoryBank.importOmf()` instead of app-local format logic.
  - The canonical OMF format doc now lives in [nanomem/docs/omf.md](../nanomem/docs/omf.md). If OMF behavior changes, update that spec in the same change as the implementation.
  - Root `oa-chat` memory backfill is now a real `nanomem` import flow. The `Backfill` button gathers local chat sessions, normalizes them into `{ title, messages, updatedAt }`, and sends them through `nanomem.importData(...)` over the confidential memory key path instead of using a root-app extractor.
  - Backfill progress in root is intentionally light-touch: the header button turns into a stop control while it runs, and completion/stop/error is reported via toast. There is still no separate queue modal.
  - Backfill uses `session.memoryProcessedAt` to skip chats whose `updatedAt` has not changed since the last successful import. If a user reports repeated full re-imports, inspect whether `memoryProcessedAt` is getting saved on the session records.
  - Backfill/import now retries transient confidential-model transport failures inside `nanomem`'s OpenAI-compatible client before an item is marked failed. The current policy is 3 attempts total for network errors plus `408/429/5xx`, with `Retry-After` respected for `429`.
  - Failed backfill items still do not set `memoryProcessedAt`, so even after in-run retries are exhausted they remain eligible for the next manual backfill run.
  - Backfill input must exclude local-only memory-agent status messages (`message.isLocalOnly` / `message.model === 'memory agent'`) and should prefer restored scrubber content when available before falling back to plain message text.
  - The memory agent receives recent in-session conversation text on every run. `chat/app.js` builds it from all non-local-only messages in the current session, then `nanomem` trims it to about 2k chars for outer retrieval and about 3k chars for the inner prompt crafter.
  - That trim is now turn-aware, not a blind tail slice. Long assistant answers are clipped before older user turns, so follow-up retrieval is less likely to lose the previous user question while keeping the most recent turn.
  - Root `oa-chat` now runs background memory extraction after every successful assistant response in both normal chat mode and memory mode. Explicit actions such as `Backfill`, `Import`, or direct memory editing still use the same `nanomem` write path, but the post-turn extractor is no longer gated on the mode toggle.
  - The memory-agent model selector in settings is populated from the confidential model list. The allowed list is currently `kimi-k2-5`, `gpt-oss-120b`, `gpt-oss-safeguard-120b`, `llama3-3-70b`, and `gemma4-31b`. `gemma4-31b` is now the default memory-agent model. `kimi-k2-5` remains allowed and is still the only one marked slow.
  - Root `oa-chat` now mirrors `memory-chat`'s post-response extraction pattern after every successful assistant response while the global memory feature is enabled, regardless of whether the session is currently in chat mode or memory mode. The app kicks off a non-blocking background `nanomem.ingest(...)` run for the current session.
  - That live extraction path uses the same normalized message filter as backfill: local-only messages and `memory agent` status messages are excluded, and scrubber-restored text is preferred over raw stored content when available.
  - The chat controller does not implement a separate extractor. It only orchestrates `ensureMemoryKey(...)` plus `memoryBridge.ingestMessages(...)`; the actual extraction prompt/tools remain inside `nanomem`.
  - Unlike backfill, live post-turn extraction does not skip on `memoryProcessedAt`. This is intentional so regenerations and repeated assistant completions can still re-run extraction if needed. The only dedupe is an in-flight session guard.
  - The memory prompt viewer is no longer the simplified review/API modal. It now uses the same tagged prompt editor/viewer pattern as `memory-chat` (`showTaggedPromptEditor` / `showCiPromptEditor`) and persists edits in `message.ciPromptDraft.editedFullPrompt`.
  - `ciPromptDraft` in root is now a flat prompt shape: `fullPrompt`, optional `editedFullPrompt`, `status`, `linkedUserMessageId`, and `memoryFiles`. `apiPrompt` may still exist as a cached original result, but approval should derive the final send payload from the edited/full prompt via the bridge seam.
  - `nanomem` augment mode now executes `augment_query` as a real tool. The outer retrieval loop only selects files and calls `augment_query(user_query, memory_files)`. A separate prompt-crafter call inside `nanomem` then turns those inputs directly into the final `reviewPrompt`/`apiPrompt`.
  - The inner prompt-crafter prompt is now modeled on `memory-chat`'s later `ciPromptCrafter` flow, not the older "outer retrieval LLM drafts the final prompt" design. The key privacy rule is stronger minimization: names, relationship labels, and locations should be omitted unless the task truly needs them.
  - The crafter should omit generic background facts that only confirm what the current query already makes obvious. Memory should only survive minimization when it changes the answer through real constraints, tradeoffs, personalization, or disambiguation.
  - The inner `augment_query` prompt-crafter no longer sends a forced `max_tokens` cap. It now relies on the provider default and retries empty / invalid / task-less model outputs up to 3 total attempts before surfacing an error.
  - If the final crafted `reviewPrompt` contains no `[[user_data]]` tags, `nanomem` now treats that as "no personal context actually used" and returns a no-memory result instead of surfacing a redundant review prompt.
  - That inner crafter call is now streaming when the provider supports it, but the visible trace only shows coarse phase updates such as prompt-crafting / minimization / finalization. Raw inner prompt-crafter chain-of-thought should not be forwarded into the user-visible memory-agent trace.
  - There is currently no app-imposed timeout on that non-streaming crafter request. If it fails fast, look for transport/model issues or empty-output behavior, not a short client timeout.
  - Because of that change, the memory-agent trace should now show `augment_query(user_query: "...", memory_files: [...])` instead of exposing the already-crafted final prompt in the outer tool-call arguments.
  - `augment_query` is also allowed to finish with `memory_files: []` when nothing relevant exists. That should render as a benign no-memory outcome in the trace, not an executor error.
  - Memory-agent tool rows must render as soon as the LLM emits the tool call, not after executor completion. `nanomem` now emits `started` and `finished` tool events from the tool loop, and `chat/app.js` upserts trace rows by `toolCallId` so the same row transitions directly from a live running state to the final result without an extra inline `working...` / `running...` result line.
  - `nanomem` retrieval now resolves `read_file(...)` through a separator/punctuation-tolerant fallback before declaring `File not found`. This specifically covers model-generated path variants like swapping spaces / `-` / `_`, dropping `./`, or changing slash style.
  - `retrieve_file` path matching now uses the same normalized comparison and skips unreadable/path-only records, so discovery and `read_file` are less likely to disagree on whether a file exists.
  - `nanomem` now canonicalizes resolved memory paths before returning them from retrieval/augment flows. If the model emits a weird-but-resolvable path wrapper like `<|"|personal/family.md<|"|`, the storage layer may still resolve it, but the UI/returned `files` list should now show the real canonical path (`personal/family.md`) instead of the raw malformed tool arg.
  - Augment-mode progress must not blindly claim `augment_query` succeeded. If the executor returns JSON `{ error: ... }`, surface that error text in the Memory Agent trace instead of a fake “crafted augmented prompt…” status.
  - Memory-agent assistant messages are identified by `message.model === 'memory agent'`. The header is intentionally custom: inline book icon, `Memory Agent` label, and a non-hover-fading timestamp to avoid header flash during trace refreshes.
- 2026-03-22: Welcome-panel Turnstile for free preview is now intentionally lazy and single-submit.
  - The Cloudflare script/widget should not load on modal open. Warmup now starts on the first meaningful preview-email edit, not on initial render or invite-code mode.
  - Interactive Turnstile UI remains submit-gated: typing may load/render the invisible widget, but the challenge bubble should only open once the user actually submits the free-preview form.
  - While Turnstile verification is in flight, the welcome access-mode toggle, access input, submit button, and import/invite actions are locked in place. This prevents the validated email snapshot from drifting before `/chat/free_access` is posted.
  - Free-preview submission must use the locally validated email snapshot captured before `requestToken()`, not `this.previewEmail` after async waits.
  - `TurnstileBubble.destroy()` should clean up only its own widget/script DOM. Do not delete `window.turnstile` or globally remove Cloudflare iframes from the page.
- 2026-03-14: Mid-stream message actions are intentionally split between snapshot-safe actions and active-session mutations.
  - Safe actions that should keep working during streaming are copy actions and `forkConversation()`.
  - Assistant/user copy should prefer the live DOM for the actively streaming message because IndexedDB saves lag the UI by design during token streaming.
  - Code-block copy now hooks on `pointerdown` for streaming content so rapid DOM replacement does not eat the click before the handler runs.
  - Streaming code-block updates must patch the existing `.code-block-wrapper` in place; replacing the whole message HTML while the model is still appending code makes the hovered copy button flicker and drops transient copy-feedback state.
  - Forking during streaming must clone a static snapshot of each copied assistant message and clear `streamingPending`, `streamingPhase`, `streamingReasoning`, and `streamingTokens`; otherwise the new session can inherit a fake "still streaming" placeholder.
  - Timeline-mutating actions that intentionally restart generation (`edit`, `resend`, `regenerate`) should interrupt the current stream first, wait for abort cleanup to finish, then apply their normal truncate-and-regenerate behavior.
  - `Edit prompt` is side-effect free until confirm/send. Opening the editor during streaming must not stop the in-flight response; only confirming a non-empty edit should interrupt the stream and regenerate.
- 2026-03-14: The welcome-panel access-mode segmented control must position its indicator with layout-space metrics (`offsetLeft` / `offsetWidth`), not `getBoundingClientRect()`.
  - The welcome dialog is scaled down on narrow/mobile viewports with `transform: scale(...)`.
  - Measuring the active button with `getBoundingClientRect()` inside that transformed dialog returned already-scaled pixels, which made the indicator too narrow and horizontally offset only on mobile.
  - `WelcomePanel` now resyncs that indicator via `ResizeObserver` so late font/layout settling does not leave the selected pill misaligned.
- 2026-03-12: Inline citation styling must not run as a global regex over rendered HTML.
  - Replacing `[\d+]` across the full HTML string corrupted code blocks when code contained array indexing like `choices?.[0]`.
  - The breakage was especially severe because the same pattern appeared inside the code block copy button's `data-code` attribute, which malformed the header DOM and produced bogus code-block titles.
  - `addInlineCitationMarkers()` now traverses DOM text nodes and skips `pre`, `code`, `a`, `button`, and other non-prose containers so only real prose markers become clickable citations.
- 2026-03-12: Fenced code block headers should only use the first token from the Markdown info string.
  - `marked` exposes the full fence info string, not just the language token.
  - The custom renderer now trims to the first non-whitespace token and escapes it before using it in the visible label or `language-*` class, which avoids titles/classes ballooning when extra fence metadata or malformed text appears.
- 2026-03-08: Established this file as the canonical handoff log for ongoing web-app
  state. Future agents should read it before UI-heavy work and update it after learning
  something that is not obvious from the code alone.
- 2026-03-09: Assistant streaming/pending UI now has an explicit two-phase placeholder
  model coordinated across `chat/app.js`, `chat/api.js`, `chat/components/ChatArea.js`,
  `chat/components/MessageTemplates.js`, and `chat/services/networkLogRenderer.js`.
  The phases are:
  - `requesting-key`: The session is actively redeeming tickets for a fresh access token.
  - `waiting-response`: The access token is ready and the app is waiting for reasoning or
    response output to begin.
- 2026-03-09: Pending copy is semantic, not purely cosmetic.
  - Show `Requesting ephemeral key` only when the session actually needs a new or renewed
    access token (`!getAccessToken(session)` or `isAccessExpired(session)`).
  - If the session already has a valid access token, start directly at `Waiting for response`.
  - If the session starts without access, flip to `Waiting for response` when key redemption
    succeeds, at the same boundary that produces the `Ephemeral access key granted` activity.
    Do not wait for the first streamed token, because some providers emit reasoning or answer
    tokens immediately and otherwise make key acquisition look slower than it was.
- 2026-03-09: `Response stream open` in the activity timeline intentionally means
  "HTTP/SSE stream established", not "visible output rendered". Keep this separate from the
  pending placeholder semantics in chat: the label should already be `Waiting for response`
  once access is granted, so the later stream-open event must not visually reset the shimmer.
- 2026-03-09: Avoid DOM replacement during pending-state phase changes.
  - Updating the standalone placeholder by replacing the whole node caused visible header
    flashes and restarted the shimmer.
  - `updateTypingIndicator()` now mutates the existing label in place and no-ops if the
    phase is unchanged.
  - The first real assistant message must replace the existing pending placeholder in place
    via `ChatArea.appendMessage()` rather than removing the placeholder and appending a new
    node, otherwise the header visibly repaints.
- 2026-03-09: Bottom-of-viewport spacing is easy to regress in the assistant pending flow.
  - The standalone placeholder and the streamed assistant message must reserve the same
    bottom footprint as a reasoning-only assistant message.
  - `typingWrapper` was trimmed to match the assistant wrapper, and the pending states now
    include the same invisible action-row spacer used by reasoning-only messages.
  - If you tweak pending copy/layout again, compare three cases at the bottom of the screen:
    `Requesting ephemeral key`, `Waiting for response`, and reasoning-trace-only streaming.
- 2026-03-09: Assistant toolbar buttons (copy/regenerate/fork) are intentionally hidden
  while a response is still in reasoning-only streaming and no actual output tokens/images
  exist yet.
  - The buttons are not reliably actionable during pure reasoning streaming anyway.
  - A placeholder row is kept in the layout to avoid a jump when the buttons appear once
    actual output content starts.
  - Any stream-time DOM insertion that adds text/images before final re-render must target
    the shared action-row anchor, not only the real toolbar row. Otherwise the placeholder
    stays above the new content and creates a temporary gap between the reasoning trace and
    the streaming answer until completion.
- 2026-03-09: Pending shimmer styling is intentionally distinct from the reasoning-trace
  shimmer.
  - Pending labels use a dimmer muted-gray shimmer so they read as pre-output status, not
    as actual reasoning content.
  - Both `Requesting ephemeral key` and `Waiting for response` share the same shimmer effect.
- 2026-03-09: Production build cache-busting matters for pending-state UI correctness.
  - JS entry bundles were already hash-versioned, but `index.html` also references shared
    local CSS/vendor assets that can otherwise remain stale in browser cache.
  - `scripts/build.mjs` now appends the current build hash as `?v=<hash>` to local
    `link[href]` and `script[src]` references in `dist/index.html` so fresh JS does not run
    against stale shared CSS.
  - If users report "the pending UI looks wrong only in one browser" after deploy, inspect
    the built `index.html` first and confirm the versioned asset refs are present.
- 2026-03-14: Android background-streaming support now lives at the transport seam in
  `chat/api.js`, not in the chat controller.
  - `oa-chat` still builds the OpenRouter request body and still parses SSE lines into
    reasoning/content/image/token updates.
  - On Android WebView only, `chat/services/androidNativeInferenceTransport.js` can hand the
    live HTTP/SSE call to native code and poll buffered raw SSE lines back into the existing
    parser.
  - This keeps pending/reasoning/content UI behavior aligned with web/desktop because the
    parser and message-update path remain in JS.
- 2026-03-14: Launcher resume matters for Android background streams.
  - The native transport alone is not enough if the Android shell force-reloads the page on
    launcher re-entry.
  - `MainActivity` now preserves the current page when a `singleTask` launcher intent has no
    deep-link URL, so the in-flight JS promise/state survive Home -> launcher reopen.
- 2026-09-05: The composition merge is source-only for existing Vercel apps.
  - `vercel.json` skips Git builds only when the commit message contains
    `[preserve-deployments]`. This release marker preserves existing deployment
    aliases while separately named downstream apps are deployed explicitly.
  - Ordinary later commits still build normally; no project settings or domains
    need changing. This does not change the chat runtime or ticket/account defaults.

### Approved UI motion pass (2026-09-14)

The approved motion studies now use the Transitions.dev recipes in `chat/styles.css`
and the presentation-only adapter `chat/ui/uiMotion.js`. Shared dialogs (Settings,
Memory, Account, model picker, Share, Import, security details and delete history),
zkAPI Welcome/balance/withdrawal, Settings/context menus, Quick Ask, tooltips,
activity details, memory folders, native proof/wallet disclosures, toasts, wallet
status text and the accepted payment-mode pill have matching motion. Production's
waiting-response shimmer remains unchanged. No transaction, sign-in, memory or
inference state is delayed by these animations.

Closing surfaces become logically hidden and inert immediately, then retain the
actual outgoing DOM for the CSS close duration. Rapid reopening cancels that
cleanup; modal rerenders are resolved to the current child when closing. Never
clone private content for animations. Replaced toasts relinquish their ID before
an incoming toast is mounted. Activity disclosures reuse an outgoing node when
reopened. Native details retain their own open state and keyboard behavior; direct
child CSS overrides prevent an open parent exposing closed nested disclosures.
Browsers without `::details-content` keep native disclosure behavior. Reduced-motion
preferences skip delayed cleanup and CSS movement.

Quick Ask animates its inner scroller so its measured outer position and viewport
height cap stay stable. Payment-mode pill movement follows runtime acceptance,
not the initial click; initial layout and resize place it without motion. Motion
helpers are owned by the UI layer, not imported as concrete components by app.js.
Commercial's separately deployed landing/billing adapter deliberately contains only
its used DOM utilities; the commercial build deploys those modules under /landing.

The private-balance help fixture must implement `classList.toggle`, native `hidden`,
and `inert`: `setDisclosure` now owns those states together. After changing shared
motion adapters, run the entire native zkAPI suite, including
`private-balance-help.test.mjs`, not only the wallet render tests. Vercel runs both
the core and native suites from the pinned commercial checkout.

## 2026-09-21: Inference silence and failure recovery

The commercial checkout's shared chat code now implements the fixes from the
[historical review](INFERENCE_RELIABILITY_REVIEW.md). See
[Inference reliability](INFERENCE_RELIABILITY.md) for deadlines, limits and tests.
Normal waiting/streaming UI is unchanged. A session-owned warning appears after
45 seconds without transport activity, clears on activity or termination, and
is restored correctly when navigating back to a still-silent request. Council
lanes own separate warnings. Heartbeats reset silence, but not output deadlines.

`inferenceError` is a separate persisted assistant-message field for interrupted
partial answers; it is rendered with escaped text and the existing regenerate
action. It is not included in model context. Keep partial text, reasoning and
images when failing or stopping; clear pending flags in both cases. Errors must
be saved to the originating session even if the user has navigated elsewhere.
The reasoning render optimization must fall back to full rendering when an
error notice is present. Stop remains ordinary cancellation, without an error.

The stream watchdog races fetch, body reads and callbacks because not every
relay honors AbortSignal. Cleanup must never await a potentially stuck cancel
promise. HTTP error-body reads own their reader so timeout can cancel/unlock it;
response cleanup also covers an onStreamOpen callback that never settles.
The parser requires completion evidence plus usable output; malformed/empty or
truncated streams now fail instead of silently finalizing. Stream failures and
permanent HTTP errors must not be retried automatically.

## 2026-09-19: Recover OpenRouter output-budget rejections before rotating access

- Normal browser streaming requests previously omitted `max_tokens` under the
  incorrect assumption that OpenRouter would fit output to the key's credits.
  A provider default (65,536 in the reported incident) can exceed the allowance
  even when a useful answer is affordable. Broad 402 detection then spent a
  fresh ticket without changing the rejected request.
- `services/inference/openRouterCreditRecovery.js` retries a rejected HTTP 402
  once on the same key with 90% of the explicitly reported affordable output,
  respecting smaller product caps. Body preparation runs once so composed
  products cannot overwrite the reduced cap. The user subsequently requested
  a 30,000-token default ceiling, applied as described below.
- Structured in-flight-budget errors wait for `Retry-After` (1s fallback), up to
  two retries. A requested wait over 30s surfaces rather than being shortened.
  Waits are abortable. No successful HTTP body or partial generation is replayed.
- Access rotation excludes positive affordability, account-wide credit limits,
  in-flight holds and unknown structured limit sources. Explicit key exhaustion
  and legacy generic credit errors retain the existing single refresh policy.
- Terminal activity errors now carry status and an allowlisted local credit
  code, not provider text. This explains why the earlier timeline said only
  `Request failed`: its privacy sanitizer discards strings, including the
  provider message. Prompts, keys and raw error bodies remain excluded.
- Coverage: browser streaming, including regeneration and Parallel/Council
  through the shared adapter. Native Android transport and non-streaming helper
  requests do not use this HTTP recovery wrapper. These remain follow-up work,
  alongside production monitoring of station balance and admission failures.
- Tests include the exact reported affordability rejection, repeated rejection,
  cancellation, provider scope, exhausted-key classification, composed budgets,
  and a production API streaming harness. No live credentials or ticket spending
  are needed. Changes prepared against commercial chat revision `a38e534`;
  deployment and live verification are separate from local validation.
- Validation: production build succeeds; 843 core and 200 native tests pass,
  including all 11 new regression tests. Six existing native streaming tests
  fail attempting to load live model tiers; the same six failures reproduce
  on unchanged `a38e534` in this environment. Independent final diff review
  approved the change with no actionable findings.

## 2026-09-19: Set a 30,000-token generation ceiling

- At the user's request, shared request-body preparation now caps output at
  exactly 30,000 tokens. This covers browser streams, strict completions and
  Android native request bodies. Input history is not truncated. Reasoning
  continues to count toward the provider's generation budget where applicable.
- Smaller caller limits (including 24-token titles), catalog output limits and
  composed billing limits win. Capture the caller limit, run billing policy on
  the original body, then apply the ceiling. The actual SDK skips affordability
  calculation when `max_tokens` is already set; applying the ceiling first
  would raise a $1 key's 18,000-token budget to 30,000. A regression test uses
  the real SDK adapter. The 402 recovery still reduces the result further if
  the key cannot afford the request.
- Fable 5.1's published standard rates checked on 2026-09-19 are $10/M input
  and $50/M output. At these rates 65,536 output tokens cost $3.2768 and 30,000
  cost $1.50, excluding input. Thus a fresh $5 key with a short input should
  cover 65,536 output tokens; the reported 46,897 affordability does not by
  itself establish why the first request failed. Its output value is $2.34485.
  Actual key limit/usage, request input and error metadata are needed to tell
  whether this was an input cost, issued-key cap, account balance or hold issue.
  Sources: https://openrouter.ai/anthropic/claude-fable-5.1 and
  https://platform.claude.com/docs/en/models/fable-5-1/overview.
- Validation after the ceiling change: 846 core tests and 203 native tests pass;
  the same six baseline native streaming failures remain. Production build
  succeeds and independent re-review approves the real SDK budget integration.
  The user confirmed the failed request's panel shows only HTTP 402 and generic
  `Request failed`, so the incident's actual key balance remains unverified.
## 2026-09-22: Smooth widen-button placement during sidebar motion

- The left-toolbar spacer stays mounted and animates its width and compensating margin with the sidebar's existing open/close timing. Previously `display: none/block` introduced a 40px jump in the opposite direction before the sidebar moved. Shared timing variables now live at the root so both elements use the same curve.
- Overlay layouts retain a fixed 36px spacer; reduced motion disables both sidebar and spacer transitions. Endpoint positions and the fixed sidebar toggle remain unchanged.

## 2026-09-22: Wait for the session transaction before reporting access ready

- `saveSession` now resolves and broadcasts `sessions-updated` only after the IndexedDB transaction completes. A successful `put` request alone can still be rolled back. Transaction errors and aborts reject the save, including an abort after put success.
- Access acquisition already awaits this save, so inference cannot advance through that path before the credential record commits. Verification requirements, ticket redemption, and server storage are unchanged.
- Three mocked lifecycle regressions fail against the old implementation and pass with the commit barrier. They prove ordering and serialization of the key with its proof, not browser reload recovery. All 893 core and 312 zkAPI tests and the commercial production build pass; independent review approved the source change.
- The user's report of a missing key after a prolonged response wait has not been reproduced. This narrow race is a confirmed persistence defect, not a confirmed complete explanation of that incident. Reload still cannot resume an existing provider stream; this change does not refund redeemed tickets or recover credentials whose response never reached the browser.

### 2026-09-23 — host sign-in presentation

The account modal can use `signIn.renderEntry` for its signed-out username view,
including after logout. The commercial host shares its landing card there and
adapts its colors to the chat theme. Core still owns authentication, recovery,
focus and dismissal guards. The wallet button selects zkAPI in the current chat
through `changePaymentMode`, closing the sign-in focus trap before funding opens.
It does not navigate to the landing page or reload the transcript. Busy authentication,
recovery and repeated clicks cannot start an overlapping switch; a rejected switch
restores the sign-in dialog with the runtime's error. The display callback receives
only the fields documented in `EXTENSIONS.md`; no credential or inference state.
Focused regressions cover logout, recovery bypass, host data boundaries, disabled
controls, and the existing authentication handlers.

### 2026-09-23 — Google popup completion race

Chat now listens for the OAuth result before navigating the popup and keeps the
origin/source/type-checked listener alive for 1.5 seconds after observing closure.
This matches the landing page's protection against a queued completion arriving
after the close poll. Unreadable popup state is not treated as cancellation. Real
closure without completion reports that the window closed before sign-in finished;
provider errors, invalid tokens, and the five-minute timeout still fail closed.
`test/services/oauthPopup.test.js` covers the race, immediate callbacks, transient
closure, unreadable state, forged messages, errors, and timer/listener cleanup.
## 2026-09-25: Deleted local chat reload does not become a share lookup

- A tab can retain `?s=...` after its chat is deleted elsewhere. Because local and shared links use the same parameter, a local miss previously fell through to downloading a share and could show a misleading share error.
- Locally visited chats now carry `oaLocalSessionId` in that tab's `history.state`. On reload, if that exact chat is missing from IndexedDB, clear only `s` and the marker, preserve other URL/state fields, and show the neutral notice “This chat is no longer saved in this browser.” No share lookup or upload is made.
- Existing local URLs acquire the marker even when initial selection makes `switchSession` a no-op. New Chat clears it. This is navigation metadata, not a persisted deletion log; it contains no chat text or credentials and is not synced.
- External/legacy links without a matching marker retain share import behavior. This cannot retroactively distinguish an unmarked, already-deleted local URL from a real legacy share link. Storage failures still propagate instead of being mislabeled as missing chats.
- Regression tests cover deletion/reload, local startup, clearing selection, external/legacy links, unrelated markers, and unavailable IndexedDB.

### 2026-09-25 — Optional isolated localized checkout (commercial integration)

Commercial ticket purchasing has a new optional checkout site outside the chat
origin (`oa-commercial/docs/LOCALIZED_CHECKOUT.md`). Never include its Stripe.js
entry in chat's artifact: a path on the same host does not isolate local browser
storage. Catalog amounts stay explicitly labeled in their integration currency;
the separate purchase page uses Stripe's formatted localized Session amounts.
Billing history supports verified presentment currency without changing the
USD entitlement ledger. The backend creation flag stays off pending a separate
checkout deployment and real sandbox-session checks. Independent review approved
the disabled local implementation after configured-startup and Stripe CSP fixes.
