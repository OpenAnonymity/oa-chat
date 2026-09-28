# Address-funding staging deployments — 2026-09-22

The user selected the currently pinned zkAPI servers. Both deployments are
READY in Vercel team `oas-projects-cbf58581`, in separate projects. Their Vercel
target is `production` to provide stable project aliases; the frontend uses the
staging OA organization.

| Network | URL | Deployment | Build |
| --- | --- | --- | --- |
| Sepolia | https://oa-wallet-sepolia.vercel.app | `dpl_4L9iW6ZBqTBSsqYiGkruurzfPAv7` | `AWPHXDJ5` |
| Mainnet | https://oa-wallet-mainnet.vercel.app | `dpl_vtWtLfC6e4KZeGAqytRbkXV76KaA` | `NVSQQZXU` |

Both artifacts were built from this task's working tree, based on OA Chat
`f44a195d8f222ba98ab2a828024ec759d1db9e7e`, including its uncommitted address
funding changes. They pin SDK `08c7666e949169b87de8b5ebaacbe106d7432b0e` and
contain a public `build.json` with every emitted asset hash. They were published
with the Vercel Build Output API and `vercel deploy --prebuilt --prod`, after
the local tests, build checks, and independent reviews passed.

## Service configuration

- `/auth`, `/api`, and `/chat` rewrite to
  `https://org-staging.openanonymity.ai`.
- The WebAuthn relay setting is
  `https://staging.openanonymity.ai/passkey-relay.html`.
- The verifier is `https://verifier2.openanonymity.ai`; verifier bypass is off.
- Sepolia `/zkapi-deployment` rewrites to
  `https://d33l4w2z2nh4cg.cloudfront.net`, chain `11155111`, vault
  `0x590Df9aBBfB21074016dAA486c771AE0aF729ee2`.
- Mainnet `/zkapi-deployment` rewrites to
  `https://d27v1dvkaxfc09.cloudfront.net`, chain `1`, vault
  `0xef88012d1A7F9d44e5f5afB8bC5e611Dc3283709`.

Choosing a staging frontend organization does not reconfigure the zkAPI
servers' issuer. Those existing servers were last documented as using
production OA issuance; their current public manifests expose the `oa_org`
source type but not its URL. The user's choice retains these existing servers.
The newer note-bound Sepolia deployment is not used. It requires compatible
SDK, circuit and proving artifacts, not a rewrite change alone.

No existing OA project/domain or backend configuration was changed. Account
signup/OAuth/passkey flows on the new aliases are not verified and may require
staging-org allowed-origin/RP configuration; the wallet test is accountless.

## Verification

- 886 core and 352 payment tests passed locally, including 60 address-funding
  tests and a real Anvil contract call/recovery/ETH-return test.
- Independent deployment verification matched all 486 published SHA-256 asset
  hashes per network, including WASM and proving keys, against each build.
- The live manifests matched every pinned deployment, chain, contract, token,
  signing key and proof hash. Both proxied health endpoints returned `ok`.
- Staging ticket-issuer/model endpoints matched the staging org's direct
  responses; model catalog and configured security headers passed.
- Vercel runtime warning/error and HTTP 5xx scans were empty at verification.
- Mainnet desktop and 390px mobile smoke tests passed with both wallet choices,
  no extension, no horizontal overflow and no uncaught page errors. No Mainnet
  key or transaction was created.
- Sepolia browser checks created and downloaded an encrypted funding backup,
  preserved the address/method through reload, required unlocking, and verified
  the zero-balance waiting state, copying the address during that wait, and
  stopping the wait without reporting a failed or submitted transaction.
- An independent fresh browser rejected a wrong backup password, restored the
  same address with the correct password, and required unlocking again after
  reload. Neither browser had an injected wallet or uncaught page errors.

