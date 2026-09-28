# Fresh native ETH deployments, 2026-09-28

Status: both networks' contracts are finalized and their public HTTPS endpoints
passed read-only acceptance. Sepolia's funded normal-flow test using the real SDK
passed deposit, key issuance, OA verification, inference, settlement and finalized
mutual withdrawal, including the exact refund and treasury payment.
Mainnet's deployer received 0.02 ETH.
The user requested fresh deployments from latest main on both networks on new EC2 instances.
Existing deployments and their wallet recovery origins are preserved.

## Source and infrastructure

- OA Chat main: `867934aa115190ab11e5dfb84c0aca64f3b67a40`.
- Backend/SDK main: `20aa542ae98e767c0507133fd34b12a56f5ccd3d`.
- Backend's pinned protocol: `8b2d4e3da921f956e1eb6b93afbf722a877c060c`,
  circuit `zkapi-v2-note-bound-v1`. Protocol main's merge is documentation-only
  relative to this reviewed pin.
- AWS account `427880590996`, region `us-west-1`, Ubuntu 24.04 ARM64,
  `t4g.large`, encrypted 50 GiB gp3 disks, IMDSv2 required.
- Mainnet: `i-0fc75e9ea8f3347cd`, Elastic IP `54.67.93.98`.
- Sepolia: `i-0bc89435dd584924f`, Elastic IP `52.52.207.206`.
- SSH host keys are checked against AWS console output and pinned locally.
  SSH ingress is restricted to the deployment workstation's /32; HTTPS is the
  only public application port.
- All five existing regional Elastic IPs were in use. Two quota increases were
  approved; each new instance now has its own reserved Elastic IP.

## Fresh wallet roles

| Network | Role | Address |
| --- | --- | --- |
| Mainnet | Owner/deployer | `0x251e7D5395436fa00699E626d618d41Fe679c559` |
| Mainnet | Earnings treasury | `0xD2de9A7E560227E5676c906eE1F1df35e6f281D5` |
| Mainnet | Dedicated challenger | `0xD397Ec72FbE69775d852eeb9effAD5095919d839` |
| Sepolia | Owner/deployer | `0xb327C77411AA2D6BC1155fd7F627D33e91F5d0D8` |
| Sepolia | Earnings treasury | `0xc34d9008A5F666Dc3Ef74F1c9E37F8248c35115A` |
| Sepolia | Dedicated challenger | `0xff9d7c999DED11F1986A30C0Ae876A45Db3060d5` |

The protected local deployment record is
`/Users/mingyech/.codex/deployments/zkapi-fresh-20260928/` (mode 0700), outside
Git. Mainnet credentials are in `keys/`; Sepolia credentials are in
`sepolia/keys/`. Each contains owner-only `.private-key`, encrypted `.keystore`
and `.password` files for each role. `server-seeds.env` contains separate
protocol signing seeds; those are not Ethereum withdrawal keys. Never print
credentials, include them in public manifests, or copy owner/treasury keys to
the runtime host.

Earnings-only handoff folders under that protected root are `operator-handoff/`
for Mainnet and `sepolia/operator-handoff/` for Sepolia. Each contains only
`README.md` and `treasury.private-key`, with mode 0700 on the folder and 0600
on both files. Share the appropriate handoff folder, not the deployment root.

Protocol seeds must be nonzero canonical BN254 field elements, below
`21888242871839275222246405745257275088548364400416034343698204186575808495617`.
An arbitrary random 256-bit string can be rejected by the signing-key loader.
Generate these seeds uniformly within the field and verify the public
coordinates using the exact freshly built runtime before signing the immutable
vault constructor. Both networks passed this check on their own EC2 host.

## Build and current transaction evidence

The fresh ARM64 image is
`sha256:23f9bc2fdc7725665d4196bb2c817d8167a746b96721cc7f17491005b11248ca`.
Runtime startup checks, signer tests, gateway configuration validation and 29
offline transaction-boundary checks passed. Independent review approved the
contract and test-funding executors with exact hashes and durable same-byte
transaction recovery. Deployment fees are capped at 0.045 ETH per network and
5 gwei; these are ceilings, not expected fees.

