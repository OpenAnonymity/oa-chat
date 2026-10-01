# Native ETH deployment work, 2026-09-27

Status: **Sepolia published; live deposit, recovery, chat and withdrawal passed**.
**Native ETH Mainnet is published; unfunded canonical browser checks passed.**
Finalized contracts, public backend and all published files have passed independent verification. Existing ERC20 browser
origins and services are preserved for matching wallet recovery.

## Mainnet preparation resumed, 2026-09-28

The user subsequently requested a Mainnet deployment, funded the two accounts,
and explicitly selected **enable public Mainnet deposits** after reviewing the
limitations. This supersedes the earlier deferral and pending activation choice.
The approved rollout is underway; do not request the same approval again.

Adapter creation at deployer nonce 0 was submitted as
`0xa0c3097513d8eaddb4e1c3ef2cadb23b69405289523c44b0015ff5a5cbf1c1c6`,
at `0x7C530D1eeab639FB78DAefCEdb4E0AA046727898`. It finalized in block
26074584, using 1,459,069 gas and costing 0.000235550335345579 ETH.
Vault creation at nonce 1 mined in block 26074671 as
`0x80a3bcd5303a841ebe8ce42661ce0ebb9eeaf19425acb8867d8dd164dd8cb1e7`,
at `0x9e5570ae0F1FCB087c2dD0eac521aC067a6b6F42`. Runtime and all
constructor getters match. Both receipts are finalized; the vault was
verified below finalized head 26074697.
It used 5,485,664 gas and cost 0.00083442018193536 ETH. Total actual
deployment fees are **0.001069970517280939 ETH**, leaving a verified
0.003930029482719061 ETH deployer balance and latest/pending nonce 2.
The combined signed maximum fee liability was 0.00207723344839807 ETH,
below the 0.005 ETH limit. No further deployment signing is planned.
The coordinated executor alone owns deployer nonces; never replace saved
signed bytes or use another nonce as a retry. Runtime and frontend publication are complete as described below.

The user subsequently sent **0.005 ETH to each prepared account**. At
07:37:28 UTC, block 26074503, latest balances were exactly 0.005 ETH for
deployer `0x5f8BD2eF77f58601a700af3deB7c2aaa0a3ebBDA` and challenger
`0x667F2BB2aC6f56516B2e064B8be91526E86A6fF3`. Both latest/pending nonces
were zero; finalized balances were still zero at finalized block 26074410.
These transfers were observed but not yet finalized at that check. The
deployment expected fee was about 0.001046 ETH and padded allowance about
0.002539 ETH. Refresh before signing and keep the challenger reserve separate.
Later finalized block 26074506 confirmed the deployer's 0.005 ETH balance and
nonce 0. This is recorded separately from adapter confirmation/finality.

Contract deployment preparation is independently reviewed. The protected
`mainnet-rollout-20260928/deploy-mainnet.mjs` helper has SHA-256
`21c720d1aee783cd685c37cbf671ad8a921ada00ffaa8a262ea515052166df41` and
its immutable public manifest has SHA-256
`39ad35ada347b4b7fb9b9588c241ca3bb8496392ab8a50a7227fdfe6648206a1`.
It checks exact release artifacts, constructors, fresh simulation/nonces and
balance, caps aggregate signed deployment fees at 0.005 ETH, durably saves and
revalidates exact signed bytes before broadcast, and records finalized evidence
separately. Both reviewed CREATE transactions and their durable signed journals are complete.
Never publish signed bytes or signing credentials, and do not replay completed
transactions. No further contract signing is part of this rollout.

### Live Mainnet backend and routing

The isolated native Mainnet runtime is installed and healthy. Server, indexer
and challenger use immutable image
`sha256:d833ea7c4e9246f0f521fe4832b01477f8490ed03b944a845b2baa681bca4859`,
backend source `2e9647cecec78e1258b34f8be1bc85ea2378cd66` and protocol
`8b2d4e3da921f956e1eb6b93afbf722a877c060c`. It has independent prepared
signing secrets and fresh data/checkpoint directories; no Sepolia state was copied.

The reviewed installer stopped before mutation on unordered Docker mount
metadata, then before startup when the disposable nginx validator ran as root
without CHOWN capability. Two narrow independently reviewed fixes canonicalize
mount ordering and run validation as the actual gateway user 101:101. All
substantive container/mount checks and isolation remain. Original journals and
installed bytes were preserved; subsequent install, validation and startup passed.
Final installer SHA-256 is
`9cde6ca9aa82300c372bf8fdf9cae69646da92e2897a0dde62ac4112bfb0db3f`; final
19-file bundle seal is
`d89b436e38cd90cee59c2c9eca7cd92808a6257829979c36da606168a3432aac`.

The challenger advanced to checkpoint 26074834 with zero pending obligations.
Its balance remained 0.005 ETH, above the sampled 10,000,000-gas liability of
0.00183578607 ETH. The private runtime's health, attestation, on-chain/indexer
root, native quote and proof hashes matched the finalized deployment.

CloudFront `E301WJL60HXXBI` is deployed with the reviewed Mainnet-only origin
change: HTTPS443 at `52.53.106.195.sslip.io`, `/mainnet` prefix, distinct origin
credential, disabled caching, forwarded queries and required protocol methods.
The additive TLS change intentionally recreated the shared TLS container while
preserving its certificates and the existing Sepolia route. Six negative-auth
checks rejected missing, incorrect and cross-network credentials with 403.

