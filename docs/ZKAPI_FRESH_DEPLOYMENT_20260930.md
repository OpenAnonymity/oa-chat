# Fresh zkAPI deployment preparation, 2026-09-30

**Waiting for funding; contracts and live frontend cutover are not deployed.**
Infrastructure, keys, release images and frontend changes are prepared. No
contract transaction has been signed or broadcast. All four new deployment and
challenger addresses were unfunded at the last preparation check.

The user requested latest server code, a new AWS VM, fresh keys on both networks,
and updates to the existing Sepolia and Mainnet staging sites. The user explicitly
approved a clean reset: old balances are not needed. Old servers remain running;
old browser data is retained, without a recovery UI or automatic migration.

## Infrastructure and source

- AWS account `427880590996`, **us-west-2**, instance `i-017d8f0098bb4b1ec`.
- Elastic IP `100.21.48.23`; Ubuntu 24.04 ARM64, `t4g.large`, encrypted 80 GiB
  gp3 disk, IMDSv2, 8 GiB swap. SSH is limited to the workstation's `/32`; only
  TCP 443 is public. SSH fingerprint matched AWS console output before access.
- Origins: `https://mainnet.100.21.48.23.sslip.io` and
  `https://sepolia.100.21.48.23.sslip.io`. Both TLS certificates are issued.
- Only shared TLS is running; applications await finalized contracts. A
  certificate does not establish service readiness. Networks use separate
  Compose projects, Docker networks, `/etc/zkapi/<network>` and
  `/var/lib/zkapi/<network>`. Gateways bind loopback ports 8081/8082; daemon and
  signer ports remain private. The fresh launcher uses `/data/server.db`.
- Caddy access logging is disabled, and its global error-log filter removes the
  entire request object. Two deliberate upstream failures with dummy password
  and query canaries verified that neither appears in TLS logs. No real service
  password was used in this check.
- Backend: `OpenAnonymity/zkapi` commit
  `95b022fd339a391321481d31dffa4b947954b0a6`, built from a Git archive excluding
  unrelated changes in the user's development checkout.
- Runtime image: `sha256:7e23bbb63aab5e9aa9b29fe5b72139038f03779f0cd175afe47528924bdb441b`.
- Gateway image: `sha256:1e36a24af396e90d9a40d6e8f60697b4dece3eea3de15c4120728827d54190fd`.
- Signer image: `sha256:7dee998e226f68bdf889b366777b7a90a931823016a7232b67468854cc29ea70`.

The us-west-1 launch was refused by its vCPU quota; no VM was started there.
Unused security-group and EC2 key-pair objects from that attempt were removed.
Quota-increase requests alone do not represent deployment.

## Keys and funding

Secrets and operational records are outside Git under
`/Users/mingyech/.codex/deployments/zkapi-fresh-20260930/` (mode 0700).
Each network's `keys/` contains independent owner/deployer, treasury and
challenger private keys, encrypted keystores and passwords. `server-seeds.env`
contains separate nonzero canonical protocol signing scalars. The exact fresh
runtime derived public coordinates matching both candidate profiles.

Only protocol seeds, the OA service credential, dedicated challenger keys and
Sepolia's existing shared password were installed on the VM. Owner and treasury
keys remain local. Each `operator-handoff/` contains only its treasury key and
instructions. Never print secrets or include them in images, public manifests,
source commits or frontend environments. Mainnet remains ungated.

| Network | Role | Address | Requested funding |
| --- | --- | --- | --- |
| Mainnet | Owner/deployer | `0x83f7eA47811A288f2052Bc31aaAE0803c761D156` | 0.02 ETH |
| Mainnet | Challenger | `0x661dbf996Cd2C47C7D1fa2434b6fC3DE504EFC61` | 0.01 ETH |
| Mainnet | Treasury | `0x7665Af7d8C08733A22d0ac370EE8c5e2E21379BB` | None |
| Sepolia | Owner/deployer | `0xdb4279A81B00fC0E680f0E6e88a0E2d23aB0fF7A` | 0.045 test ETH |
| Sepolia | Challenger | `0xB236c147e4c53a3bF1a18d7f63C0f2d77f25ABd8` | 0.02 test ETH |
| Sepolia | Treasury | `0xbCEc4676ae50E4D231c5f5933742bE1e0d18b43e` | None |