Sepolia owner funding (0.021 test ETH) mined in block 11801442, transaction
`0xdbf0800e6a3baadbbc0179f031c174cf09415389f20a85fd5d71c909e3932e57`.
The fresh verifier adapter at `0xAac82711C097a412e29BDDEE1d8e634f00599C65`
mined in block 11801447, transaction
`0x43257437a5a41cfb1fca034ada198111bceea640e653ce5b3cdf8aded8fa441d`.
Its runtime hash matches the reviewed artifact and it is finalized.
The Sepolia vault at `0x999F40773e47f7e07f435C0CC69225c409B64329` mined in
block 11801523, transaction
`0xc0b773c68b49e5cdce4adbabc1eb00f65a2e63129bbefaa8c30b6bd059de4d12`.
The vault is finalized; all constructor getters and its runtime hash match. Total verifier plus vault
fees were 0.007542367751301854 test ETH. The challenger received 0.02 test ETH
in transaction
`0x69b29517a99781903f1ab6cbd18ebe767fd1bbc1af36405fff03545953564b29`.
All six services, including TLS, are running and the four defined Docker
healthchecks pass. TLS is checked externally; challenger progress is checked
through its checkpoint. Those two services have no Docker healthcheck. The public API is
`https://52.52.207.206.sslip.io`. Read-only acceptance on 2026-09-28 verified
finalized contract bytecode/getters, SDK trust pins, served configuration,
signing keys, current tree root, native ETH quote against the finalized oracle,
and all proving-artifact hashes. Private routes return 404 and private ports
are unreachable. The challenger checkpoint was independently observed advancing
with no pending obligations. A fresh 0.00075-test-ETH note was deposited and
finalized in block 11801840, transaction
`0x15fc43eedc2b6f463e13699abf548b66fd72b99e46387c09d0fa3c8eb050d86a`.
OA-issued key verification and exactly one tiny direct inference passed
(10 input tokens, 2 output tokens, provider cost USD 0.000003). Signed settlement
charged 2 gwei. The temporary `lease_settlement_pending` HTTP 409 response
required waiting for authoritative usage finalization; the same lease/request
journals were retained without repeating inference.
Mutual withdrawal finalized in block 11801961, transaction
`0xdeccef7c7c1ee625361ab214109db54e35f46a82979a77619dac60e8eff0a1e4`.
Independent checks confirmed the Closed note, matching indexer root,
749,998 gwei refund and 2 gwei treasury payout. Deposit plus withdrawal gas cost
0.014687733488492981 test ETH, below the 0.022-test-ETH budget. Finality was
confirmed at checkpoint 11801962; no request or lease remains pending.
The new acceptance wallet retains
0.009312264511507019 test ETH under its protected saved key.
This acceptance used the real SDK in a headless harness; it did not exercise
the browser UI or perform a frontend deployment.
Full receipt, usage, settlement and refund evidence is saved under the protected
root in `acceptance-sepolia/acceptance-final-public.json`.
The post-withdrawal public check also passed at finalized checkpoint 11801962:
`public-verification/sepolia-verify-1790616811895.json`.

