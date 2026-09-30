# Fresh zkAPI deployment, 2026-09-30

**Complete: both canonical frontends use the fresh AWS deployment.**
All four contracts are finalized and independently verified. Both isolated
runtime stacks are running on the new VM, with eight configured healthchecks
healthy and both challengers advancing without pending work. Sepolia passes
23 direct and 24 canonical-proxy checks; Mainnet passes 19 direct and 20
canonical-staging-proxy checks.

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
- Both stacks and shared TLS are running: eleven containers in total. Networks
  use separate Compose projects, Docker networks, `/etc/zkapi/<network>` and
  `/var/lib/zkapi/<network>`. Gateways bind loopback ports 8081/8082; daemon and
  signer ports remain private. The fresh launcher uses `/data/server.db`.
- Caddy access logging is disabled, and its global error-log filter removes the
  entire request object. Two deliberate upstream failures with dummy password
  and query canaries verified that neither appears in TLS logs. No real service
  password was used in this check.
- A fresh review also reproduced query/client-IP disclosure in nginx upstream
  error logs despite disabled access logging. A read-only mounted nginx config
  changes only `error_log /dev/stderr warn` to `error_log /dev/null warn`.
  Its SHA-256 is
  `151b7622e710c2fd3e5a91dc70c624acf08d4f5fd5d6ea5df1e228244e47a294`.
  An isolated exact-image test passed `nginx -t` and returned the expected 502
  without logging its synthetic query/password/client IP. Request-bearing
  nginx error diagnostics are intentionally suppressed; container health and
  application diagnostics remain available.
- Use `sudo zkapi-compose mainnet ...` or `sudo zkapi-compose sepolia ...` on the
  VM. This root-owned wrapper always selects the separate project/environment,
  challenge profile, stock Compose file and
  `/opt/zkapi/gateway-privacy.override.yml`; the override mounts
  `/etc/zkapi/gateway-nginx.conf` read-only. Omitting the override would restore
  the original nginx logging behavior. Image bytes are unchanged.
- Backend: `OpenAnonymity/zkapi` commit
  `95b022fd339a391321481d31dffa4b947954b0a6`, built from a Git archive excluding
  unrelated changes in the user's development checkout.
- Remote main subsequently advanced to
  `2f018b921afbcf8b3ccbe724ae3d875bafc6b14a` with client-only recovery changes.
  Server, protocol, contracts, Docker, SDK and runtime dependency inputs are
  byte-identical. The images contain current server code while retaining their
  actual build provenance.
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
runtime derived public coordinates matching both deployed frontend profiles.

Only protocol seeds, the OA service credential, dedicated challenger keys and
Sepolia's existing shared password were installed on the VM. Owner and treasury
keys remain local. Each `operator-handoff/` contains only its treasury key and
instructions. Never print secrets or include them in images, public manifests,
source commits or frontend environments. Mainnet remains ungated.

| Network | Role | Address | Received funding |
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

Publicnode's free historical-state window expired while waiting for the second
stage to finalize: Mainnet returned an archive-token restriction, and Sepolia
reported pruned historical state. Reviewed read-only finalizers keep the original
executor, plans, signed journals and runtime RPC pins unchanged. They require
both already-signed successful creations, permanently disable signer loading,
allow only specific read methods, and compare chain IDs, receipts and exact
block hashes between Publicnode and an archive provider. Historical code/getter
reads retain their original receipt block numbers. Mainnet uses dRPC; Sepolia
uses BlockReq with serialized reads and bounded HTTP 429 backoff. Both finalizers
completed and saved immutable public deployment evidence. This is verification
transport only, with no extra transaction.

All contract transactions are successful, finalized and verified:

| Network | Contract | Address | Transaction | Block |
| --- | --- | --- | --- | --- |
| Mainnet | Verifier | `0x8e92013Dd7cc86f75b539DBD3814B2e603e0F9C1` | `0x45f2f5259476afd5f64a6a62a36c9012c3a26efcdd35b048a7fac5ae1ba43780` | 26091254 |
| Mainnet | Vault | `0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe` | `0xf753fd93c7e672f7b851f261f600e06930e502bdfd73be29ce8a065643df6985` | 26091339 |
| Sepolia | Verifier | `0xB0E621Eb4E30a94A8c108a3A22EA09fDaE40e4E3` | `0xf93ce7f74907037cba688fff7558d080493b2b1722177686eb00abeb9215540e` | 11815620 |
| Sepolia | Vault | `0x49fA19f9bdECe7A48Ebc7749fD69aD40F577590F` | `0xd7f1427d400f3cd23dd924fa6402a24244fb79ccddba52ad3a465b39f74d9d02` | 11815693 |

Final deployment fees total 0.004620641613544505 ETH on Mainnet and
0.008083156154839894 test ETH on Sepolia. Challenger reserves are unspent.

