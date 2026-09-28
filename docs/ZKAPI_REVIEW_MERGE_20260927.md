# zkAPI review merge, 2026-09-27

This records acceptance against Rasul's 22 September review. The review describes
protocol `b542b1b` and integration `b188ab3`; it is not a comprehensive audit.

## Source and merge decisions

Incoming branch `OpenAnonymity/zkapi:codex/zkapi-review-fixes-sepolia` is pinned to
`2eda8f387be4fe043d833ac6b8ffff2eee176dd1`. It is merged into the native ETH
SDK/backend branch, whose first parent is `6f12f3b520989d24c50fbeee33b4c42b761d5651`.
Merged commit: `2e9647cecec78e1258b34f8be1bc85ea2378cd66`, pushed to
`OpenAnonymity/zkapi:codex/native-eth-wallet`. The OA app consumes this exact
revision through both package files, using the repository's current canonical name.

The native branch already contained the note-binding circuit, historical-root
contract fix, and durable v2 challenge service. We retain protocol
`8b2d4e3da921f956e1eb6b93afbf722a877c060c`: its circuit, setup, WASM and challenge
repair match the incoming `49164f6` protocol tree; only native ETH contract support
and its tests differ. Existing Sepolia vault, keys, browser storage, native gwei
billing, fee estimates and instant USD/ETH switching remain compatible. No new
setup or contract migration is needed for this merge.

The incoming AWS Compose example and CLI acceptance helpers describe a separate
ERC20 review deployment. They must not overwrite the existing native launcher's
pricing configuration or be treated as acceptance of this hosted native app.

## Review acceptance matrix

| Finding | Merged behavior and evidence | Scope / remaining limits |
| --- | --- | --- |
| 1. Signed balance can be transplanted between notes | Hidden note binding is part of the signed commitment and request/withdrawal constraints. Real active-processor tests accept A's honest continuation and reject reuse on B for both equal and unequal deposits; honest withdrawal remains valid. | These targeted tests do not establish formal cryptographic soundness. The note-bound setup is still single-party development setup. |
| 2. Historical request root invalid after unrelated tree changes | Archived request proof keeps its original root; the restore path uses the current tree. Real Groth16 contract tests cover intervening deposit and close, tampered proof roots, and native payout behavior separately. | Contract tests cover the review's attack; this merge does not claim a new live native escape challenge. |
| 3. Challenge planner reads v1 instead of v2 | Planner consumes active-processor v2 evidence; durable daemon covers event discovery, simulation, submission, same-nonce restart and reorg behavior. Issued leases remain challengeable before final usage arrives. | Challenger operation and funded signer remain deployment requirements. New direct-key retirement states also preserve challenge evidence, with a regression added during merge. |
| Optional proxy duplicate upstream call | A per-nullifier execution lock and post-lock durable replay check produce one provider call for 16 concurrent real-proof retries across two processors sharing a store. | Coordination is within one shared store/process. Crash, canceled-request and multi-process ambiguity still require upstream idempotency. Native ETH rejects proxy mode. |
| Optional direct OpenRouter premature settlement | Durable disable → grace → usage capture → revoke phases; deletion/usage failures remain retryable across restart. No next-state signature until revocation succeeds. | Aggregate usage relies on an operational grace interval, not an authoritative signed final receipt. Native OA uses its separate signed-final-receipt path. |
| App 1. Excess wallet confirmations | Native ETH removes token mint/approval. Existing step UI explains the deposit; send-to-address has an explicit Next after funding. | User's external funding transfer remains separate. Full MetaMask extension acceptance on this merge is not claimed. |
| App 2. Deposit reported failed although it later appears | Saved, potentially submitted deposits report pending/recoverable status. Indexer lag no longer produces failed activity. Reverted receipts and mismatched notes still report errors. | The original untraced September 22 incident is not claimed as diagnosed. Exact durable confirmation now remains successful even if the later balance display refresh fails; pre-commit worker/indexer/storage errors still fail. |
| App 3. Public test-token mint confused with private balance | Native configuration disables the legacy demo-token action. Confirmed native deposits appear in persistent payment history. | Legacy ERC20 mint history is not redesigned. That action does not add private balance. |
| App 4. OA key issuance 503 | Prior native deployment fixed the station loopback/allowlist incident; exact saved issuance then completed a real response, signed settlement and refund. Recovery tests cover retryable 503 without losing the saved request. | Historical live evidence is in the native deployment doc. Public health reads alone do not prove current provider availability. |
| App 5. Google return origin rejected; account requirement unclear | Prior deployment added the canonical origins to staging CORS/OAuth return allowlists. Existing collapsed funding help now explicitly says account/Google login is optional. Anonymous protocol traffic remains credential-free and wallet state stays outside account sync. | Full Google login/passkey end-to-end acceptance remains outstanding. |
| App 6. Mainnet requires USDC | Native ETH code and Sepolia deployment are retained. | Native Mainnet remains guarded and unpublished pending separate deployment review. Existing ERC20 origin remains available for wallet recovery. |

## Verification

Fresh checks on the combined source (SDK/backend final diff independently
approved after fixing the launcher default and confirmation refresh boundary):

- Protocol Rust release workspace: 82 tests passed.
- Solidity protocol tests: 27 passed, including real historical-root challenges.
- Integration Rust release workspace: 141 tests passed, including sequential
  equal/unequal note transplantation, active v2 planner and durable challenge
  daemon, native billing/recovery, concurrent proxy and retirement failures.
- Shipped browser WASM generated two real proofs (request and escape withdrawal)
  accepted by native verification, with the expected circuit identifier.
- SDK tests: 305 passed, including receipt/recovery post-commit refresh failure
  and pre-commit worker, indexer, storage and unrelated-old-note rejection.
- Restricted challenge signer: 11 tests passed.
- AWS launcher: four no-network startup tests passed. Final review caught and
  repaired a missing proof-directory default in the merged launcher.
- Integration Rust formatting and Clippy passed; protocol Rust Clippy passed.
- Demo deployment script compiles with native and ERC20 configuration branches.
- SDK artifact hashes and Sepolia/Mainnet package builds pass. The Mainnet build
  retains its migration guard.

Browser verification of preview `N6UIYGQD` (before the final confirmed-balance
wording follow-up) passed native amount/USD display, collapsed account-optional
help, disabled unfunded Next and a 390px mobile layout. Six unit switches took
8.1–10.7 ms and retained the exact principal. No JavaScript page errors appeared;
an existing proxy connection failure/direct-fallback message was observed, so
this does not establish successful proxy routing. No identity login, inference,
funds transfer or contract transaction was performed for these merge checks.

Final app suite: **886 core + 514 payment tests = 1,400 passing**, zero
failures. Fresh independent reviews approved both the SDK/backend merge and
final host diff after the reported issues were fixed. The final host follow-up
also passed 115 focused checks of pending confirmation, exact-note display
recovery, Welcome-to-Account handoff, and suppression of a second funding prompt.
The canonical Sepolia publication identity is recorded below after deployment.

## Release boundaries

This source merge does not itself update a live daemon or establish a new hosted
provider/Google-login happy path. Keep source acceptance, published browser build,
and backend deployment identities separate. See
[native Sepolia deployment evidence](ZKAPI_NATIVE_ETH_DEPLOYMENT_20260927.md)
for prior live deposit/reload/inference/settlement/withdrawal, infrastructure and
allowlist evidence. No Mainnet readiness or independent security-audit approval
is implied by the passing regression suites.