Independent public verification at **2026-09-28 08:49:18 UTC** confirmed the
manifest at `https://d3hmaz52qw22t.cloudfront.net/config.json` exactly matches the
reviewed deployment, passes actual SDK manifest/trust validation, and agrees with
health/attestation/tree state. The native quote was checked against the finalized
Mainnet Chainlink round. Private signer, environment and dashboard paths returned
404. No signing, user deposit or paid inference occurred in these checks.
At 08:50 UTC, native Sepolia and legacy Mainnet USDC public builds/configs were
byte-identical to their pre-rollout baseline and both backends remained healthy.

SDK Mainnet configuration and its guard removal passed independent review,
24 focused tests and artifact verification. Commit
`cf56d67e0c1dd4bc3f3c32392478ce242c746446` is pushed on
`codex/native-eth-review-integration-20260928` and pinned in both host package
files, with matching installed dependency resolution. Mainnet Vercel publication
and canonical unfunded browser verification are complete.
The existing legacy Mainnet recovery origin and native Sepolia application have
not been republished. Backend source provenance remains separate from the new
SDK configuration commit.

### Published Mainnet frontend

The OA Vercel project `oa-wallet-eth-mainnet` now serves
**https://oa-wallet-eth-mainnet.vercel.app**. Deployment
`dpl_EfvfCXhrcPYR5DVh8aQ8UCb5HXso` is READY, build `K2DVDIBU`, with app
`c81405722608a32f2883c115a8ed8e522e6ba12b` and immutable SDK
`cf56d67e0c1dd4bc3f3c32392478ce242c746446`. It uses the staging org through
same-origin routes, the new native Mainnet backend and the real pinned verifier.
The Mainnet migration guard is removed. This publication changes neither the
native Sepolia app nor the separate USDC Mainnet recovery app.

The complete app suite passed **1,400 tests**. Independent prepublication review
verified exact metadata, all 486 local file hashes and complete directory
coverage, OA project/routing, native Mainnet pins and absence of credential files.
Public verification at **08:58:52 UTC** then matched all 486 canonical file hashes
and build metadata. The real SDK validated the served manifest and trust pins;
health, attestation and indexer root agreed, and the native quote matched the
finalized ETH/USD oracle. Private routes remained 404. These are public/read-only
checks, not a paid Mainnet deposit/inference/withdrawal test.

Immediately before publication the Mainnet challenger checkpoint reached
26074894 with zero pending obligations, its full 0.005 ETH reserve and all five
services running. The sampled maximum 10M-gas fee liability had moved to
0.00253192496 ETH, illustrating why reserves require ongoing monitoring.
Canonical browser smoke passed without funding, signing, login or inference:

- MetaMask is first and Send to an address is second. The accountless flow shows
  Ethereum Mainnet, exact ETH and approximate USD totals, address/Copy, collapsed
  fee help and disabled Next while unfunded.
- Four USD/ETH switches took 9.3–15.5 ms, preserving 0.003783612 ETH principal
  and restoring the initial $10 input. Custom input 0.002345678 ETH survived
  page reload and a full browser close/reopen, including its ETH denomination
  and exact funding address. Read-only RPC balance and both nonces stayed zero.
- No visible alerts or uncaught JavaScript page errors were observed. Initial
  and final console samples were clean, but an intervening restart recorded
  two console errors and one warning without retained message text. The cause
  was not established by that sample. A bounded reopen/reload reproduced no
  console errors or uncaught page errors, but did reproduce the handled warning
  `Cannot disable proxy while requests are in progress` from existing proxy
  preference synchronization, caught in `chat/app.js`. Both loads still restored
  the exact custom amount, displayed a fresh quote, kept Next disabled and showed
  no alerts. The browser was closed. This does not establish the cause of the
  earlier two errors or verify proxy reliability; the observed warning is
  non-blocking for this unfunded funding/recovery acceptance.
- The screenshot was visually inspected and the browser closed. Its unfunded
  protected profile is retained for reproduction. Coverage excludes paid
  Mainnet deposit/inference/withdrawal, MetaMask extension confirmations,
  Google login and the outstanding live escape-challenge acceptance.

Public browser evidence and screenshot are retained in the protected rollout's
`browser-smoke-20260928` directory. The immutable deployed source revisions
above remain the publication identity; later documentation commits do not
change the deployed app or SDK.

The original **0.03 ETH per account** proposal was a conservative reserve,
not an expected transaction cost or a protocol minimum. It used the padded
deployment gas limit at a hard 3-gwei ceiling (0.02550786 ETH) and a separate
10,000,000-gas challenger ceiling at 3 gwei (0.03 ETH).

A fresh read-only sample at **07:27:28 UTC, Mainnet block 26074453** returned
0.19360558 gwei with a zero suggested priority fee. The two exact deployment
estimates total 7,002,184 gas, implying about **0.001356 ETH** at that sampled
price. Padded limits total 8,502,620 gas; twice the sampled price gives an
upfront allowance of **0.003292309 ETH**. Funding should follow refreshed
transaction estimates plus an explicit modest buffer, not automatically the
hard ceiling. Deployment figures exclude browser test principal/fees and any
separate owner pause transaction. A fee cap is not the actual fee paid.