## Frontend and verification

Public branch `codex/zkapi-fresh-20260930` has implementation commit
`856a714adab16d5529dd1f25342f007dbe254d81`. Commercial pins that exact core in
its gitlink and JSON. Its initial rollout implementation is
`652fa818956295c9fbfbf743a5816fb04110080f`; the final integration
`4952ee6cfd580d0c3d919c26fee47a68b62f3ddf` preserves concurrent landing changes
through `1d7f850993508cbbd01913190e244273ec211db7`. The rollout patch remained
byte-identical across those merges. Commercial main contains the fresh profile;
public main was not changed. SDK `3342c95871e8422bb878ad40072687c241a68a5b`
and its recovery patch remain. See [payment configuration](ZKAPI_PAYMENTS.md#september-30-clean-reset-profile)
for the build-only wallet namespaces used for the approved clean reset.

- **Sepolia:** `https://oa-wallet-eth-sepolia.vercel.app`, promoted deployment
  `dpl_6uRgHg2Yx31N3L1YN8Scs48Sq6LF`, immutable URL
  `https://oa-wallet-eth-sepolia-6jyjo26qp-oas-projects-cbf58581.vercel.app`.
  Its canonical build records core `856a714`, profile `fresh-20260930`, and
  `zkapi-browser-wallet-fresh-20260930-sepolia-v1`. Browser rendering and the
  expected password gate were checked without submitting a funded transaction.
- **Mainnet staging:** `https://staging.openanonymity.ai`. Normal Git production
  deployment of `4952ee6` produced `dpl_8mn2hKGSGoU7fP77buMg3g32a2No` and
  passed nine route checks, eight served asset hashes and twenty backend proxy
  checks. Release integration run `36744346907` and staging-live run
  `36744461504` both succeeded. The subsequent docs-only commit
  `cd0c16c28b83f7aa66277a79ecdf6d2f4f2d472b` is now canonical in deployment
  `dpl_F7s3BM66yeENDRx6ERBLPgScvFn6`; its release integration run `36745113036`
  and staging-live run `36745228290` also succeeded. Core/profile pins, all eight
  served asset hashes, backend configuration and health are unchanged from the
  fully checked release. `/build-manifest.json` is authoritative for later
  production source revisions.
- Mainnet wallet storage is `zkapi-browser-wallet-fresh-20260930-mainnet-v1`.
  Both candidates' actual served lazy SDK chunks were checked to contain their
  intended new database names. Existing local notes and funding signers remain
  retained in their previous stores/scopes.
- OA org/station provenance is unchanged: org `7e867ae28ed2e01cd31a0fcb8ed30fe2334b63ba`
  clean; station `ecd0c10b1feda33a941c248b3f6f14ecc576f17a` with its existing
  dirty flag. Git staging builds carry this metadata from the canonical manifest.

Historical Commercial prebuilt candidates `dpl_2DgJ4hEyFkGRVsphf6zFdrRxyvPu`
and `dpl_4pJLCh9C8Ly4TyNw8xSvpbNHcfhv` passed validation but were **never
promoted**: concurrent landing releases were merged before the normal Git
cutover. Do not promote those older snapshots. The earlier feature-branch source
build was correctly refused by the main-branch guard. A generated team-project
alias can change even with `--skip-domain`; inspect the actual canonical hostname
before and after promotion.

Completed validation:

- Public: 1,098 core and 752 payment tests; 12 focused build/storage tests.
- Commercial: full committed-tree `check:release` passes for the final merged
  `4952ee6` source, including unit/default/staging checks and all ten artifact
  gates. Concurrent landing files were independently compared byte-for-byte
  against their latest main-branch versions.
- Fresh Linux runtime: 72 workspace tests; 11 signer and 4 launcher tests.
- Executor: 18 offline boundary/lifecycle tests. Fresh independent reviewers
  approved the final executor/plans and both frontend changes.
- Read-only finalizers: four Mainnet and nine paced-Sepolia boundary tests;
  original executor, plans and signed journals remain unchanged.
- Live checks independently compare finalized receipts, runtime bytecode,
  immutable parameters, getters, signing coordinates, API/indexer roots,
  authentication, finalized oracle quotes, proving hashes and private-route
  rejection. Both canonical frontends passed their complete proxy checks.
- Operational snapshots show all eleven containers running, eight configured
  healthchecks healthy, and both dedicated funded challengers advancing by
  nineteen blocks with no pending obligations. Docker is enabled at boot;
  data/checkpoints persist in the separate per-network directories.

Protected evidence is in `public-verification/`, `contract-tools/<network>/`,
`operational-snapshot-{before,after}.json`, and the Vercel verification records
under the private deployment root. Old VMs are retained. No funded inference,
deposit, withdrawal or live escape challenge was performed for this rollout;
read-only acceptance does not establish those lifecycle outcomes.