Live Sepolia testing resumed after the user funded the browser address
`0x6562ea5f5624599d16271deb5d724777e87b9927` with 0.0825 test ETH.
Minting 5,000,000 ZKAPI base units and approving exactly that amount both passed
independent canonical receipt verification. The deposit transaction is
`0x7f153f674f329bfd35a562091de6decbdc02b0c339d3b0049ea5b863a9d79426`.
The original fixed-price deposit remained below Sepolia's base fee, then its
proof became stale when the vault root changed. Read-only simulation confirmed
`stale_root`. Test cleanup canceled that obsolete nonce with a zero-value
self-transfer, preserving all tokens and browser recovery state:
`0xfd148f2b91e8a8e18d8158834d23fda8c2d5e46277bf4879755544d6359ac67c`,
block 11,762,471, gas 21,000, fee 0.000046054596567 Sepolia ETH. This one-time
cleanup used the dedicated encrypted test backup outside the app; it is not an
app speedup feature. Independent verification confirmed unchanged 5,000,000
base-unit token balance/allowance, empty note 59, nonce 3 and no original receipt.

Finalized block 11,762,500 proved nonce consumption and an empty note slot.
The app automatically offered Resume deposit, refreshed the proof, and sent a
new EIP-1559 transaction. The clean retest passed through canonical receipts:

| Step | Result | Transaction |
| --- | --- | --- |
| Deposit | Note 59, 5,000,000 base units, block 11,762,569 | `0xf3a41c990f742e3e30171c5d08e2a7d7b92814b26831b7ec63772c54b649b781` |
| Chat | GPT-4o-mini replied “Sepolia wallet is OK!” through the enabled network proxy | No on-chain transaction |
| Settle and withdraw | 4,992,567 base units to `0x5f8bd2ef77f58601a700af3deb7c2aaa0a3ebbda`; 7,433 to the verified vault treasury; note closed | `0xb12d424a9dd182f083f25e1af84f37735e0d9f523085503376797be762882957` |
| Return public ETH | 0.067381041019169955 ETH to the same test recipient | `0x2fdb476139e7bd87401bb2d78082beff4aff47139a4784472369bc5711e067a5` |

The deposit and withdrawal used 6,753,103 and 7,057,861 gas respectively.
The public ETH transfer exactly equals its starting balance minus the single
signed maximum-fee reserve; actual gas used was 21,000. Its unused reserve left
0.00002417436714 ETH in the funding address. No public tokens remain there.
All five million deposited base units reconcile to the recipient and treasury.
The SDK has no active private state, pending deposit, prepared withdrawal or
active lease after withdrawal. Finalized block 11,762,594 confirmed the closed note and both payouts.
The SDK withdrawal phase is `closed`, and Check saved transaction cleared the
public ETH journal. No pending deposit, withdrawal, active lease or funding
transaction remains. Reload preserved chat/history, locked the funding address, and allowed
password recovery of the mixed legacy/type-2 transaction journal.

New address transactions use capped EIP-1559 fee headroom; legacy journals
remain recoverable. The pricing change passed 60 focused tests, the full suite
(886 core / 352 payment), and fresh adversarial review. Finalized closure and public-transfer journal cleanup both passed. The full
0.0825 ETH received reconciles to 0.015094784613690045 in network fees,
0.067381041019169955 returned, and 0.00002417436714 unused fee reserve.
The encrypted funding backup was refreshed after finalization; the test browser
profile and public verification evidence are retained. No Mainnet transaction
was performed.

The pending-transaction path exposed a CSS bug: wallet button display rules
made hidden MetaMask replacement actions visible in address mode. Explicit
hidden selectors now suppress those actions. Independent Chromium verification
and adversarial review passed, and both deployments above include the fix.

Local evidence and resumable test-state metadata are under
`/tmp/oa-address-deploy-20260922/`: `published-integrity.json`,
`published-route-checks.json`, `runtime-*.jsonl`, and `task-state.json`.
The test profile and encrypted recovery backup are preserved durably under
`/Users/mingyech/.codex/deployments/oa-wallet-funding-20260922/e2e/`, with a
restricted copy of `task-state.json` beside that directory. The temporary
evidence directory links to it. Credentials must not appear in reports or logs.