The challenger needs an independent operating balance to contest invalid
escape withdrawals. Its 10,000,000-gas ceiling at the sampled price represents
0.001936056 ETH; the previously measured roughly 7-million-gas proof is only
a comparison, not a successful live Mainnet challenge measurement. Code review
confirms the daemon requests estimated gas plus 20%, and the signer uses the
current RPC gas price subject to the ceiling. No fixed 0.03 ETH balance is
required. At the sampled fees, **0.005 ETH per account** is a smaller proposed
initial allocation; refresh estimates before use and monitor for top-ups.
This does not establish indefinite coverage: 10,000,000 gas costs more than
0.005 ETH above 0.5 gwei, and multiple challenges can exhaust the balance.
Signer health checks chain identity without checking balance, so healthy does
not establish the ability to submit a challenge. Unused funding remains in
the respective account; it is not automatically spent.

The vault has no total-deposit cap, so an operator gas budget does not bound
funds accepted by an active public deployment. It starts unpaused; an owner
pause is a separate transaction and also blocks mutual close and initiation
of escape withdrawals. The live challenge acceptance gap, single-party proof
setup and unaudited integration remain material limitations. The separately reviewed Mainnet route is now active.

The native protocol work is isolated in `codex/native-eth-wallet` in the
`zkapi-EF-collab` repository. Native implementation commit `abfd3a7` passed its
initial independent review, but the deployment audit found inherited legacy
protocol weaknesses. The rollout incorporated the separate
note-bound circuit repair and durable challenge service before publication. The initial backend source was independently approved at
`dfa0e42ca6dfec46e20dcb7ffd6ac44c2ccbebea`; the merged backend below now runs
`2e9647cecec78e1258b34f8be1bc85ea2378cd66`, with unchanged protocol
`8b2d4e3da921f956e1eb6b93afbf722a877c060c`. It also namespaces upstream key
replay by the complete accepted request/deployment, supports delayed issuance
replay, and challenges active leases without waiting for final usage accounting.

## Review merge: current Sepolia frontend and backend

The canonical origin **https://oa-wallet-eth-sepolia.vercel.app** serves app
`5255a23d3373d45e679d97499e6bcb28bedbe2f8`, immutable SDK
`2e9647cecec78e1258b34f8be1bc85ea2378cd66`, build `IPB766G3`, Vercel production
deployment `dpl_B7BXWut3W6uYnupsjwX3CAacAzjo` (READY). The SDK merge has native
parent `6f12f3b` and review parent `2eda8f3`; protocol/vault/proof pins are
unchanged. Exact deposit confirmation now survives a later display refresh
failure, with truthful pending/confirmed UI and no second funding prompt.
See the [review acceptance matrix](ZKAPI_REVIEW_MERGE_20260927.md).

Source validation passed 1,400 app tests, 305 SDK tests, 141 integration Rust
tests, 82 protocol Rust tests, 27 Solidity tests, two real shipped-WASM proofs,
11 restricted signer tests and four launcher smoke checks. Fresh independent
reviews approved the final SDK/backend and host diffs. Both app network builds
passed at that stage; Mainnet then reported `migration_required`. The September
28 rollout above supersedes that earlier Mainnet status.

Independent verification matched all 486 published artifact hashes; public
browser configuration, deployment configuration, health and billing quote all
returned HTTP 200. A fresh canonical browser confirmed the release identity,
accountless ETH/USD funding, collapsed help and disabled unfunded Next. Four
unit switches took 8.2–17.6 ms without changing principal; no JavaScript page
errors appeared. The browser was closed without signing or inference.

The follow-up rollout deployed merged backend `2e9647c` at 2026-09-28
04:43:09 UTC (September 27 PDT). Server, indexer and challenger use immutable
image `sha256:d833ea7c4e9246f0f521fe4832b01477f8490ed03b944a845b2baa681bca4859`.
A corrected source-timestamp rebuild explicitly recompiled all ten relevant
workspace/protocol crates, avoiding stale Cargo workspace outputs. All eleven
binary/launcher/proof hashes and four isolated startup checks passed independent
review. The installed SDK validated the live manifest; 34 native gateway,
proof, secret-boundary and launcher checks passed.

The native vault, proof setup, public signing identities, secrets, database,
launcher, signer and TLS service were preserved. All five legacy containers
retained their identities, images and ports. Public config, health and native
quote returned 200; private routes stayed unavailable. The challenger checkpoint
advanced from 11798184 to 11798194 with zero pending obligations. Stopped-state
backups were retained, and rollback restores images/configuration without
rewinding live state. Org, station and contracts were not redeployed.

### Fresh merged browser acceptance

A controlled accountless browser on the canonical origin completed this flow
with the merged frontend, SDK and backend, using GPT-4o-mini directly through
the existing verifier-gated OA issuance path. Network proxy was off; this run
does not establish proxy routing or a MetaMask extension happy path.

- The saved principal was 744,884 gwei (0.000744884 ETH), originally entered as
  $2. The current USD display was about $1.98 because the wallet holds ETH.
  Exact displayed funding of 0.004435565428170351 ETH was sent in
  `0xc89f126894e6132b382730eaa8b15cdf6c05b2a14c05fd508a3fa9dfa37a3b0e`.
  A refreshed gas quote correctly kept Next disabled when more was needed.
  A separate 0.01 ETH test allowance for quote movement and later withdrawal
  gas arrived in `0x56ceb9b4de347dc9864e70879fd7173c15ebc945dd7873a935705c19def0df9b`.
  Full browser closure/reopening retained the address and exact principal;
  no automatic deposit occurred and the account nonce remained 5.