Mainnet received 0.02 ETH. Its finalized verifier deployment is transaction
`0xd7f99905879351e3f868c09ef38ab23aff72df38556c9abb009a4bb5d5562951`,
address `0x1bf126FAAb86d494c9118c5b221dDB9E792F04A0`, block 26077201.
The finalized vault at `0x4bDC8718c4F39289455a3C15F8Bd2C345AA51a41` mined in
block 26077290, transaction
`0x7474a8f712be478ab1cadd7f2e9a7ed049c94646ab29f1139a274cbf5b6638f7`.
Its runtime and all constructor getters match. Actual deployment fees totaled
0.009639044233442061 ETH, leaving 0.010360955766557939 ETH in the deployer.
All five private services are running; the four defined healthchecks pass.
Their signing keys match the vault and the indexer root matches the chain.
The challenger has no Compose healthcheck; its checkpoint is advancing with
no pending obligations. Its balance is zero, deliberately. The public API is
live at `https://54.67.93.98.sslip.io`; TLS adds the sixth running service.
Public acceptance verified finalized runtime/getters, SDK trust, served
manifest, signing keys, root, finalized native quote and proof artifacts;
private routes return 404 and private ports are unreachable. No funded Mainnet
deposit/inference/withdrawal test has been performed. The user
explicitly chose deployer-only funding and deferred challenger funding. At
16:10 UTC a fresh estimate was about 0.0094 ETH in actual deployment fees;
the initial 0.01 ETH was followed by another 0.01 ETH. Both transactions used a
lower gas-price cap to fit that balance. Unused ETH stays in the deployer.
Both deployment transactions are already mined: preserve their signed journals
and never sign replacements as part of continuation.
The independently reviewed offline `contracts-mainnet/cap-unsigned-plan.mjs`
creates a separate unsigned plan, lowering only its maximum fee. The original
1.17-gwei version was reviewed, but no transaction was signed with it. A
2-gwei version passed independent review following the additional funding;
both padded gas allocations total at most 0.017005298 ETH. The original
executor still checks live fees, balance, nonce, canonical calldata, simulation
and dependency finality. A fee increase stops signing or same-byte broadcast;
it does not authorize a higher cap. The original zero priority fee is retained.

An unfunded challenger does not prevent API issuance, off-chain settlement or
cooperative withdrawal after the contracts are deployed. Users pay their own
deposit and withdrawal transaction gas. It does prevent the daemon from
contesting stale escapes: after the 24-hour window, an outdated balance may be
refunded and operator earnings lost. Keep the signer and challenger running;
fund the dedicated challenger address later to enable challenge submission.

Only `treasury.private-key` (or its encrypted keystore and separately delivered
password) is required for an earnings-only handoff. Owner/deployer credentials
control contract administration. Challenger credentials must remain dedicated
to the bounded signer; successful challenges require its gas reserve.

## How earnings are received

Each API serves its public manifest at `/config.json` and status at `/health`.
Client trust configurations are saved under the protected root at
`public-verification/mainnet-browser-config.json` and
`public-verification/sepolia-browser-config.json`. This rollout does not
republish OA Chat or change its existing deployment defaults; integrations
must explicitly select the fresh manifest and corresponding trust pins.
The final infrastructure and credential-permission audit is saved at
`final-infrastructure-runtime-sanity-public-20260928T1726Z.json` under that root.
It confirms both AWS instance checks, pinned live images, external HTTPS,
private-port isolation, advancing challenger checkpoints and treasury-only
handoff directories without reading secret values.

`ZkApiVault` pays the consumed operator share to its configured `treasury` when
a note mutually closes or an escape withdrawal finalizes. Its `claimExpired`
path also pays the treasury after the note TTL. There is no separate
operator earnings claim method. Once paid, the treasury account transfers ETH
normally, paying Ethereum gas. Unclosed notes do not imply withdrawable treasury
balance. The owner can change the treasury; an earnings-only operator does not
need that authority.

Fresh vaults use native ETH, integer gwei accounting, 30-day note TTL and a
24-hour challenge period. The legacy `request_charge_cap` configuration field
and `requestChargeCap` getter are set to 50,000 gwei, but dynamic leases use
that value as the minimum request-proof solvency. Their actual lease ceiling
is the proof-bound `public.solvency_bound`, which may exceed 50,000 gwei; the
configured value is not a universal maximum request budget.
Fresh verifier/vault deployments
reuse only the independently bytecode-verified immutable Poseidon library.
Runtime state, signing seeds and challenge checkpoints are independent across
networks. The reviewed protocol remains experimental, with the setup and live
challenge acceptance limitations documented in
[the previous rollout](ZKAPI_NATIVE_ETH_DEPLOYMENT_20260927.md).
