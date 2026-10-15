# Browser payment recovery review (2026-09-29)

This review covers MetaMask deposits, Send Ethereum deposits, private-balance
withdrawals and the address account's separate Return leftover ETH action. It
focuses on losing the page during an asynchronous operation and returning in
this tab or a new tab. Private-note/transaction journals remain SDK-owned (the
two narrow host writes to the wallet slot are recorded under
[Boot-time draft discard](#boot-time-draft-discard-2026-10-10) and
[Confirmed give-up](#confirmed-give-up-of-a-zero-or-dust-balance-2026-10-13));
account sign-in and account sync do not recover browser wallet custody.

## Recovery boundaries

| Interruption | Persisted authority and recovery |
| --- | --- |
| Before sending ETH to the browser address | The same encrypted address account and exact ETH deposit intent reload. Balance and fee polling restart. An expired quote must be refreshed before Deposit; a display snapshot never authorizes signing. |
| After incoming ETH, before Deposit | Incoming ETH remains at the public address. Reopening checks it, and Deposit remains an explicit action. The user can instead explicitly return public ETH. |
| MetaMask prompt open, no returned hash | The saved submission claim blocks a new deposit. Check payment status reconciles the chain; prompt recovery and any retry require explicit actions. A canceled retry must preserve unresolved earlier submissions and the same private-note commitment. |
| Replacement prompt closed or page reloaded | Recovering the prompt releases only that exact replacement claim. The original transaction hash and nonce remain saved; subsequent replacement uses that same nonce. |
| Locally signed transaction, broadcast response lost | Encrypted signed bytes commit before broadcast. Check saved transaction reconciles or rebroadcasts those identical bytes. Loading the wallet never signs or broadcasts. |
| Receipt missing or indexer behind | Keep the original deposit and report pending recovery. A delayed RPC/indexer response cannot authorize a new private note. |
| Deposit confirmed, display cleanup fails | SDK confirmation stays successful. Optional host intent cleanup cannot report a failed payment or erase a newer draft from another tab. |
| Withdrawal clearance/proof interrupted | The saved `reserving`/prepared withdrawal and its destination reopen in Withdraw. A safe, never-submitted mutual withdrawal can explicitly switch to escape recovery when the service is unavailable. |
| Withdrawal submitted, receipt/finality pending | Saved claims/hashes/destinations control recovery. Active withdrawals reopen in Withdraw; unfinished background submissions/finalizations reopen Payment history. Long escape waiting windows stay quiet unless there is an unresolved submission. |
| Public ETH return completes while the page is closed | Check saved transaction verifies the canonical finalized receipt and atomically retains its confirmed/reverted outcome while releasing the pending slot. Return leftover ETH shows that outcome after reload. A later balance-refresh failure does not change it. |
| A balance is empty or a few cents on a version that no longer takes deposits | The note pins the wallet to that version, and an Ethereum withdrawal can cost more than it returns. After an explicit, confirmed action the host retires it through the SDK's own archive transaction under the wallet lock; the note stays in the SDK's `archives` store and a tested support procedure restores it. See [Confirmed give-up](#confirmed-give-up-of-a-zero-or-dust-balance-2026-10-13). |
| A prepared withdrawal is replaced in another tab after the person saw it | The withdrawal starts only after the host re-verifies the note and, when known, the prepared operation under the wallet lock, after settlement and the wallet connection. The SDK half belongs to its own recovery patch; what is left without it is stated under [Withdrawal recheck](#withdrawal-recheck-and-its-residual-window-2026-10-13). |
| An escape's payout was only credited by the payment contract | The saved record keeps `payoutCredited` and the credit's evidence; the balance stays "held", reopens in Payment history after a reload and is delivered only by an explicit **Claim payout** that needs no operator and no service check. A record is verified only by a proven claim. |
| A deposit quote or never-sent plan is left by a version that has since closed deposits | The draft pins the wallet to that version. At boot, and on watcher retries, the host clears only a provable draft or unsent plan under the wallet lock and decides again; otherwise the closed version offers **Cancel unfinished deposit**, then Reload. A claimed, started or ambiguous deposit is never discarded and stays completable. See [Boot-time draft discard](#boot-time-draft-discard-2026-10-10). |

Open-dialog sessionStorage is presentation only. It can restore the amount
input, disclosures and scroll, but cannot override signed transaction state.
A stale Welcome marker must not hide a withdrawal started in another tab.
Missing/restricted sessionStorage still permits recovery from the durable
wallet records. Closing a dialog is distinct from canceling a submitted payment.

## Repairs

- Restore reserved withdrawals, unknown background outcomes, unresolved submission
  claims and cancelable background preparation after a fresh-tab startup. Clear
  stale onboarding intent when it would otherwise hide withdrawal recovery.
- Keep uncertain MetaMask deposit retries bound to the original operation after
  rejection. The compatibility repair also prevents legacy prepared records with
  unresolved earlier submissions from being rebased to a different note.
- Recover an interrupted MetaMask replacement prompt without losing its original
  transaction hash or leaving an unreleasable replacement claim.
- Provide an explicit escape choice for a mutual withdrawal that has not entered
  submission. The local journal, not UI labels, determines eligibility. Preserve
  the exact destination and require a separate submission action.
- Bind a withdrawal click to its selected mode and note. Recheck the note under
  the SDK wallet lock before clearance reservation, including after pending
  recovery. A balance changed in another tab cannot inherit a delayed wallet
  connection or settlement callback.
- Revalidate the exact recovery operation, destination and clean submission
  history inside SDK preparation. A separate UI check cannot protect the gap
  while settlement or a wallet connection is awaited. Canceling an escape retry
  must also retain any earlier ambiguous submission and its recovery evidence.
- Preserve withdrawal submission history when a changed chain root requires a
  new proof, including the intermediate reservation saved before clearance.
  Rebuilding proof inputs must not make an uncertain prior transaction appear
  never submitted. Old proofs/public inputs are excluded from that intermediate
  record; the final record uses only the newly generated proof.
- Treat clearing the address amount preference as optional post-confirmation
  cleanup. Compare-and-swap preserves a newer draft and stopped quote polling
  cannot resurrect stale readiness.
- Retain verified public return outcomes in the encrypted transaction journal,
  distinguish reverts from success, disable another return while one is pending,
  and keep submitted/confirmed results when a balance refresh fails.

## Boot-time draft discard (2026-10-10)

Protocol versions share one wallet slot ([ZKAPI_VERSIONING.md](ZKAPI_VERSIONING.md)).
The SDK counts a deposit quote draft or a prepared deposit plan as wallet state
(`reload()` refuses a slot another deployment holds once it has durable state,
and `depositQuote` and `pendingDeposit` are part of it), so a draft left by a
version that has since closed deposits would pin the person to that version: no
other SDK build will load over it, the closed version refuses new deposits, and
the SDK has no public discard. The host therefore writes the slot, without a
person's gesture, in exactly one place, `discardDepositDraft` in
[`walletHoldings.mjs`](../chat/zkapi/versioning/walletHoldings.mjs). The other
host write is the user-confirmed give-up of a zero or dust balance
([below](#confirmed-give-up-of-a-zero-or-dust-balance-2026-10-13)), which goes
through the SDK's own archive transaction. Everything else the host does to the
wallet database is a read: the holdings probe and the other versions'
payment-history reader open it
without a version (an upgrade is never requested, and a database that does not
exist is not created), uses one readonly transaction and closes its connection.
The SDK's own snapshot read cannot do that job: `readBrowserWalletSnapshot` opens
a readwrite transaction and may write migrated deposit-history rows.

**What it clears.** Only a slot holding nothing but a quote draft (`draft_only`)
or a prepared plan that was never sent, with at most a draft beside it
(`unsent_prepared`). A note, journal, lease, exit lock, prepared withdrawal,
unfinished late attempt, started or ambiguous deposit, or any slot field the
host does not know is refused. It is attempted only when the slot owner is a
live version other than the deposit target, never for the target's own draft,
a retired or unknown owner, or a note.

**Unsent-plan predicate.** `isUnsentPreparedDeposit`
([`unsentDeposit.mjs`](../chat/zkapi/versioning/unsentDeposit.mjs)) is the rule
`canceledDeposit.mjs` applies to release a rejected plan, kept as one shared
definition for both callers:

- the slot has no note (`state`);
- the plan has a non-empty `operationId`, equal to the expected one when the
  caller gives it, and `phase` is `prepared` with no `legacyRecovery`;
- none of `submissionId`, `submissionOwner`, `submissionFrom`, `submissionNonce`,
  `transactionHash`, `transactionHashes`, `transactionAttempts`,
  `ambiguousSubmissions` or `approvals` is set;
- `lateDepositAttempts` is absent or an array with no entry for the same
  operation. A malformed container or entry means "do not release".

The host is stricter than the predicate. The plan may have nothing set beyond
the nine fields `prepareDeposit` writes (`operationId`, `createdAt`, `phase`,
`amount`, `secret`, `commitment`, `next_note_id`, `active_root`, `zero_path`);
the slot must be `version === 1` with a string `deploymentId` and no key outside
the known slot-field set. `walletHoldings.mjs` keeps that list
(`knownSlotKeys()`), and a field a future SDK adds is treated as held state until
it is classified.

**Order of operations.**

1. Request the lock `zkapi-wallet:active-runtime` exclusively with
   `{ifAvailable: true}`. It is the name `withBrowserWalletLock` uses for every
   SDK mutation. Without `navigator.locks` the host refuses (`no_locks`): the
   SDK's fallback is a promise chain private to one tab and gives no cross-tab
   exclusion. A busy lock is refused (`lock_busy`) without waiting, so the host
   never queues behind an SDK mutation.
2. In one readwrite IndexedDB transaction, re-read the slot, re-verify kind,
   owner (`expectedDeploymentId`) and version, then put the slot with
   `depositQuote: null` and, for an unsent plan, `pendingDeposit: null`. Every
   other field and its position is carried over as read, and `updatedAt` becomes
   `max(now, previous + 1)`. The decision comes from this read, never from the
   earlier probe.
3. After the commit, post `{updatedAt}` on the `zkapi-wallet:active-runtime`
   BroadcastChannel so other tabs re-read, then decide again on a fresh probe.

**Why a started deposit cannot be discarded.** Checked against the installed
SDK `3342c95` with the `wallet-recovery-v1` patch; line numbers are as installed.

- A deposit reaches a wallet prompt or a signer only after its submission claim
  is durable. `ZkapiClient.deposit` calls
  `browserWalletRuntime.claimPendingDepositSubmission(plan.operationId)`
  (`zkapiClient.js:2136`). Under `withBrowserWalletLock` that method re-reads the
  slot and commits `phase: 'awaiting_wallet'`, `submissionId` and
  `submissionOwner` (`browserWalletRuntime.js:1058-1126`). Only then does
  `sendContractTransaction` issue `eth_sendTransaction` (`zkapiClient.js:1472`),
  whether the provider is MetaMask or the Send Ethereum signer. A plan that
  satisfies the predicate therefore never had a prompt and has no transaction,
  and its note secret never left the browser.
- The claim and the discard take the same exclusive lock, so they are ordered.
  Claim first: the discard's in-transaction read sees the claim fields, the slot
  reads as `pending_deposit` and nothing is written (test: "discard re-verifies
  under the lock: a claim made while waiting wins"). Discard first: the stale
  tab's claim re-reads under the lock, finds no `pendingDeposit` and throws "The
  durable pending deposit is missing." (`browserWalletRuntime.js:1063`); nothing
  is signed or sent. Lock held by anything else: refused, retried later.
- Every SDK mutation re-reads before it writes. `writeBrowserWallet` is an
  unconditional full-slot `put` with no compare-and-swap
  (`browserWalletStore.js:309-325`), so a stale in-memory snapshot is harmless
  only because each `commit` runs inside `withBrowserWalletLock` after
  `reload()`. A structural scan of every `this.commit(` in
  `browserWalletRuntime.js` found each in a method that takes the lock and calls
  `reload()`, except four internal helpers (`prepareLeaseRequest`,
  `installRecoveredResponse`, `recoverUnacceptedNativeQuote`,
  `recoverPendingLocked`) that are called only from lock-holding bodies
  (`issueLease`, the `retireWithinLock` closure, `init`, `recoverPending`,
  `prepareWithdrawal`). Channel notifications queue their `reload()` behind the
  lock for the same reason (see `init`). A tab on pre-rollout code, which uses
  the same lock and database, therefore re-reads the discard before it can
  commit.

**What the argument relies on.** Web Locks and the shared lock literal, which the
build asserts in every live store; the SDK's lock-then-reload discipline above,
which is a property of each SDK revision, so the activation runbook repeats this
check for a new store and runtime (the field-set drift guard in
`zkapi-wallet-holdings.test.mjs` covers slot fields, not commit discipline); and
the claim-before-prompt order, which holds for both funding paths because both
reach `sendContractTransaction`.

**Ping-pong and the loop guard.** A pre-rollout tab with the Send Ethereum
screen open re-creates a draft every five seconds, itself under the lock. A
sessionStorage log, `oa-zkapi-version-switch-log` (separate from the one-shot
switch hint, so consuming a hint never resets it), allows two discards in a
60-second window. The boot path asks `canDiscard()` first and calls
`noteDiscard()` only after a discard happened, so a refused, lock-busy or
nothing-to-clear attempt is not charged; the watcher charges a pinned draft
once before its first attempt and retries a busy lock every ten seconds, at most
six times. The third discard in a window is refused and the page says "Close
other open tabs of this app, then reload." If the log cannot be read the discard
is not allowed.

**Lost race.** When another tab won (`lock_busy` or `not_discardable`),
`selectZkapiVersion` re-probes once and decides on what is there, with
`draftDiscarded` false. `draftDiscarded` is true only when this call cleared the
draft and a second read shows the slot is not pinned again by a clearable draft
on a non-target version, so the notice "Cleared an unused deposit quote. Nothing
was spent." is never shown over a draft that came back.

**Fallback.** When the boot discard was refused (busy lock, loop guard, no Web
Locks) the closed version shows **Cancel unfinished deposit**. It runs
`discardUnsentDeposit` in
[`canceledDeposit.mjs`](../chat/zkapi/services/canceledDeposit.mjs): the SDK's
own `runtime.commit` under `withBrowserWalletLock` after `runtime.reload()`, with
the same classification, then offers Reload. A started, ambiguous or claimed
deposit never gets this action; it stays resumable and checkable.

**Evidence and limits.** Tests: the discard preconditions, lock `ifAvailable`,
no-locks refusal, claim-while-waiting, byte-identical other fields, channel post
after commit, the field-set drift guard and parity of the shared predicate with a
verbatim copy of the original `canceledDeposit.mjs` rule in
`test/zkapi/zkapi-wallet-holdings.test.mjs`; the lost-race re-read, three
concurrent tabs and charge ordering in `zkapi-version-loader.test.mjs`;
`canDiscard`/`noteDiscard` in `zkapi-switch-protocol.test.mjs`; the fallback in
`zkapi-discard-unsent.test.mjs`; the unchanged `canceled-deposit.test.mjs`.
Web Locks, IndexedDB transaction ordering and the versionless-open abort were
exercised only over a spec-faithful fake (`test/zkapi/_fakeIndexedDb.mjs`) and
bundled code in Node, not in a real browser. Storage that is readable but not
writable lets the boot discard run uncharged; it is still bounded to one attempt
per page load and re-verified under the lock.

## Confirmed give-up of a zero or dust balance (2026-10-13)

The loader gives the owner of the runtime slot priority, the deposit target
cannot take a non-empty slot and deposits are closed on an exit-only version.
A holder of an empty or very small note there is therefore pinned to it: an
Ethereum withdrawal can cost more than it returns, and waiting for expiry and
the treasury's claim can take up to the note's lifetime. `giveUpBalance` in
[`abandonedNote.mjs`](../chat/zkapi/services/abandonedNote.mjs) retires such a
note on an explicit, confirmed action. It is never automatic and never runs at
boot.

**Eligibility.** All of it is decided inside the lock on a fresh read
(`abandonVerdict` in
[`abandonNote.mjs`](../chat/zkapi/versioning/abandonNote.mjs)); the page's
display verdict only decides whether to show the action.

- The loaded version is `exit-only` and a deposit target exists; its protocol
  family opted in (`adapter.abandon.supported`, true for `note-bound-v1`, false
  for `concession-v1` until that family has its own recovery review: its
  store's archive also supersedes the note's request-journal archives and drops
  the exit lock, billing asset, state sequence and exit-kit mark, none of which
  the verdict has been reviewed against) and the registry row has not set
  `transition.abandonEnabled` to `false`. Both must be exactly true, and the
  service enforces them itself.
- The note is exactly the one shown (note number and exact balance); the slot
  holds that note and nothing else: its keys are `state` plus known metadata.
  A journal, a lease, the tab's own unsettled chat key, a prepared withdrawal,
  a pending deposit or quote, an exit lock, an unfinished late attempt, an
  unresolved request, a non-empty request archive, any key this build has never
  heard of or a malformed state refuses. So does any withdrawal record of any
  deployment of this wallet that is not closed (a record naming no deployment
  counts as this one), a confirmed treasury claim for the note and a client
  fact that cannot be read.
- The balance is zero, or dust: below `min(ceiling, max(request charge cap,
  the smallest chat key at the current quote))`, with an absolute ceiling of
  5,000,000 gwei (0.005 ETH) that does not depend on the quote. A missing,
  expired or future-dated quote is never used and a balance at or above the cap
  without one is "price unknown", never guessed.

**Order of operations.**

1. `runtime.init()` before the host's lock. Initialization takes the wallet
   lock itself and Web Locks are not re-entrant, so awaiting it inside the lock
   cannot finish.
2. Without `navigator.locks`, refuse (`no_locks`). Request
   `zkapi-wallet:active-runtime` exclusively with `{ifAvailable: true}`; a busy
   lock is refused without waiting.
3. Inside the lock: `runtime.reload()`, the client's facts, the store's request
   archive (when the SDK has one) and every withdrawal record unfiltered, then
   the verdict.
4. `archiveBrowserWallet('abandoned', noteId)`: one IndexedDB transaction, owned
   by the SDK, over the slot, the archives and the deposit history. It compares
   the note id again inside the transaction. The `archives` record carries the
   whole note state, secret included, with its deployment id; the deposit row
   stays.
5. Still inside the same lock callback, `runtime.reload()` and
   `runtime.notify()`, because the SDK forbids an unlocked reload.

**Why the archive loses nothing the verdict did not already refuse.** For every
reason except `expiry-claimed` the SDK's archive drops `journal`, `lease`,
`preparedWithdrawal`, `pendingDeposit`, `depositQuote` and `exitLock` from the
slot (and, in the successor store, `billingAsset`, `stateSeq` and
`exitKitExportedSeq`), and keeps unfinished late attempts. A drift test runs
over every installed SDK alias: after an archive of a slot with every field
set, the slot reads `empty`, every dropped field is one the verdict refuses on,
and every unfinished late attempt survives (so the verdict refuses it).
`runtime.archiveNote` is not used (it takes the lock itself, so it deadlocks
inside the host's lock and leaves a gap outside it), nor
`runtime.commit({state: null})` (it would destroy the secret), nor parking the
note (an irreversible clearance and an open record that keeps the version
gated), nor a host write to IndexedDB (a second author of the SDK's schema).

**Restore (support only, no in-app undo).** The `archives` record keeps the
note, so a given-up balance can be put back. The procedure is executed by
`test/zkapi/zkapi-abandon-note.test.mjs` ("support restore") against the real
store, so it is a tested sequence and not a description:

1. In the wallet database `zkapi-browser-wallet-<lineage>-<network>-v1`, find
   the record of its `archives` store whose `reason` is `abandoned` and whose
   `state.note_id` is the person's note (its `archiveId` is
   `<deploymentId>:<noteId>:<milliseconds>`). Take its `deploymentId` and
   `state`.
2. Under the wallet lock (`zkapi-wallet:active-runtime`, exclusive) reload the
   runtime and require that the slot is empty. Never restore over a slot that
   holds anything.
3. Commit the slot with that `deploymentId` and `state` and nothing else
   changed, through the SDK's own write (`writeBrowserWallet`).
4. Reload under the lock. The slot reads as a note again: the same note,
   secret and balance, and the host's holdings probe reports it as the
   exit-only version's own balance.

**Evidence and limits.** The service's tests cover no locks, a busy lock,
`init` that blocks on the lock (the order), a lease committed between display
and click that leaves the slot untouched, one commit over slot, archives and
deposits with the channel post after it, the note-id guard against a
non-locking writer, an unreadable client fact, request archive or withdrawal
list, and the restore above, against the installed legacy store and, when a
successor SDK is present, the real `0.2.0` store. The verdict's own tests fuzz
the dust arithmetic against the SDK's price functions. Web Locks and
transaction ordering are exercised over a spec-faithful fake and bundled code
in Node, not in a real browser. A tab on pre-rollout JavaScript has no verdict
and can re-pin the slot afterward. A tab's own unsettled key reads `in_flight`
until the SDK's settle timer fires; the service does not settle it.

## Withdrawal recheck and its residual window (2026-10-13)

The repairs above that revalidate the exact operation "inside SDK preparation"
are the legacy SDK's `wallet-recovery-v1` patch. The successor SDK (`0.2.0`)
drops the `expectedWithdrawalOperationId` option silently and its
`prepareWithdrawal` takes no expected note or operation, so for a family that
lists `withdrawal-operation-recheck` the host adds a recheck of its own and the
SDK half has to come from a patch for that revision.

**Host half** (on only where the loaded family lists the behavior; a legacy or
dormant withdrawal asks nothing more than it ever did). Order in
`AccountModal.submitWithdrawal`: the strict check of a chosen escape intent
(unchanged) → settlement → the existing client note-id guard →
`connectWallet()` → `assertWithdrawalEscapeAvailable({kind: 'note', noteId,
operationId})` → the settlement-time and figure last look → the SDK's
`withdraw()`. The recheck awaits `runtime.init()` BEFORE the lock, pre-empts
this tab's startup recovery and any key still being issued
(`preemptForExit`, where the runtime has it), then under the wallet lock and a
fresh `reload()` requires that the slot's note, the client's note and the
chosen note are one note and, when an operation is named, that the prepared
withdrawal is that operation (any mode and phase). The Send Ethereum signer
binds the operation id to its recovery context.

**What is left.** After the host's check the SDK still reads
`assertBalanceNotClaimed` (an RPC), asks the wallet to connect (which can show
a prompt), for an escape checks the destination (an RPC) and only then takes its
own lock in `prepareWithdrawal`. The window in which a replaced prepared
withdrawal could still reach the SDK is therefore that network latency plus any
prompt, not milliseconds. Without the SDK half it is open; with a patch for the
revision (the `wallet-recovery-v2c` hunks: expected note and operation
compared inside the SDK's lock before the existing validation, and the claim of
a prepared submission compared on `{operationId, noteId, destination}` and
`mode` after the mutual-to-escape conversion) it is closed.

**How it is enforced.** `PATCH_COVERAGE` names the patch that provides the SDK
half, and the registry CLI check and the build refuse a live row of the family
without a covering patch for the row's own revision
(`recovery_patch_coverage`). The real-SDK rehearsal
(`wiring:withdrawal-operation-recheck the SDK refuses to prepare or claim a
withdrawal replaced after it was displayed`) replaces the plan between display
and `withdraw()` and fails against a revision that does not refuse it: that is
the evidence a patch must turn green. Until then the successor row stays
`pending`.

**Rollback hazard.** A journal entry the signer wrote under the mutual-to-escape
conversion rule records the mode actually signed and the exact amount, so a
build that only knows "the mode authorized is the mode signed and the
concession is the amount authorized" reads it unchanged. Authorizations the
signer itself did not accept are never inferred from the SDK's saved plan.

## Limits

Same-origin code remains inside the local address account's custody boundary.
Clearing browser data, changing origins or losing the browser profile loses its
signing key and independent SDK private-note state. A page reload does not cause
that loss. OA account sign-in cannot restore this wallet.

A signed address transaction uses its original fee and nonce. Recovery can replay
its original bytes; it does not increase the approved fee, replace or cancel it.
If network fees remain above its cap, confirmation can require waiting for fees
to fall. Other sends from that address stay blocked while its saved transaction
is unresolved. Adding fee replacement requires a separate reviewed signing and
SDK reconciliation design; this review retains that restriction.

A transient SDK initialization failure may require reloading after the service
recovers because this SDK caches its initialization promise. This review does
not redesign SDK initialization or its worker lifecycle. Network availability,
canonical finality, contract challenge periods and on-chain expiry still govern
when recovery can complete.

The exits and recoveries reviewed here assume the vault's proof setup is sound.
On a version 2 vault whose keys are the single-party `dev` setup, whoever holds
that setup's toxic waste can forge proofs, including defeat evidence against an
honest escape, so on such a vault the protection of an honest exit depends on
that party not forging ([ZKAPI_VERSIONING.md](ZKAPI_VERSIONING.md#single-party-development-proof-setup-known-limitation)).
This review does not change that.

Funding scopes follow vaults. A browser address holds ETH for one vault only, so
after a version change the previous scope's leftover ETH is reachable only
through the sweep-only rescue in [ZKAPI_PAYMENTS.md](ZKAPI_PAYMENTS.md#funding-scope-per-vault).
A non-sweep transaction another version left saved is released there only when
the network has settled it for good; a transaction the network never saw and no
nonce displaced stays blocked until the build that started it can rebroadcast
it, so a retired version in exactly that state has no automatic release.

Validation details are recorded in the accompanying APP_STATE entry
([2026-09-29 recovery audit](APP_STATE.md#2026-09-29-browser-funding-and-withdrawal-recovery-audit) and, for the version-closed draft
discard, the give-up and the recheck above, [Multi-version zkAPI support](APP_STATE.md#2026-10-10-multi-version-zkapi-support-dormant-until-activation) and [its 2026-10-13 follow-up](APP_STATE.md#2026-10-13-version-2-protocol-wiring-history-and-give-up-still-dormant)).
Tests use controlled journals/providers and local EVM transactions; no user
funds, live wallet approvals or new public-chain transfers are authorized by
this review.