- Explicit Next submitted exactly one deposit,
  `0xa6d32578c1adcd357e83de59ff84a97d85f06caa90dc9a4ceaa155cd9eb5ab93`,
  block 11798202, nonce 5. It used 6,742,199 gas and paid
  0.007517556651734693 ETH. The confirmed balance/history survived another
  full browser restart. This deposit confirmed before the browser was closed;
  pending-deposit interruption coverage remains the earlier run below plus
  current recovery regressions.
- A new real GPT-4o-mini session returned “Merged native ETH acceptance passed.”
  Exactly one new OA lease was issued after rollout. Its signed station/org
  receipt finalized $0.007471 as 2,816 gwei, independently matching the
  request's frozen 2653.90512925 USD/ETH quote. The remaining private principal
  was 742,068 gwei.
- Mutual withdrawal
  `0xf4490c5c058602fc970d6cfd2b53ca9ae79e66e7c586b35fdaca708572069fab`
  mined in block 11798262 at nonce 6. It used 7,051,101 gas and paid
  0.007919450102739153 ETH, returning exactly 742,068 gwei to the controlled
  operator. Note 5 is Closed. The browser was closed with confirmed/pending
  nonces 6/7; reopening recovered the same transaction and returned-history
  entry. Both nonces became 7, with no duplicate withdrawal.
- The initial withdrawal automation lost input/focus across polling renders.
  A synchronous input/change/click sequence through normal form handlers
  succeeded without bypassing authorization, simulation or signing checks.
  Independent investigation found no source defect; no code change was made.
  The known refresh/checkbox-reset UX limitation remains a follow-up.

The browser funding address retains 0.004691996028635259 test ETH for future
gas. No sweep was requested. At the receipt check, latest block was 11798268
and finalized block 11798196: both new receipts were mined successfully but
were not yet Ethereum-finalized. A follow-up at 05:21:23 UTC independently
matched both receipt block hashes to canonical blocks below finalized block
11798292, confirming both browser transactions finalized. Public-only evidence
and screenshots are in
the protected deployment bundle's `review-merge-e2e-20260928/`; the signed
settlement projection is in `merge-rollout-2e9647c/browser-settlement-latest.json`.
Mainnet remains guarded at the user's explicit request; Google login is outside
this follow-up's scope.

### Live challenge acceptance stopped; ordinary cleanup

The separate live challenge test did **not** complete. Automatic safety review
rejected its continuation for possible cybersecurity risk after two ordinary
deposits and local preparation of one request. No request was issued, no escape
transaction was submitted, and no deployed challenge success is claimed.
An exact-ID read-only server query confirmed zero lease/nullifier records for
the prepared request. Local real-proof historical-root and v2 daemon regression
coverage remains valid; this follow-up does not replace it with live evidence.
The main agent accepts this remaining limit for the Sepolia test deployment.
Mainnet remains guarded, and this is not production readiness approval.

The dedicated controlled EOA received 0.05 Sepolia ETH in
`0xf747cecf2ed688912ed551985897e95fc058121b0893ab07707c2c1629062927`.
Preparation and ordinary cleanup produced these transactions:

| Operation | Note | Block | Transaction |
| --- | --- | --- | --- |
| Deposit 753,607 gwei | 6 | 11798275 | `0x8b4f5aec1c274e4b3e8e201ef98bc49b2b32516ef2574cc60d3b3d1a37c1d382` |
| Deposit 50,000 gwei | 7 | 11798281 | `0xee1bf39ceac64bed219d3d7da525427eaa2fc6ab7bf899c0012ad2063f05b519` |
| Normal mutual close; 50,000 gwei refunded | 7 | 11798302 | `0x060367f2686ba41b60fe1b11a3643b8a5964e87028883f84d3a2af8dc4e66f12` |

Note 6 remains under controlled custody with **753,607 gwei** and its exact
locally prepared request. No key was issued. Merely observing no issued lease
does not authorize deleting that request. The reviewed cleanup adapter uses
the SDK's existing `/expire` recovery and preserves the ID, payload and journal
until a server acknowledgement binds an `expired` or `superseded` outcome
under the issuance lock. An unrelated tree-root change does not satisfy this
native quote recovery rule.

The read-only watcher observed eligibility after the saved quote expired at
2026-09-28 05:32:36 UTC. Automatic safety review then also rejected the cleanup
agent's continuation for possible cybersecurity risk. **The expiry acknowledgement
and note 6 mutual withdrawal were not executed.** No alternate mutation path was
used. The main agent accepts retaining this controlled Sepolia recovery obligation
and reports it explicitly; cleanup is unfinished.

An independent check at block 11798448 confirmed note 6 Active, note 7 Closed,
no pending escape for either, and no escape initiation/challenge/finalization
events for either note since deposit. The dedicated EOA
`0xAa0235A3c22d772a04bBf1B942013080d2220b35` holds
**0.027933169397001076 Sepolia ETH**, with confirmed/pending nonces 3/3.
Final public checks at 05:35:13 UTC returned 200 for config, health and native
quote, with source `2e9647c` and finalized price round `18446744073709588006`.
The remaining private note and public ETH remain recoverable controlled test
funds; no public sweep was made. Completing the supported expiry acknowledgement
and ordinary mutual close remains a follow-up, not a passed acceptance step.

Public-only evidence and protected custody/recovery state are retained in
`review-rollout-challenge-20260928/` inside the deployment bundle. Do not delete
its wallet, prepared request, proof or transaction journals. The browser's
separate deposit/inference/settlement/withdrawal acceptance above is complete;
the live challenge test and this final cleanup are not.

## Unused first test vault

