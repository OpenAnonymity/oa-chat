# Sepolia password rollout, 2026-09-29

The existing Sepolia ZKAPI service now requires a shared password. The protected
API is `https://52.52.207.206.sslip.io`; the web client is
`https://oa-wallet-eth-sepolia.vercel.app`. Mainnet remains unchanged.

## Deployed web client

- Web build: `4NNJCZOR`, source `a9177d9b6b42800e5967e32a48be4d50ce23961a`.
- Deployment: `dpl_7nqcxodbiYkDt1nutrssUjurucqY`.
- Browser SDK: `3342c95871e8422bb878ad40072687c241a68a5b`.
- Wallet recovery patch SHA-256:
  `fc6c4da9412b533b77a6b7abb9921ec4162c393cd056c40db489d334434fe385`.

All 492 integrity-manifest entries match the local reviewed build. The final
same-origin authentication suite passed all sixteen checks with the pinned SDK.
The live browser verified wrong-password feedback, cleared input, Escape
cancellation, focus after subsequent wallet refreshes, and focus after closing
the wallet, with no console errors. Authentication remains in memory only.

This build retains the concurrent browser wallet recovery repairs. Independent
review found and fixed a note replacement race while password entry awaited
completion; both SDK source branches reject the changed note before preparing
withdrawal. The combined web suite passed 1,097 core and 752 payment tests;
all 318 patched stable-SDK tests and both network builds passed. Only Sepolia
was promoted. The SDK-only follow-up does not change the deployed Rust server
or the immutable CLI 0.4.1 release.

## Deployed server

- Source: OpenAnonymity/zkapi `ead4bfd11be72972f7dfa0f794df88e2ff7ae0c3`
  ([PR 2](https://github.com/OpenAnonymity/zkapi/pull/2)).
- Instance: `i-0bc89435dd584924f`, account `427880590996`, `us-west-1`.
- Server image: `sha256:0f2b10c5487be545ef0f5a69b440997be39723b1dba49813a27dce6747fb3d39`.
- Gateway image: `sha256:1d734d12ef2f67ce4653c0e2886becb271b9c0d7304f4b7e8877227f973e5baf`.
- Vault: `0x999F40773e47f7e07f435C0CC69225c409B64329`, chain `11155111`.

Only server and gateway containers were recreated. Indexer, challenger, signer
and TLS containers continued running. The gateway's explicit allowlist gained
only `/v2/auth`. Its existing header forwarding and disabled access logs remain.
The deployment launcher removed the obsolete `--auth-scheme state-anchor` and
`--provider metered` options; the new runtime is native-only/state-anchor.

The launcher preserves `/data/zkapi-server.db`, which differs from the generic
Docker launcher's default filename. Signing seeds, OA org credential, data
mount, vault, cap `50000`, proof setup, RPC/feed, feed decimals `8`, maximum
price age `4500`, lease TTL `300`, settlement grace `5`, and polling interval
`2` are unchanged. Both networks' public manifests are byte-identical to their
pre-rollout copies. The new server's proof hashes match the deployed circuit.

The host's legacy Docker builder required plain `COPY` plus `RUN chmod 755`
in place of `COPY --chmod=755`; file contents and executable permissions are
unchanged. The final operator image contains the existing deployment launcher
with only the two obsolete options removed.

## Password and rollback

The generated password is outside Git in the owner's private deployment folder
`/Users/mingyech/.codex/deployments/zkapi-sepolia-auth-20260929/sepolia-password`
(mode `0600`, enclosing directory `0700`). On the host, it is configured through
root-owned `/etc/zkapi/server.env` and supplied only to the server container. It is
absent from build configuration, images, public manifests and source files.

Root-owned backups are under `/root/zkapi-auth-20260929` on Sepolia. They include
configuration, environment, container metadata, and a consistent SQLite backup
created with the SQLite backup API. Integrity checks passed before and after
rollout. Normal rollback restores image/config/environment; do not overwrite
new lease or challenger updates with the older database snapshot. Authentication
rotation uses the same environment field and recreates only the server.

## Verification

Sixteen checks passed at each of the direct API origin and the web client's
`/zkapi-deployment/` proxy: public health/attestation/indexer, unauthenticated
service reads and mutations, wrong and duplicate credentials, CORS preflight,
actual browser SDK authentication and authenticated billing quote. Rejected
requests return `401` without invoking protocol operations; authenticated API
responses retain `Cache-Control: no-store`.

The CLI's real password loader/preflight rejects missing/wrong credentials and
accepts the generated password. A local 0.3.3 bundle starts the matched bridge
version 4 companion and retrieves a verified native ETH quote through the real
Rust transport. Missing/wrong passwords stop before companion/state creation.

After integration with the current config/serve CLI, an isolated 0.4.1 build
passed ten live PTY/configuration checks: password-menu availability, hidden
input, rejection/retry, owner-only save, restored terminal echo, restart
guidance, and missing/wrong-password rejection before runtime startup. The
action changed no config, wallet or funding state and started no daemon.

The public [CLI 0.4.1 prerelease](https://github.com/OpenAnonymity/oa-chat/releases/tag/daemon-v0.4.1)
is tagged at `96c08c6e6ed68adac250c68048e86b985e2c4020`. All four native builds,
assembly and all four package checks passed in
[CI 36640318697](https://github.com/OpenAnonymity/oa-chat/actions/runs/36640318697).
All twelve public downloads match the verified artifacts and source provenance.
The public HTTPS installer and reinstall passed on macOS ARM64, preserving
private state, modes and the previous bundle without starting setup or services.
The default user installation was not changed. See the
[published release record](https://github.com/OpenAnonymity/oa-chat/blob/de53408c20b101d1c1597730a3f065980b3e9c37/daemon/packaging/validation/daemon-0.4.1-release-20260929.json).

The live browser shows the password entry control, clears rejected input,
reports the rejection, and cancels safely. The challenger checkpoint advanced
from `11810451` to `11810460` with no pending obligations. All defined container
health checks passed; the unchanged Mainnet endpoint remains healthy and ungated.
Server, gateway and TLS logs contain no submitted password.

These acceptance checks are read-only: no deposit, new provider key, inference,
settlement or withdrawal was performed. Earlier funded native ETH acceptance
is recorded in [the fresh deployment report](ZKAPI_FRESH_DEPLOYMENT_20260928.md).
See [browser behavior](SEPOLIA_AUTH.md) and
[CLI instructions](https://github.com/OpenAnonymity/zkapi/tree/main/zkapi-clientd/docs/CLI_ZKAPI.md) for client usage.
