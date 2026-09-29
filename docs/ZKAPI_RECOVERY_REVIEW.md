# Browser payment recovery review (2026-09-29)

This review covers MetaMask deposits, Send Ethereum deposits, private-balance
withdrawals and the address account's separate Return leftover ETH action. It
focuses on losing the page during an asynchronous operation and returning in
this tab or a new tab. Private-note/transaction journals remain SDK-owned;
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

Validation details are recorded in the accompanying APP_STATE entry. Tests use
controlled journals/providers and local EVM transactions; no user funds, live
wallet approvals or new public-chain transfers are authorized by this review.