The first native Sepolia vault is
`0x0bf47f7fCc28975E4A928587869B73D32CD12f77`, deployment transaction
`0x868010aba1d574ed8bcf885c8df0d354ff01f781a0018e57ee9605f6ecf62605`,
block `11796294`. Deployment spent `0.006174920180726163` Sepolia ETH.
It uses the legacy proof adapter and **must never be funded or published**.
No native deposit or user funds entered this vault. The corrected vault is listed below.

The inherited circuit permitted signed-balance transplantation across notes.
Its contract also rejected a valid archived request root when unrelated tree
updates occurred before an escape withdrawal. The new `zkapi-v2-note-bound-v1`
setup and historical-root contract repair address these issues. A challenge
service must also operate throughout every escape window, including usage
receipt outages. The new setup is single-party, with no multi-party ceremony;
Mainnet publication requires a separately reviewed deployment decision.

## Corrected Sepolia vault

The reviewed replacement is `0xcEd1620189261DbeDf8fb0860E33179642D39076`,
transaction `0x84bfc92d4ce6ee4981db6912d3aa0c46eb084db60c3daf73bc8900e630354250`,
block `11796375`, costing `0.005658687956398008` Sepolia ETH. All constructor
getters match the native denomination and fresh signing keys. Reused note-bound
proof adapter and Poseidon code were verified at finalized state against the
compiled source. Finalized block `11796405` includes this deployment; the
finalized runtime hash also matches. Backend/challenger startup checks passed.

## Infrastructure prepared

- AWS account `427880590996`, profile `dev`, renewed SSO verified.
- Separate native gateway ports `8081`/`8082` on the existing test VM
  `i-0c44b6d92cbf2df00` in `us-west-1`. Old ports, config, databases and services
  are preserved. New gateways bind loopback only. The first obsolete native build was stopped before deployment.
- Additional security group `sg-0e776a37a09cb29a8` exposes only TCP 443.
  Earlier plaintext gateway ingress has been removed. Caddy terminates verified
  TLS at `52.53.106.195.sslip.io`, requires a secret CloudFront origin header,
  strips it before proxying, and deletes request objects from error logs.
  Wrong/missing credentials and unknown prefixes return 403; upstream-outage
  logs contain no origin credential. Certificates persist and renew through
  TLS-ALPN; port 80 stays unchanged. This hostname is for Sepolia testing.
- Sepolia distribution `EDQEUR5WZ4IJC`, domain
  `https://dptoa4nnlue6m.cloudfront.net`, is deployed with HTTPS origin
  port 443 and `/sepolia` prefix. Caddy forwards only to loopback `8081`.
  The isolated server/indexer/challenger/signer/gateway stack is running.
  Public health, attestation, finalized-price quote, proof hashes and every
  browser trusted pin match; unrelated routes return 404.
- Staging org `https://org-staging.openanonymity.ai` lacked the dedicated zkAPI
  relay. The reviewed port `1aee78b9a20a6dcc66755fb74f9043601bfee84f` is now deployed,
  based on exact former live commit `e4670a1`. Public org/ticket keys stayed
  unchanged; existing public, billing and authorization checks passed. New
  endpoints reject unsigned calls, and no real key was issued during deployment.
- Staging station already supports idempotent key provisioning and signed
  finalized usage receipts. Its existing private HTTP advertisement will stay
  unchanged. A dedicated authenticated SSH tunnel now listens only on the org loopback
  port `18001`, forwarding to station loopback port `8000`. It uses a restricted
  account/key, pinned station host key, and systemd restart management. Both
  station routes were reached through it without issuing a key. The exact
  `oa-station` origin override is included in the deployed, reviewed org port.

Operator-only deployment records and credentials live under
`~/.codex/deployments/zkapi-native-eth-20260927/`, outside the source tree.
Never publish those files or print private keys, service credentials, raw
browser storage, or full key responses.

The initial reviewed native Sepolia SDK configuration was committed at
`ad2b134d36222cc84f6105b29c52ce878516213a`. The dynamic-fee release below
updates both immutable app package pins to `6f12f3b520989d24c50fbeee33b4c42b761d5651`. Mainnet retains its explicit migration guard.

The OA Vercel projects `oa-wallet-eth-sepolia` and `oa-wallet-eth-mainnet`
are created and linked locally. The initial Sepolia release was published at
`https://oa-wallet-eth-sepolia.vercel.app`, deployment
`dpl_Cu6hwbThiU9XnJ5A1YXCPLLtzxbs`, app commit `dd1009a` / SDK `ad2b134`.
Build hash: `Y42XTF2L`. All 486 final published files match their build manifest.
All 486 emitted artifact hashes passed independent review. The canonical
origin serves the correct native backend through same-origin rewrites.
Mainnet compiles locally with its migration guard and is not published.

The dedicated Sepolia challenger received `0.012` test ETH in transaction
`0x73443886608f31ac6e3d1109f3742bee94bed7441432d861b9deb63d7ea65bc3`,
block `11796454`. Its durable checkpoint advances and all five legacy
containers retain their identities, images and published ports.

Both new Vercel origins were added to staging org credentialed CORS and OAuth
return allowlists. Existing origins, RP ID, cookies and signing identity were
preserved; new/existing-origin positive checks and unknown-origin denial pass.

## Compact address screen: earlier Sepolia release

