## 2026-09-22: Repeated reloads during deposit confirmation

- An open deposit dialog now retains its tab-scoped view marker while a deposit or approval is awaiting a wallet/chain outcome, even after the action returned. Reopening keeps that marker until settlement or dismissal. Explicit same-tab intent can restore after navigation to an OA chat; unrelated SDK records still respect the zkAPI-mode gate. Restoration never submits or retries transactions.

## 2026-09-21: Withdrawal reload and disclosure continuity

- Deposit confirmation copy now reads “Confirm the deposit in MetaMask to add funds to your private balance.”

- Restore prepared/retry-ready withdrawals as well as submitted/unknown ones, even after the transient tab marker has been consumed. Background submissions/finalizations open Payment history; completed records and long escape waiting periods stay quiet. Reopening only refreshes status and never resubmits a transaction.
- The first mutual-close step now says “Prepare your withdrawal.” Recovery copy explains opening MetaMask from the browser toolbar and using the existing recovery/retry actions without another page reload. The injected provider has no documented focus-existing-confirmation method; no automatic transaction or permission requests were added.
- Background wallet updates are coalesced while a guide/history arrow, panel, and follow-up scroll animate. Existing shared Transitions.dev timing and reduced-motion behavior remain; close/rerender clears deferred work.

## 2026-09-21: Restore interrupted wallet dialogs

- While an open wallet dialog runs an action, a tab-scoped sessionStorage marker records only its view and withdrawal mode. Reload restores that view even before a transaction exists; restoration consumes it, and completion or dismissal clears it. Ongoing transactions continue to restore from SDK records. Wallet secrets and recovery records remain exclusively SDK-owned. Restoration only opens and refreshes status, never reconnects MetaMask or submits a transaction.
- Startup waits for SDK initialization, initial conversation restoration, and an eligible zkAPI chat before consuming restoration. In-flight USDC approvals also qualify, even when the surrounding deposit plan is still prepared. Manual navigation/dismissal wins. Restricted session storage falls back to SDK-persisted transaction restoration.
- Funding copy says “Your deposit progress is saved in this browser.” Sidebar trash moves 4px closer to the fixed toggle without overlapping either 36px hit target.

# Optional zkAPI payments

OA Chat owns the payment-mode toolbar, balance/funding/history UI, model
pricing, and chat runtime adapter. It consumes the independently installable
`@openanonymity/zkapi-browser-sdk` at the exact Git revision recorded by
`package.json` and `package-lock.json`. The SDK owns wallet storage, proofs,
key issuance/settlement, and withdrawals. The dependency direction is OA Chat
to zkAPI; the SDK has no OA Chat submodule or UI dependency.

## Build

The default `npm run build` retains Tickets only. To enable both methods:

```sh
OA_ZKAPI_NETWORK=sepolia npm run build
OA_ZKAPI_NETWORK=mainnet npm run build
```

The network is an explicit build setting, independent of the OA organization.
Unknown settings fail the build. SDK assets are emitted under `dist/zkapi/`;
the app remains at `/`. Disabled builds do not import the SDK or emit its
wallet/proof assets. WASM/proving keys and trusted network configuration are
provided by the pinned SDK, checked during build and proof loading, and do
not require a setup ceremony or Rust installation on the host.

For the staging OA organization through same-origin Vercel rewrites:

```sh
OA_ORG_SAME_ORIGIN=true OA_ZKAPI_NETWORK=sepolia npm run build
OA_DEPLOYMENT_ORG_ORIGIN=https://org-staging.openanonymity.ai \
  OA_ZKAPI_NETWORK=sepolia node scripts/generate-zkapi-vercel-config.mjs vercel.generated.json
```

Select `mainnet` in both commands to build the SDK-pinned Mainnet configuration.
The fresh September 28 servers are selected explicitly in both the asset build
and route generator with `OA_ZKAPI_DEPLOYMENT=fresh-20260928`. For example:

```sh
OA_ORG_SAME_ORIGIN=true OA_ZKAPI_NETWORK=mainnet \
  OA_ZKAPI_DEPLOYMENT=fresh-20260928 npm run build
OA_DEPLOYMENT_ORG_ORIGIN=https://org-staging.openanonymity.ai \
  OA_ZKAPI_NETWORK=mainnet OA_ZKAPI_DEPLOYMENT=fresh-20260928 \
  node scripts/generate-zkapi-vercel-config.mjs vercel.generated.json
```

The selector accepts only repository-reviewed profiles, requires an explicit
network, and verifies the selected chain, circuit and proof hashes before
publishing. Browser configuration, SDK asset hashes, build provenance and
same-origin proxy routing use the same selected profile. Unset retains the
SDK defaults. The Commercial staging composition explicitly selects the fresh
Mainnet profile; see [the deployment record](ZKAPI_FRESH_DEPLOYMENT_20260928.md).