Each contract plan contains two zero-value creations: Groth16 adapter, then
vault after the adapter is finalized and verified. Gas estimates are 1,471,816
and 5,424,800, padded by 25%. Maximum combined deployment liability is
0.01724154 ETH at Mainnet's 2-gwei cap and 0.04310385 test ETH at Sepolia's
5-gwei cap. Unused funds remain in the owner's wallet. Challenger reserves are
separate; signer caps are 12 million gas and 5 gwei, with each dedicated account
balance also limiting expenditure.

Reviewed tools/plans are in protected `contract-tools/`. Final plan SHA-256:

- Mainnet: `fc9a7e80007a30047a2b47526c9fe71d65191e2b6550e52930a8f0fef87d473c`.
- Sepolia: `279db90297d8ac41ec9177ae743344c21a9d6a08e9b9a82d1d7f1e78d8413715`.

Follow that folder's README. Each execution submits at most one transaction and
must retain the same plan digest. Signed bytes are durably saved before broadcast
and retried unchanged. Do not regenerate keys, alter fees/nonces, or delete
journals. Existing Poseidon libraries are reused only after identical executable
code and compiler verification; narrowly parsed metadata differences are recorded.

Candidate vaults are **predictions, not deployed contracts**: Mainnet
`0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe`, Sepolia
`0x49fA19f9bdECe7A48Ebc7749fD69aD40F577590F`.

## Frontend and verification

Public branch `codex/zkapi-fresh-20260930` has implementation commit
`856a714adab16d5529dd1f25342f007dbe254d81`. Commercial's matching branch pins
that exact core in its gitlink and JSON at
`652fa818956295c9fbfbf743a5816fb04110080f`. Neither main branch was changed.
SDK `3342c95871e8422bb878ad40072687c241a68a5b` and its recovery patch remain.
See [payment configuration](ZKAPI_PAYMENTS.md#september-30-clean-reset-profile)
for the build-only wallet namespaces used for the approved clean reset.

The unpromoted Sepolia candidate is
`https://oa-wallet-eth-sepolia-6jyjo26qp-oas-projects-cbf58581.vercel.app`.
Its build records the exact public source and new namespace. The canonical
`https://oa-wallet-eth-sepolia.vercel.app` still serves the old profile. The
earlier unpromoted candidate lacked source metadata and must not be promoted.

Commercial's compiled artifact passes validation. A remote feature-branch build
was correctly refused by the Git staging branch guard; staging was not promoted.
Use its documented prebuilt workflow, or merge verified source to main only
after backend acceptance. Preserve current org/station revision metadata, saved
privately in `staging-before-build-manifest.json`, when rebuilding.

Completed validation:

- Public: 1,098 core and 752 payment tests; 12 focused build/storage tests.
- Commercial: 484 unit, 14 default-build, 14 staging-build and 19 configuration
  tests; all 10 artifact gates. Committed-tree `check:release` passes for
  `652fa818956295c9fbfbf743a5816fb04110080f`.
- Fresh Linux runtime: 72 workspace tests; 11 signer and 4 launcher tests.
- Executor: 18 offline boundary/lifecycle tests. Fresh independent reviewers
  approved the final executor/plans and both frontend changes.

Remaining: funding, finalized contracts, installing manifests/deployment blocks,
starting both stacks, direct/proxy auth and quotes, finalized bytecode/getter/
key/proof/root checks, advancing funded challengers, and frontend promotion/live
verification. No funded inference, deposit, withdrawal or live escape challenge
has been performed for this new deployment.