The canonical site **https://oa-wallet-eth-sepolia.vercel.app** previously served
deployment `dpl_B2SCH5aHQuqR4GRB1UqxCowehmvo`, app
`f9ee03fc96b631b01a3c6a1bea21fbeb5c72e41d`, SDK
`6f12f3b520989d24c50fbeee33b4c42b761d5651`, build `SXHXD7RB`.
The exact amount to send and address are prominent; principal, fees, buffer
and explanations are behind a clickable question mark. Slow-confirmation
explanations were removed. Fee policy, transaction amounts and signing are
unchanged.

All 129 focused UI/funding/recovery tests passed and fresh review approved the
final diff. Browser checks covered desktop plus 390px and 320px widths, exact
unbroken decimal amounts, default-hidden details, keyboard/outside dismissal,
and a full 35-second quote-refresh interval with open state and focus retained.
The refresh placeholder contains no stale numeric instructions or Next.
Published verification matched all 486 artifact hashes, with four public
config/health/quote checks returning 200. The canonical browser confirmed
the amount display, disabled Next before funding, click expansion and absence
of slow-fee copy. No funded transaction was needed for this presentation change.

## Low network fees: earlier Sepolia release

The earlier Low-fee release at **https://oa-wallet-eth-sepolia.vercel.app** used
Vercel deployment `dpl_ANwtdv4QYnsF2jwnfn3KTQcjCixN`, app source
`bfe09cf3ca162d2bcbc3c3d4efe7133b772f981e`, SDK
`6f12f3b520989d24c50fbeee33b4c42b761d5651`, build `VUJXGHPE`.
Independent verification matched all 486 live artifact hashes and checked
the unchanged native Sepolia vault, staging issuer and public endpoints.
Mainnet remains guarded and unpublished.

New address deposits, withdrawals and public ETH returns use the median
10th-percentile priority reward from nonempty blocks within the latest 20
blocks, with a 0.001-gwei floor. The fee cap uses 1.25 times current base fee
plus that tip. Strict, fresh, block-anchored history is required; malformed
or unavailable history refuses signing instead of falling back to an expensive
node suggestion. Gas limits, spending caps, durable journal replay and explicit
submission remain unchanged. Existing signed transactions retain their exact
bytes. MetaMask continues to set its own fees.

All 886 core and 454 payment tests passed (1,340 total), including real-EVM
simulation, fee-spike refusal and modest-rise execution within the approved
cap. A fresh adversarial review approved the final source. Desktop and mobile
preview checks verified the Low-fee guidance and quote layout.

The same-block Sepolia comparison at block 11797083 reduced the maximum fee
reserve from 0.01565140231992339 to 0.009785179194182595 ETH (37.48%).
The priority tip remained 0.001 gwei. This is a reduction in prefunding and
fee headroom, not a claim of 37.48% lower actual charges: the earlier deposit
already spent 99.9057% of its network fee on base fee rather than the tip.
Lower headroom can require more waiting when base fees rise; there is no
automatic fee bump.

The canonical browser profile also completed a live Low-fee mutual withdrawal
of the retained 744,884-gwei test note. Two affordability failures were refused
before signing as fees moved; explicit test-account top-ups of
0.000734714560264192 and 0.003 ETH and explicit Continue withdrawal resumed
the existing authorization. Transaction
`0xd3d2dd7ef4dcbecdc0362fd71045f70e52866e57b6b39e22c1778e0fd00991b8`
mined successfully in block 11797127, using account nonce 4. It signed with
maximum fee 1.292962397 gwei and priority fee 0.001 gwei, used 7,043,946 gas,
and paid 0.007545454436185302 ETH. The inclusion base fee was 1.070197087
gwei. Confirmed and pending account nonces both became 5. The UI reported
the correct payout to the controlled test operator and retained its history.
Full browser closure and reopening preserved that history, the funding address
and Low-fee guidance; both nonces stayed 5 with no additional transaction.
The public funding address retains 0.006438321354938754 test ETH for future
fees; no further sweep was requested. This receipt is mined evidence, not a
claim that its block has reached Ethereum finality.

Public-only evidence is in the protected bundle's `live-e2e/low-fee-*` files.
This fee-only live acceptance exercises the shared address signer through a
withdrawal. The earlier live deposit/recovery/chat run and current real-EVM
deposit tests supply the remaining coverage; a new live deposit was not made.

## Dynamic deposit quotes: earlier Sepolia release

The earlier dynamic-quote release at **https://oa-wallet-eth-sepolia.vercel.app** was
Vercel deployment `dpl_7Rp4HvNH1P1Xi39rcCKJmuhHMF3E`, app source
`ca008e64998fee4808b2ba2ad737abc36902044a`, SDK
`6f12f3b520989d24c50fbeee33b4c42b761d5651`, build hash `PE25UOAE`.
The separate audit verified all 486 published files against their SHA-256
manifest, matching deployment/proof pins and four public endpoints returning
200. The staging org and native backend are unchanged. Mainnet remains guarded
and unpublished; a local Mainnet build passed.

The address flow now simulates its actual prepared native deposit before
funding, showing principal, estimated fee, buffer and total to send. Existing
public ETH reduces that transfer. Explicit Next refreshes the quote; an
increased total requires review. The signer can use the approved buffer for
modest changes while never exceeding its total fee cap. A pre-sign rejection
retains the exact prepared deposit for a fresh quote. Actual receipt fees are
persisted and shown beside the independently polled remaining public ETH.