SDK `cf56d67` enables the verified native-ETH Mainnet configuration following
the September 28 rollout; the earlier `migration_required` guard is removed.
Building alone does not deploy or fund backend infrastructure. The generator
keeps real verifier checks enabled. Supply the appropriate
`OA_WEBAUTHN_RELAY_URL` for an account-enabled deployment. Deployment operators
must keep frontend/auth return origins allowed by the chosen OA organization.
The generated config routes anonymous zkAPI protocol traffic separately from
the OA account/ticket endpoints. The previous Mainnet deployment uses USDC
and ETH for gas. Native ETH uses a separate compatible vault, reviewed pins,
and browser origin; retain the old origin for recovery of legacy notes. See
[the native Mainnet deployment record](ZKAPI_NATIVE_ETH_DEPLOYMENT_20260927.md#mainnet-preparation-resumed-2026-09-28).

`build.json` records the OA revision, SDK version and immutable revision,
network, protocol/artifact provenance, and emitted file hashes. Hidden files and
source maps are removed before hashing so the manifest describes files that
static hosts actually serve. Pin updates
must change the package dependency and lock together; floating SDK branch
references and local workspace dependencies are rejected by enabled builds.

## Application integration

The standalone entry uses `startChatApp()` from `chat/publicApi.js`, which
loads the native payment adapter only in a zkAPI-enabled build. It returns a
promise for the app. Existing synchronous `createChatApp()` retains its
original contract. A downstream app can use `startChatApp({ extensions, ... })`
without importing the SDK or implementing payment UI. `payments: false` or
`payments: { zkapi: false }` disables the native payment adapter; an explicitly
supplied custom runtime also retains ownership of its own payment policy.

The adapter preserves one OA proxy instance and one SDK wallet. Configuration
is supplied before initialization, using fixed host asset URLs. URL query
parameters cannot silently select a daemon or change the pinned network.
Anonymous protocol/configuration/manifest/daemon requests omit account cookies,
including calls through a same-origin reverse proxy and fallback transport.
The SDK never receives account identity, ticket contents, or chat messages.
Model inference stays in OA's provider adapter with the ephemeral credential.

The System Panel keeps the shared Ephemeral Access Key, expiry, renewal,
issuing-station, attestation, and proxy controls in both payment modes. The
funding renderer declares key embedding through
`fundingSectionIncludesAccessKey()`: the Commercial Tickets layout embeds it
below the ticket summary, while zkAPI balance funding leaves it to the shared
top section. The host's Membership action alone must not suppress private-key
controls. This UI composition does not expose the SDK's provider credential;
existing access masking and private chat-binding semantics remain unchanged.

## Persistence and behavior

Both payment methods use OA's existing chat database and model catalog. Mode
changes affect how the next key is acquired. A historical chat can change
methods without moving or replacing its transcript. Ticket access stays usable
while the prior private key settles in the background. The model list shows
ticket counts or compact minimum-balance badges and per-token prices.

Deleting a plain Tickets chat does not initialize or query the private wallet.
Private chat deletion checks its own pending key, including recovery markers
retained after a switch to Tickets. Delete-all explicitly checks the whole
wallet, including private owners that are not in the loaded sidebar page.

Private notes retain the SDK's original browser database, journal, Web Locks,
and BroadcastChannel names. Wallet secrets are separate from chat storage and
account synchronization. A new origin has separate browser storage: trial
history, tickets, and private balances do not automatically transfer there.
This source reorganization changes neither contract expiry nor withdrawal
behavior. Private balance expiry does not automatically refund unused funds;
the balance help/history continue to explain the deployed contract behavior.

### Interrupted temporary-key issuance

An issuer outage can leave a saved proof and a server lease in `provisioning`
before the SDK has a key or chat owner. The pinned SDK only recovers active or
finalized leases; repeatedly asking it to settle provisioning cannot progress.
OA's `privateLeaseRecovery.mjs` compatibility adapter replays that exact saved
request under the SDK wallet lock, verifies the returned key, retires it without
exposing it to inference, and installs the SDK-verified signed receipt. It never
clears a journal merely because a key was not returned. It also reconciles an
ownerless active/finalized request left by interruption during this recovery.
Move this behavior into the SDK when updating the dependency, retaining these
regression tests.

New Chat, deletion, renewal, and withdrawal share this recovery path. Settlement
waits are bounded (30 seconds at the shared SDK boundary, 45 seconds including
chat cleanup); the status exposes **Stop waiting** and **Retry**. Stopping a wait
preserves the journal and any SDK mutation still holding the wallet lock. A
second attempt cannot start overlapping work while that mutation is unfinished.
Once the service returns, retrying reconciles the saved request so deletion and
withdrawal can proceed. During an unresolved issuer outage they can still be
blocked: the server has reserved the note's nullifier, and a client cannot safely
assume that a missing response means no key was issued. No automatic refund or
force-reset is performed.

## Wallet methods: MetaMask and Send to an address

The web app offers exactly two choices: **MetaMask** first, then **Send to an
address**. Native-ETH deployments hold ETH and display its current USD value;
this is not fixed dollar credit. MetaMask keeps the existing deposit/withdrawal
flow, with a payable ETH deposit instead of token minting and approval.

The address option creates and durably saves a separate Ethereum account in the
browser before displaying it. New accounts have no password, backup download,
or unlock/lock step. A non-extractable AES-GCM CryptoKey and the encrypted signer
and transaction journal are structured-cloned into the same strict IndexedDB
transaction. This is browser custody, not protection against executing code on
the same origin. Clearing site data or losing this browser profile loses both
the public funding account and the separate SDK private-note recovery state.
Nothing is synchronized with an OA account. Existing version-1 password accounts
are never overwritten; a one-time password conversion retains their exact key,
address, nonce and signed journal. New account setup never offers a password.

The balance and welcome dialogs share one deposit amount field above the
MetaMask / Send to an address choice. Both methods use the same USD/ETH currency
button and keep the exact ETH principal when switching methods or display
units. MetaMask's amount control does not create a browser funding account;
only selecting Send to an address starts that method's address and fee checks.
An edited draft follows the method switch instead of being replaced by an older
address-scoped amount. An in-progress SDK deposit always keeps its saved amount.

For USD entry, the SDK reads a pinned,
fresh finalized Chainlink ETH/USD reference price and computes an exact integer-gwei principal,
rounding up by at most one gwei. ETH entry is exact, with up to nine decimal
places to match the native ledger's gwei precision. The host durably saves this intent through
`chatDB` settings under a chain/vault/address scope before displaying payment
instructions. The ETH principal stays fixed across price updates and reloads;
switching the input currency changes its presentation without repricing the
deposit. The switch uses the already-loaded, validated price and local storage;
balance and fee checks run afterward without delaying the input update. A
just-edited amount is converted with that same loaded price before switching.
If no valid price is loaded, conversion reports this immediately instead of
waiting for an RPC or using a stale price. Explicit amount edits replace the principal. The selected input unit
is saved with the intent and restored when reopening. Current USD display continues
to float with the oracle price. Amount edits invalidate Next immediately, and
stale asynchronous reads cannot re-enable it.
The reference uses the latest finalized round, with a 4,500-second age limit,
and can lag the chain head. Unavailable or stale pricing blocks USD conversion;
exact ETH amounts remain visible without an invented dollar value.

The screen emphasizes the exact ETH still to send and its current USD estimate,
network and funding address, with a short waiting/ready status. A clickable question
mark beside the send amount reveals the breakdown: ETH principal added to the
private balance, estimated network fee, additional fee buffer and total ETH to
send, together with the estimate and browser-storage explanations. These details
start closed; they are not hover text. ETH already held at
the funding address reduces the requested transfer. A five-second read-only
loop checks funds, reusing the fee quote for up to 30 seconds. The SDK prepares
and durably stores a note draft independently of `pending_deposit`; no funding
quote connects MetaMask, authorizes a signer, or broadcasts a transaction.
The provider simulates the exact payable deposit with only the sender's balance
overridden, then estimates its gas. RPCs lacking state-override support fail
closed instead of substituting a fixed reserve.

Valid address-payment instructions also display a locally generated QR code.
Its [ERC-681 URI](https://eips.ethereum.org/EIPS/eip-681) binds the public
funding address, configured chain ID and exact remaining transfer in wei:
principal plus the fee allowance, less funds already held at that address.
It is not a QR for only the private-note principal. Editing the amount hides
the old QR immediately; missing, stale or failed fee estimates and a zero
remaining transfer do not show a payable code. The SVG and encoder are bundled
locally, with a fixed white quiet zone in both themes. No QR service, private
key, recovery material, account identity or inference content is involved.

Expected fee is estimated gas multiplied by current base fee plus priority fee.
The maximum allowance uses the SDK's padded gas limit and current EIP-1559
maximum price; their difference is the additional buffer. The unchanged 300-gwei
and 0.02-ETH caps are signing safety limits, not the normal prefunding amount.
**Next** requires enough ETH for principal plus the allowance, forces a fresh
quote and checks the saved amount before and after the asynchronous reads.
An increased allowance requires reviewing the new quote and another explicit
click. Submission binds the exact prepared operation, commitment, principal and
fee ceiling, then rechecks simulation, fees and expiry before signing.
Fresh maximum price can be clamped to that approved total allowance divided by
actual padded gas, so modest increases consume the existing buffer instead of
requiring a larger allowance. The current next-block base fee plus tip must
still fit, and the signer never exceeds the amount already approved.

After confirmation, canonical receipt gas usage/effective price yields an actual
fee in SDK deposit history. The UI labels the current public address balance
separately; it can include unrelated incoming transfers, so it is not described
as a guaranteed refund. Old records with unavailable fee metadata do not show a
made-up zero fee. Unused ETH remains at the funding address for future fees or
an explicit return. The external sender pays its own transfer fee in addition
to the amount sent.
Closing the dialog stops polling; reopening restores the same intent/address
and resumes reads. Signed-transaction and private-note recovery remain in their
existing durable journals, and reopening never authorizes new signing.
Welcome sends any saved SDK deposit to the balance dialog's existing recovery
controls without replacing its amount. Withdrawal and saved-deposit views have
their own cancellable public-balance polling, which retries transient storage
and RPC failures without creating an address or invoking signing.

Native asset support requires a newly deployed native vault and matching server
and independently pinned SDK manifest. Existing ERC20 deployments/notes must
not be relabeled or silently migrated to native ETH. The prior production URLs
remain ERC20 until the native deployment and verification are completed. Native
protocol accounting uses gwei (1e9 wei per unit), preserving exact integer
circuit accounting. A lease binds a fresh oracle round into its existing
prompt-free authorization/proof payload. The server converts actual verified
USD usage at that lease's fixed rate; later ETH price changes affect displayed
wallet value but never reprice a completed lease.
New deployments also require the repaired `zkapi-v2-note-bound-v1` circuit,
matching WASM/proving keys/verifier, the historical-root withdrawal-challenge
repair, and an operating challenge service. The legacy circuit cannot safely
be used for a fresh ETH deployment. Its initial empty native Sepolia test vault
is abandoned. Existing origins remain available solely to preserve their
matching recovery paths. The repaired setup remains a single-party development
setup, not an audited production ceremony.

The address provider validates the configured chain, token and vault, exact
calldata and authorized amount/destination. It simulates calls and applies gas
and fee caps. Signed transaction bytes and nonce are encrypted and durably saved
before broadcast. Explicit recovery replays those identical bytes; ordinary
status reads never broadcast. Web Locks serialize local signing across tabs;
unsupported storage or locks fail closed for this option. All RPC requests use
the existing SDK transport with credentials omitted; no separate proxy policy
or `globalThis.ethereum` substitution is introduced.

New browser records use AES-256-GCM with a non-extractable browser key. Legacy
records retain PBKDF2-SHA-256 until explicit conversion. The encrypted journal
envelope has a 4 MiB limit. The signer uses the SDK’s EIP-7825 ceiling of 16,777,216 gas, with
additional caps of 300 gwei and 0.02 ETH in gas fees. New transactions use
EIP-1559 with the app's **Low** policy: 1.25 times the latest base fee (rounded
up) plus a priority fee estimated from recent low bids, clipped to both caps.
The tip is the integer median of the gas-weighted 10th-percentile rewards in
nonempty blocks within the latest 20 blocks, with the existing 0.001-gwei minimum. Empty blocks
are excluded; an entirely empty history uses that minimum. This avoids blindly
accepting an expensive `eth_maxPriorityFeePerGas` default. Quotes and all newly
signed address transactions use the same policy; MetaMask remains wallet-owned.

`eth_feeHistory` is pinned to the exact sampled latest block number. Its window,
array lengths, unsigned quantities, gas-used ratios and last sampled base fee
must match that header; the header must be no older than 120 seconds and no more
than 30 seconds in the future. Invalid, unavailable or inconsistent history
fails closed instead of falling back to a higher-priced default. The quote must still cover a full next block's base-fee increase and
the priority fee, otherwise signing stops. Missing or malformed fee data also
stops signing. Affordability uses the maximum possible fee, while the chain
charges the actual fee. Existing legacy and type-2 recovery records replay
their original bytes; the app does not raise fees or replace a pending
transaction automatically. These limits can temporarily block a valid operation
during high fees. Same-origin application code can use the browser-held key.

Before-broadcast funding and fee failures keep a public-only explanation scoped
to the active action. After the SDK finishes preserving or releasing its own
submission claim, the host restores that explanation over generic wallet-error
copy. Insufficient ETH reports the exact shortfall from the freshly checked
balance and maximum fee liability, the funding address/network, and an explicit
retry instruction. Fee-limit and malformed-fee errors use fixed copy. No RPC
error payload, proof, calldata or secret enters these explanations, and they
are not persisted. A top-up or status refresh never retries the transaction.

For withdrawal, the funding account pays gas and the user supplies a destination
address. The SDK binds that destination into its proof and durable journal;
resumed withdrawals keep it. Mutual close, escape initiation, finalization and
background withdrawals share the normal SDK lifecycle. The address panel also
returns public token funds or remaining ETH to an explicitly chosen address,
with confirmation. Do not infer a return destination from an incoming transfer,
which may have come from an exchange. Return the private balance before returning
ETH so its withdrawal can still pay gas; unsettled public transfers must be
recovered before a new action.
Once a usable funding address exists, the collapsed return-funds controls remain
available in every address view, including a new deposit or after a note closes.
Their availability does not depend on an ETH/USD quote, saved deposit intent or
successful balance read. Returning interrupted-deposit or remaining gas funds
does not require creating or funding another private note.
The optional ETH amount accepts up to 18 decimal places without floating-point
rounding. A blank amount returns ETH after reserving the maximum fee for an
ordinary Ethereum account. The amount and signed transaction use the same fee
quote; a small ETH balance can remain when the actual fee is lower. Contract
destinations require an exact amount so the signer can simulate and estimate
the actual transfer.

The implementation follows the CLI's local-signing approach at revision
`a376a9e53022179dec985a10e4eb4854fa8eb486`, with browser-specific encrypted
storage/unlock and explicit withdrawal/return controls. The SDK dependency adds
provider injection and a per-withdrawal destination option at immutable revision
`08c7666e949169b87de8b5ebaacbe106d7432b0e` for the original ERC20 address
flow. The native ETH rollout instead uses the separately reviewed note-bound
SDK/protocol and new deployment pins; see the deployment progress document.

## MetaMask funding setup

Native ETH onboarding keeps the “Set up your wallet” disclosure with three
steps: install MetaMask, add ETH, and return to deposit. ETH also pays network
fees. The following token-specific details describe the preserved legacy
deployments: four steps install MetaMask, add USDC, add ETH for fees, and return
to deposit. Both tokens must be on Ethereum Mainnet in the same account. Official
MetaMask install/buy links remain alongside the relevant steps. Sepolia retains
its separate free test ETH/demo-token instructions; no real purchase is suggested.

Account setup, billing explanation, and payment history use the installed
Transitions.dev grid accordion and chevron hooks, with one guide open at a time.
Open/close takes 420ms in both directions; text stays crisp. After expansion settles, the dialog
scrolls over 320ms only when needed to reveal content. Manual interaction,
closing, and rerendering cancel deferred scroll work. Reduced motion skips all
animation. History opens in place, preserving its existing action bindings.
The dialog header stays vertically anchored while guides expand, and dividers
span the full row. Existing showSurface/hideSurface handles modal entry/exit.

The mainnet funding line now reads “USDC on Ethereum.” Saved deposits retain a
short reminder to check MetaMask for a pending transaction before resuming.
Cancellation and submitted/unknown transaction recovery states are unchanged.
Guide expansion, keyboard focus, and scroll survive wallet refreshes, and the
funding amount remains editable without refresh stealing focus in `fund` view.

After an automatic Sepolia test-token mint, funding reads the token balance at
the confirmed receipt block instead of the provider's potentially cached
`latest` state. The SDK checks the canonical block hash and selected network
on both sides of the read and bounds read-only retries. A delayed read does not
send another mint. Mainnet deposits and withdrawals retain their existing
transaction paths, durable recovery, and on-chain/indexer root checks.

A saved deposit can still have a pending token approval in MetaMask, including
after approval confirmation polling times out. The recovery notice preserves
the saved amount/private note and asks the user to check pending transactions
before resuming; it does not infer that nothing was submitted from a prepared
deposit alone.

Sources for the onboarding copy:

- [Install MetaMask](https://support.metamask.io/start/getting-started-with-metamask)
- [Buy crypto in MetaMask](https://support.metamask.io/manage-crypto/move-crypto/buy/how-to-buy-crypto-in-metamask)
- [Sepolia faucets](https://ethereum.org/en/developers/docs/networks/#sepolia)

## Verification

Run `npm test` for the existing OA suite and the native payment adapter tests.
The SDK integration passed 744 OA tests and 164 native payment tests. The exact
dependency and lockfile also passed a fresh `npm ci` without Git/npm credentials
and with SSH disabled; the public GitHub package requires no private checkout.
The SDK repository tests its own wallet, recovery, transport, and proof-asset
boundaries independently, including installation without an OA checkout.
Live browser checks should cover both payment methods, new and historical
chats, model tier changes, settlement during a switch to Tickets, funding,
withdrawal navigation, and layout. Mainnet UI checks require no transaction.

## Recovery presentation (2026-09-21)

Normal MetaMask waiting is a neutral status line. Unknown deposits offer “Check payment status” and a secondary “Try again in MetaMask”; the latter retains explicit confirmation and the SDK’s saved-deposit safeguards. These UI refinements do not change transaction submission, polling, persistence, or recovery ownership. Funding disclosures use matched 420ms transitions with deferred scrolling and a stable scrollbar gutter.

## Native ETH versus token cost comparison (2026-09-27)

The user's report of higher costs prompted a receipt and contract comparison.
Fresh public RPC reads verified successful canonical receipts for these Sepolia
deposits; gas fees are denominated in ETH for both asset types:

| Completed deposit | Gas used | Effective price (gwei) | Actual fee (ETH) |
| --- | ---: | ---: | ---: |
| [Earlier MetaMask/test token](https://sepolia.etherscan.io/tx/0x009ffd6f2535789e2c699e54910b5183e8eabb0aa81981ac7982c769c58c6d1c) | 6,897,262 | 1.131375066 | 0.007803390250469292 |
| [Earlier address/test token](https://sepolia.etherscan.io/tx/0xf3a41c990f742e3e30171c5d08e2a7d7b92814b26831b7ec63772c54b649b781) | 6,753,103 | 1.103575050 | 0.007452555980880150 |
| [Current address/native ETH](https://sepolia.etherscan.io/tx/0x74cb011fc5fec292e89658ce18e99343c3beead542ed99258d2d4b6679cab3a9) | 6,742,196 | 1.060659586 | 0.007151174818090856 |

Native used 0.1615% less gas than the earlier address/token deposit and paid
4.0440% less in those recorded transactions. Repricing native at the exact
older gas price gives 0.007440519287809800 ETH: the asset switch itself does
not explain materially higher costs. The earlier token approval was a separate
45,921-gas transaction costing 0.000044138983382823 ETH; do not compare an
approval-only wallet quote with the whole deposit. No known historical Mainnet
user receipt was supplied, so these are not assertions about that user's own
Mainnet transactions.

The same comparison for withdrawal shows 7,057,861 gas / 0.007476799452342588
ETH previously and 7,043,946 gas / 0.007545454436185302 ETH now. Gas usage fell
0.1972%, while the actual fee rose 0.9182% because the inclusion gas price rose.

At 2026-09-28 01:55:11-12 UTC, Sepolia block 11797356 had base fee
1.011009441 gwei and Mainnet block 26072794 had 0.093624413 gwei. With the
same sampled Low tip of 0.001 gwei, 6,742,196 gas would cost respectively
0.006823166005072436 and 0.000637976338830948 ETH (about 10.7x). This is a
read-only price comparison using identical assumed gas, not a native Mainnet
simulation or transaction. Future block prices vary independently.

Source comparison of protocol `b542b1b` (ERC20) to `8b2d4e3` (current) found
no changes in `contracts/src/libraries/Bn254Poseidon.sol` or
`MerkleUpdateLib.sol`. `ZkApiVault.deposit` computes the note leaf and calls
`verifyAndUpdate`; it never invokes Groth16 verification. The 32-level update
hashes both old and new roots (64 node hashes). The native branch validates
`msg.value` and skips ERC20 `safeTransferFrom`.

Existing Forge tests under the current compiler config measured native deposit
6,015,645 gas versus mock-ERC20 deposit 6,045,270 gas. Root hashing alone used
5,756,030 gas (95.68% of native). These are controlled call measurements, not
live receipt totals; their withdrawal fixtures mock proof verification and must
not be cited as production withdrawal costs. The meaningful optimization target
is implementation-equivalent Poseidon code with identical constants, domains
and outputs, differential tests and review. Immutable linked deployments would
require a new vault rollout; no contract or deployment was changed in this
investigation.

Presentation caveat: `renderFundingWei` currently converts Sepolia test ETH
using the real ETH/USD reference too. Such dollars are an illustrative test
value, not the market value of the test asset or a Mainnet gas quote. Explicit
test/reference labeling is a UI follow-up. The total requested funding also
includes an additional buffer that is not necessarily spent. Ethereum's
[gas documentation](https://ethereum.org/developers/docs/gas/) explains the
gas-times-price calculation, and its [network documentation](https://ethereum.org/developers/docs/networks/)
distinguishes test assets from actual-value Mainnet transactions.

## Mainnet MetaMask $26.45 fee investigation (2026-09-28)

The user reported a pending Mainnet deposit quote of $26.45 on MetaMask's Slow
setting, with gas limit **6,759,269**, max base fee **1.6097 gwei** and priority
fee **0.0001 gwei**. These are user-reported pending UI fields, not a submitted
transaction or captured provider payload.

At **14:22:51 UTC**, public Mainnet block **26076524** had base fee
**1.347259214 gwei**. The pinned finalized Chainlink ETH/USD round (updated
14:02:35 UTC) was **$2,682.88068716**. At that snapshot:

- Spending all 6,759,269 reported gas units at base fee alone costs about
  **$24.4316**. Adding the reported tip gives **$24.4334**.
- The entire priority fee is only **0.0000006759269 ETH**, about **$0.0018**.
  A lower tip cannot materially change the quote. The reported $26.45 is
  consistent with this gas magnitude and moving fees; it is not an exact
  reconstruction of MetaMask's own price source or estimation timestamp.
- Treating the reported maximum base allowance plus tip as 1.6098 gwei gives
  about **0.0108810712362 ETH / $29.19** maximum for that gas limit. Expected
  fees and maximum allowance are distinct; unused gas is not charged.
- The observed base fee is **5.32 times** the prepublication RPC gas-price
  sample of 0.253192496 gwei. Earlier low Mainnet price observations were not a
  durable property of Mainnet. The expensive contract work affects both chains.

The installed SDK's MetaMask path does not set gasPrice, maxFeePerGas or
maxPriorityFeePerGas. It asks the wallet to estimate the exact call and sets a
bounded gas limit: floor(estimate × 1.2) + 50,000. The actual legacy Mainnet
frontend `NVSQQZXU` used SDK `08c7666e949169b87de8b5ebaacbe106d7432b0e`, whose
gas helper is byte-identical to native SDK `cf56d67`. A local provider mock and
two focused tests confirmed the supplied fields are from/to/data/value/gas;
MetaMask controls fee rates. Native adds payable value and skips token approval.
The reported gas limit is already near measured deposit consumption; do not
attribute this specific $26.45 quote to the SDK's generic headroom without
capturing the actual wallet transaction parameters.

The actual legacy deployment manifest identifies protocol
`e4efda23e6d416ee132938e4e67924fb0f7d4fe2`. Its Poseidon and Merkle source files
and compiler configuration are identical to current `8b2d4e3`, and both Mainnet
vaults use Poseidon library `0xc6B55e86668d8c446B3D81273AAb9CBb20F28c7f`.
Deposit verifies the old root and computes the new one: 32 levels × two node
hashes, with two domain-separated sponge permutations per node hash. This is
128 permutations plus the leaf's three. Deposit does not call the Groth16
verifier, so the note-binding security repair does not add deposit verification.

Fresh controlled call benchmarks passed ten tests with solc 0.8.28, via IR,
optimizer 10,000, Prague and identical current dependencies:

| Source/asset | Deposit-call gas |
| --- | ---: |
| Legacy e4efda2-equivalent contracts, mock ERC20 | 6,090,717 |
| Pre-native b542b1b, mock ERC20 | 6,090,717 |
| Native a88fbb8 before note-binding repair | 6,063,084 |
| Current 8b2d4e3, mock ERC20 | 6,090,809 |
| Current 8b2d4e3, native ETH | 6,063,084 |

Native saves 27,633 gas (about 0.454%) versus legacy in this fixture; the security
repair adds zero native deposit gas. Root-call measurement was 5,828,831 gas in
every case, roughly 96% of native call cost. This fixture uses ERC20Mock, one
note in an empty tree, current dependencies and gasleft around a call, including
encoding/sibling reads. These numbers are not live receipt totals, live USDC
measurements, or an exact live opcode attribution. The fixture's optimizer
setting also differs from the Mainnet release artifact's 200-run setting.
Archived 58eea17 was executed for legacy; its complete contracts tree is
byte-identical to actual legacy e4efda2. A historical Mainnet receipt comparison
was unavailable through the configured public RPC's archive access; no claim
is made about the user's unidentified earlier transaction. Native deposit logs
were empty through block 26076524, consistent with a pending new deposit.

The substantive optimization target is implementation-equivalent Poseidon code
that preserves constants, domains, sponge operations and outputs, with
cross-language differential tests and independent review. A generic Poseidon
hash2 is not a compatible replacement. The linked vaults are immutable, so
contract optimization requires a new reviewed deployment and explicit wallet
recovery/migration handling. Lowering the gas limit does not reduce required
work and can cause out-of-gas failure. No fee policy, contract, deployment or
wallet state was changed during this investigation.

The gas rise also affects challenger funding. At **14:29:37 UTC**, block
**26076556**, challenger `0x667F2BB2aC6f56516B2e064B8be91526E86A6fF3`
still held **0.005 ETH** (mined/pending nonce 0/0), while RPC gas price was
**1.565704917 gwei**. The installation readiness allowance of 10,000,000 gas
therefore required **0.01565704917 ETH**, a **0.01065704917 ETH** reserve gap.
The daemon sets its transaction gas limit to the estimate plus 20%, within the
signer's 10M-gas and 3-gwei limits; this does not establish that every challenge
would fail. Current funds cover approximately 3.19M gas at that price. The full-ceiling reserve
check runs at installation, not continuously, so a healthy running service
does not establish adequate challenge funding. At the snapshot the vault held
zero ETH, had zero notes and was unpaused; pending challenges were zero, and
checkpoints advanced through 26076560 at 14:30:41 UTC. No funding, pause or
other runtime change was made. Recheck gas prices and reserves before relying
on readiness for new deposits.

See [Ethereum gas calculation](https://ethereum.org/developers/docs/gas/) and
[MetaMask's gas controls](https://support.metamask.io/more-web3/learn/user-guide-gas).

## Low-fee address transactions (2026-09-27)

Low is the default for new Send-to-an-address deposits, withdrawals and public
returns. The compact funding UI omits slow-confirmation explanations. It is an OA policy,
not a claim to reproduce MetaMask's remotely supplied Low estimates exactly.
See [MetaMask gas customization](https://support.metamask.io/configure/transactions/how-to-customize-gas-settings/),
[MetaMask fee controller](https://github.com/MetaMask/core/blob/main/packages/gas-fee-controller/src/determineGasFeeCalculations.ts),
and the [Ethereum fee-history method](https://ethereum.github.io/execution-apis/api/methods/eth_feeHistory/).

The former 2x base-fee allowance was conservative. Reducing it to 1.25x lowers
maximum prefunding by about 37.5% when base fee dominates and other inputs match.
This reduces the maximum reserved amount; it does not reduce Ethereum's actual
base fee or the contract's gas consumption. In the prior live deposit, 6,742,196
gas at 1.059659586-gwei base fee cost 0.007144432622090856 ETH; its already-low
0.001-gwei tip added only 0.000006742196 ETH (0.0943% of the total). A lower tip
could not substantially reduce that transaction's actual charge. Contract-gas
optimizations or waiting for a cheaper network base fee are separate changes.

## Gas estimates and remaining ETH (2026-09-27)

The former fixed 0.02 ETH reserve produced substantial overfunding: one live
Sepolia deposit used 0.007528036291476899 ETH in fees, leaving
0.012471963708523101 ETH from that reserve. These are historical observations,
not quotes for future transactions. The implemented prepare/simulate flow above
replaces that prefunding rule while preserving the signing caps.

The SDK owns the durable quote draft, note secret and operation identity.
Repeated quotes for the same amount retain the commitment and refresh its
append path under the browser wallet lock. Next atomically promotes that exact
draft. A definitely unsubmitted saved deposit can be requoted at its fixed
amount; an already submitted or ambiguous operation cannot silently be replaced
with a new note. Actual fee metadata is recorded only when the receipt and
transaction match the deposit and its canonical block.

An address retry after an ambiguous result first calls the SDK's explicit
prepare-only retry API. It can recover a confirmed deposit, or mark an exact
retry eligible for quoting without signing. The fee quote keeps the original
saved Merkle path; it must not rebase a still-ambiguous operation. Only after the
user reviews the resulting quote can Next authorize the matching operation.
MetaMask retains its existing retry behavior. When a saved plan originated in
MetaMask and has no address-scoped USD intent, the host rebuilds that intent
from the fixed SDK gwei amount and shows current USD as a reference only.

Exact future contract gas charges cannot be reliably guaranteed while the user
is still sending funds. Depositing balance minus maximum fees still leaves
unused allowance, changes the promised principal, and encounters the native
note's integer-gwei rounding. Refunds are additional transactions with their
own fee; never infer a refund destination from the incoming sender, which may
be an exchange or other intermediary.

For an exact user-facing invoice, a browser-controlled smart account/deposit
contract and sponsored execution could quote principal plus a disclosed fixed
service fee while the sponsor bears gas variance. A plain relayer cannot move
ETH out of the current EOA or pay its transaction gas without additional
execution/authorization architecture. Any such change needs a separate design
and review, preserving browser-local note secrets and avoiding account identity
or inference data in sponsorship requests. Sponsorship is a separate design and is not implemented by the fee-quote change.

## Review merge and deposit outcome reporting (2026-09-27)

The note-bound SDK/backend review fixes are merged with native ETH. See the
[acceptance matrix](ZKAPI_REVIEW_MERGE_20260927.md) for each protocol finding,
optional execution mode, manual UI observation and remaining coverage limit.

An interrupted receipt wait is not evidence of a failed deposit. Account and
welcome dialogs use neutral pending copy only when the SDK has both a saved
submission phase and evidence that broadcast may have happened. Confirmed reverts
and receipt/note mismatches remain errors. Indexer lag ends the transient activity
as pending while durable SDK recovery still controls whether another deposit is
allowed. No host UI infers success from an unrelated existing note. Accountless
use is stated inside existing collapsed help, leaving the compact address screen
unchanged.

Once the SDK has atomically saved the exact confirmed deposit and its history,
`confirmDeposit` returns that operation's confirmed outcome. The receipt and
vault-recovery paths publish durable history/plan clearance before refreshing
the balance display. If that display refresh fails, the result remains
`status: 'confirmed'` with `balanceRefreshPending: true`; ordinary status polling
recovers it without another transaction. Worker proof, indexer, note mismatch
and persistence failures before the commit still fail. This boundary must stay
inside the SDK; host UI must not guess confirmation from an existing balance.
Account and welcome surfaces preserve the SDK's refresh-pending outcome: they
show confirmed deposit / refreshing balance, without claiming ready-to-chat or
formatting a missing projection as zero. Their transient UI guard suppresses
new funding/quote controls and clears only when the exact confirmed note ID
arrives from the SDK. Wallet persistence and eligibility remain SDK-owned.
