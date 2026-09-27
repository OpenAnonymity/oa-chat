# Native ETH deployment work, 2026-09-27

Status: **in progress, not published or live-accepted**. Existing ERC20 browser
origins and services are preserved for matching wallet recovery.

The native protocol work is isolated in `codex/native-eth-wallet` in the
`zkapi-EF-collab` repository. Native implementation commit `abfd3a7` passed its
initial independent review, but the deployment audit found inherited legacy
protocol weaknesses. The rollout is therefore incorporating the separate
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
compiled source. Publication/funding still waits for this vault to finalize
and for the isolated backend/challenger to pass live checks.

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

The reviewed native Sepolia SDK configuration is committed at
`ad2b134d36222cc84f6105b29c52ce878516213a` and installed by immutable Git pin
in both app package files. Mainnet retains its explicit migration guard.

The OA Vercel projects `oa-wallet-eth-sepolia` and `oa-wallet-eth-mainnet`
are created and linked locally; no native frontend is published yet.

## Browser verification completed

The app diff passed independent review. Full app tests passed 886 core and
396 payment tests. A local actual-browser fixture verified the normal address
flow without password/backup controls, USD edits through refresh renders,
restored address and exact principal after full browser closure, zero automatic
submissions on simulated receipt, and one submission after explicit Next.
The fixture used simulated price/RPC/SDK submission and is **not live Sepolia
end-to-end evidence**. The revised SDK separately passed all 272 tests with
matching note-bound WASM and proving assets.

Remaining: TLS origin verification, finalized replacement Sepolia vault,
isolated runtime startup, immutable native SDK pins, both frontend
builds, live Sepolia funding/chat/settlement/withdrawal/recovery acceptance, and
the explicit Mainnet deployment/funding decision.