Validation passed 886 core and 448 payment tests (1,334 total), plus 298 SDK
tests. Real local Anvil tests exercise unfunded balance-only simulation,
approved-buffer use, exhausted-budget rejection, exact payable calldata and
remaining-balance arithmetic. Fresh adversarial review approved both the SDK
and app, including the live-test pricing refinement. Desktop and 390px browser
checks showed the four fee rows without overflow. The tested USD price outage
failed closed and recovered when a fresh finalized round became available.

Live Sepolia acceptance on 2026-09-28 UTC (Sep 27 PDT):

- The browser showed `0.01812683356071672` ETH to send, comprising principal
  `0.000744884`, estimated fee `0.0072093324245628`, and buffer
  `0.01019090362438792`, less `0.000018286488234` ETH already present.
  The operator sent exactly the displayed amount in
  `0x1e3614cefd9a5614b6a92879349ab4a2dae121319cfc57ecdc47913fa27702ae`,
  block `11796966`. The sender's separate transfer fee was
  `0.000022043317632` ETH.
- Full browser closure after funding restored the same address and principal.
  The funding account nonce remained 3 until explicit Next. A higher fresh quote
  required another review; a pre-sign price rejection saved a prepared deposit
  without broadcasting. That exact plan also survived a full browser restart.
- The final app submitted one deposit,
  `0x74cb011fc5fec292e89658ce18e99343c3beead542ed99258d2d4b6679cab3a9`,
  block `11796995`, nonce 3. The browser was closed while confirmation was
  pending. On reopening, an explicit Check payment status recovered the same
  transaction and made the private balance available; nonce is 4, not 5.
- The successful receipt used `6742196` gas at `1060659586` wei/gas. The actual
  fee is **`0.007151174818090856` ETH**, versus the initial estimate
  `0.0072093324245628`. The public remainder is
  **`0.010249061230859864` ETH**. Independent chain arithmetic verifies
  incoming transfer + previous balance − principal − actual fee = remainder.
  The receipt was canonical and successful at verification time; it had not yet
  reached Ethereum finality, so this evidence does not claim finalized inclusion.
- Both exact values appear in the confirmed UI. A further full browser restart
  retained the actual fee in payment history and refreshed the same public
  remainder. These are conservative fee allowances, not a guarantee of tiny or
  zero leftovers. The controlled test profile retains its private test balance
  and public ETH for inspection/future test fees; no Mainnet funds were used.

Public-only evidence is stored in the protected deployment bundle's `live-e2e/`
files prefixed `browser-quote-`, plus `final-public-artifacts.json`. This follow-up
retests the deposit/fee/recovery flow; the earlier chat, settlement and withdrawal
acceptance remains recorded below and was not repeated for this fee-only change.

## Browser verification completed

The app diff passed independent review. Full app tests passed 886 core and
403 payment tests (1,289 total including the final recovery follow-up). A local actual-browser fixture verified the normal address
flow without password/backup controls, USD edits through refresh renders,
restored address and exact principal after full browser closure, zero automatic
submissions on simulated receipt, and one submission after explicit Next.
The fixture used simulated price/RPC/SDK submission and is **not live Sepolia
end-to-end evidence**. The revised SDK separately passed all 272 tests with
matching note-bound WASM and proving assets.

The prebuilt Sepolia publication review verified all 486 static-file hashes,
the immutable app/SDK revisions, native deployment/proof pins, staging API
rewrites, disabled verifier bypass, and absence of operator credentials in the
public output. Account passkey relay behavior remains unverified: `build.json`
records `https://staging.openanonymity.ai/passkey-relay.html`, but the current
build script only records that setting as metadata; it does not inject the URL
into executable code. The account encryption-passkey implementation uses local
WebAuthn PRF. Do not treat the metadata value or the separately verified staging
origin/CORS allowlists as evidence of a working account relay. Native wallet
funding and recovery do not depend on that inherited account feature.

The first live address screen exposed an overly conservative pre-funding gas
calculation: the theoretical maximum transaction gas limit could exhaust the
fee cap despite an affordable actual deposit. The reviewed correction reserves
the existing 0.02 ETH per-transaction spending ceiling before funding; final
simulation, gas pricing, affordability and signing caps remain unchanged.
Unused reserve stays at the public funding address. This reserve covers the
deposit ceiling; a later withdrawal can require a separate gas top-up.

## Live Sepolia acceptance

The canonical origin used browser-local custody without an injected wallet.
The persistent test profile and sanitized evidence are retained outside the
repository in the protected deployment bundle's `live-e2e/` directory.

- A $2 input produced exactly 747,268 gwei of principal (0.000747268 ETH)
  plus the 0.02 ETH reserve. A full browser restart preserved the funding
  address, input, principal and total. Next stayed disabled before funding.
- Incoming funding transaction
  `0xe87b91d7fd5d646119a5e1ab7f9e17e61c07997d9d2b90350aec03a668beded4`
  transferred 0.020747268 ETH. Polling detected it and enabled Next; the
  funding account's nonce remained zero until the explicit click.
- One explicit Next submitted deposit
  `0x76bb11df8398dae9389b8e1206640ebc0d6f740c4838ad35405c579980a0dba3`,
  block 11796514. The browser was closed while that transaction was pending.
  Reopening reconciled the same receipt into the private balance without a
  second submission. Actual gas was 6,759,269 and the fee was
  0.007528036291476899 ETH.
- Actual GPT-4o-mini inference returned the requested text, “Native ETH test
  passed.” The staging issuer returned one active ephemeral key, verified
  through the existing OA verifier with bypass disabled.
