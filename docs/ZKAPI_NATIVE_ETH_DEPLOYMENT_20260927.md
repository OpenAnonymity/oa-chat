# Native ETH deployment work, 2026-09-27

Status: **Sepolia published; live deposit, recovery, chat and withdrawal passed**. Mainnet remains
guarded and undeployed. Existing ERC20 browser
origins and services are preserved for matching wallet recovery.

The native protocol work is isolated in `codex/native-eth-wallet` in the
`zkapi-EF-collab` repository. Native implementation commit `abfd3a7` passed its
initial independent review, but the deployment audit found inherited legacy
protocol weaknesses. The rollout incorporated the separate
note-bound circuit repair and durable challenge service before publication. The merged source is now independently approved at
`dfa0e42ca6dfec46e20dcb7ffd6ac44c2ccbebea`, with protocol
`8b2d4e3da921f956e1eb6b93afbf722a877c060c`. It also namespaces upstream key
replay by the complete accepted request/deployment, supports delayed issuance
replay, and challenges active leases without waiting for final usage accounting.

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
receipt outages. The new setup remains a single-party development setup;
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

## Compact address screen: current Sepolia release

The canonical site **https://oa-wallet-eth-sepolia.vercel.app** now serves
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

This run does not constitute a live malicious-escape challenge test, a full
MetaMask extension test, an account/passkey relay test, or a Mainnet test.
The native real-proof/contract challenge tests passed locally, while a separate
isolated native Sepolia challenge acceptance plan remains unexecuted.

Mainnet remains guarded and unpublished. Both deployment and dedicated
challenger accounts hold zero Mainnet ETH. Publication needs an explicit
bounded experimental deployment/funding decision: the new proof setup is
single-party development material and the integration is not production-audited.


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