- The first issuance attempt exposed a station IP allowlist mismatch: the
  authenticated SSH relay connects from loopback. Adding only `127.0.0.1`
  alongside the existing org IP resolved it. Signed OrgAuth remained required;
  missing, malformed and forged signatures returned 401. Station source and
  identity were unchanged. The original saved request retry succeeded.
- Signed station/org usage receipts finalized $0.007446 of usage as 2,783
  gwei, matching the request's frozen 2676.4173 USD/ETH quote. Remaining
  principal was 744,485 gwei; this is ETH accounting, not fixed dollar credit.
- Withdrawal retained the explicitly entered destination. Its first attempt
  was refused before broadcast with 0.012471963708523101 ETH available for
  gas. A controlled 0.01 ETH top-up and explicit Continue withdrawal resumed
  the saved authorization successfully, without a new lease or clearance.
- Mutual close transaction
  `0xa3e7fe8c3e78db5b6fb433c167bf3c6c195e269d6bad359e43b2e8ef33a3ddc3`,
  block 11796574, used 7,051,071 gas and paid 0.007263366020626845 ETH in fees.
  `MutualClose` records the exact 744,485 gwei payout. Note 0 is Closed;
  the vault balance is zero and chain/indexer/server roots match the empty
  root. The UI reported the return and retained transaction history. At the
  first check this was mined and indexed, but not yet finalized by Ethereum.

The final follow-up passed fresh adversarial review and all 1,289 tests. It
makes fee shortages actionable and keeps collapsed public ETH return controls
reachable after the private note closes, even without a working price quote
or balance poll. The deployed build's 486 file hashes and public backend pins
passed verification. Public reserve return then succeeded on the same saved
browser profile:

- Explicit Send ETH and confirmation returned 0.015166779751890256 ETH to
  the controlled test account in transaction
  `0x729180b06f622b2c440fae46644fdf4e9c7a7261ec7acfd22655ae371fab8cc9`,
  block 11796608, nonce 2. The fee was 0.000023531447772 ETH.
- The remaining 0.000018286488234 ETH is unused fee headroom. Do not describe
  max return as an exact zero-balance sweep.
- Full browser closure and reopening preserved the address and saved return
  transaction. An explicit check reused its exact signed bytes; confirmed and
  pending account nonces both remained 3, with no new transfer.
- The recovery journal intentionally stays pending until the return block is
  Ethereum-finalized. The check now explains this final-network-confirmation
  wait. At 23:26 UTC the finalized block was 11796533: deposit finalized,
  withdrawal and public return mined successfully but awaiting finality. The
  23:29 check advanced to 11796565; do not claim the latter two transactions
  or the public-return journal have finalized yet. The protected test profile
  remains available to complete the explicit saved-transaction check later.
- A separate unfunded browser profile exercised the deployed fee error: blank
  max ETH return reported the exact 0.000042852911430001 ETH shortfall, public
  address, Sepolia, and explicit retry instructions. Chain balance and both
  nonces stayed zero. No transfer, deposit or inference occurred in that test.
  The final pending-confirmation copy change also passed independent review
  and 38 focused UI/action tests after the complete 1,289-test run.

At 23:29 the finalized ETH/USD round briefly exceeded the pinned 4,500-second
freshness limit and the quote endpoint returned `native_quote_expired` (409).
The latest block already contained the next round; when finality advanced from
11796533 to 11796565, the endpoint automatically returned the new round with
200. A roughly hourly feed heartbeat plus finality delay can produce this brief
window. There is no server oracle cache to clear, and no freshness pin was
relaxed. New USD quotes/leases fail closed during it; existing ETH ownership and
withdrawal/return recovery do not depend on it. The final public verification
at 23:29:40 recorded matching artifacts and 200 health/config/quote responses.

This initial run did not include a live malicious-escape challenge test, a full
MetaMask extension test, an account/passkey relay test, or a Mainnet test.
The native real-proof/contract challenge tests passed locally; the separate
follow-up challenge acceptance is tracked in the current release section above.

Mainnet remains guarded and unpublished. Both deployment and dedicated
challenger accounts hold zero Mainnet ETH. Publication needs an explicit
bounded experimental deployment/funding decision: the new proof setup is
single-party, with no multi-party ceremony, and the integration is not production-audited.


## Prepared Mainnet test decision (not authorization)

A read-only independent review measured a real-proof challenge at 6,993,165 gas.
For a deliberately bounded experiment it proposed a dedicated signer ceiling of
10,000,000 gas and 3 gwei, with 0.03 ETH reserved for one worst-case call. This
is not a universal gas bound or indefinite coverage; fees above the limit pause
submission, and an operator must monitor balances and stuck nonces throughout
the 24-hour challenge window. No automatic fee increase/replacement exists.

At 23:20 UTC a fee refresh using the earlier padded verifier/vault gas
estimates put deployment liability at approximately
0.0213393163 ETH. A 3 gwei deployment ceiling would bound the two deployments
at 0.02550786 ETH. The proposed funding is 0.03 ETH for the operator and
0.03 ETH for the dedicated challenger, with browser principal and its own
transaction fees additional. These are funding budgets, not predicted fees;
refresh the estimate before any Mainnet transaction. No Mainnet transaction
has been signed or broadcast, and no such funding/risk decision was accepted.

The review recommends completing the isolated live native challenge acceptance
before proceeding. Single-party setup secrets, if retained, can undermine
proof soundness; the new circuit/native integration is unaudited. A bounded
experiment is therefore a separate decision from public production readiness.
