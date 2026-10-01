# Challenger verification on September 30

**A complete local v2 lifecycle also passed at 18:47 MDT on September 30.**
The repeatable `npm run test:e2e:v2` process starts from a real genesis deposit,
uses the real HTTP API for two leases and signed settlements, challenges a stale
intermediate state, then closes the latest state with a real withdrawal proof.
Provider inference/key management and the oracle are mocked, as requested.
The runtime scenario took 15.355 seconds after build preparation; its challenge
succeeded after one chain second with the 24-hour period unchanged.

See the [reproducible process](https://github.com/OpenAnonymity/zkapi/blob/e8fd95f47a0fc13e86076fb00e6a0ae13bd03ca2/docs/v2-acceptance.md).
The passing result is retained privately in the zkapi checkout at
`.zkapi/acceptance/2026-10-01T00-46-50.568Z-5d79e70c/result.json`; it is
gitignored. Run the documented command to reproduce the evidence.
This run used source `0cf3948d51f696c1b029dc716e0b7cf95b876c08`; the tested server,
indexer, challenger and protocol sources are unchanged from the earlier
`95b022f` test target. The separate client daemon has changed and is not covered.
Its fixture is a genuine deposit and two verified settlements; the synthetic
prior-state limitation in the earlier standalone challenger test below does
not apply to this complete lifecycle run. Browser/CLI host persistence, deployed
signer configuration, actual external-provider behavior and public networks
remain outside its scope.

**The local daemon end-to-end test passed at 23:18:29 UTC.** The unmodified
challenger and indexer processed actual events on a fresh Anvil chain and mined
successful challenges using real Groth16 proofs. Both the finalized-request and
active-unsettled-lease cases passed, including failed-submission restart recovery.
The normal 24-hour challenge period remained unchanged; successful challenges
occurred after 2 and 4 seconds of local chain time.

**Live Sepolia end-to-end acceptance remains incomplete.** Earlier read-only
checks confirmed the fresh Sepolia challenger was running and advancing. No live
funds were transferred, live leases issued or Sepolia transactions submitted by
these attempts. The local test uses synthetic accounts and loopback services.

## The challenge does not require a one day wait

The fresh vault is `0x49fA19f9bdECe7A48Ebc7749fD69aD40F577590F` on chain
11155111. A live getter returned `challengePeriod = 86400` and `paused = false`.
The contract permits challenges before the deadline; the wait applies only to
finalizing an unchallenged withdrawal. The deployed delay was not changed.

Source inspected: `OpenAnonymity/zkapi@2f018b921afbcf8b3ccbe724ae3d875bafc6b14a`.
Its server and protocol source matches deployed backend
`95b022fd339a391321481d31dffa4b947954b0a6`. See
[the contract conditions](https://github.com/OpenAnonymity/zkapi/blob/95b022fd339a391321481d31dffa4b947954b0a6/protocol/contracts/src/ZkApiVault.sol#L162-L204).

## Checks completed

- The deployed Sepolia challenger was running on image `zkapi/aws:95b022f`.
  Server, indexer, gateway and signer containers reported healthy. Its scan
  checkpoint advanced from block 11817766 to 11817788, with no pending work.
  Its dedicated signer had 0.02 test ETH and no pending transaction.
- The existing `ZkApiVaultGroth16Test` suite passed all three tests: historical
  request challenges after an unrelated deposit, challenges after an unrelated
  close, and rejection of a rewritten archived request root.
- An isolated copy of that suite also passed all three tests. The two successful
  challenge cases were changed to assert the deadline is exactly 24 hours ahead
  and call the challenge without advancing the test clock. They then assert the
  clock is unchanged, the note is Active, the pending withdrawal is removed and
  the consumed nullifier remains consumed. The original rewritten-root rejection
  is retained. Later clock advancement tests that the challenged withdrawal
  cannot finalize; it is not needed for challenge success.
- A separate reviewer inspected the copied test diff and contract conditions and
  approved this limited interpretation. These tests construct local contracts
  using real proof fixtures. They are neither a Sepolia fork nor a test of the
  live daemon's transaction submission.

Both Solidity runs used:

```sh
forge test --match-contract ZkApiVaultGroth16Test -vv
```

The first ran in the protocol repository; the immediate variant ran in the
protected deployment bundle's `e2e-challenger/local-immediate-tests/` directory.
No tracked protocol implementation or test file was changed.

## Preflight and execution limits

Live preflight initially returned HTTP 409 `native_quote_expired` from the
authenticated billing-quote endpoint. At 22:57 UTC, the finalized oracle round
was last updated at 21:38:48 UTC and expired at 22:53:48 UTC under the configured
4,500-second maximum age. A newer round, updated at 22:40:12 UTC, was visible at
the chain head but not at the sampled finalized checkpoint. At 22:58:40 UTC,
the quote endpoint returned HTTP 200 with that newer round. No freshness or
finality setting was relaxed. This was a transient preflight failure, not a
challenger failure; the complete deployment preflight was not rerun afterward.

The focused Rust daemon regression command was attempted:

```sh
cargo test --release -p zkapi-serverd challenge_service::tests --lib -- --nocapture
```

Compilation stopped because the Mac's configured Xcode license was not accepted.
No daemon tests executed in this attempt, and the license was not accepted on
the user's behalf.

Automatic safety review rejected the subagent preparing the isolated test-wallet
funding helper, citing possible cybersecurity risk. Live preparation was stopped;
no alternative live mutation route was used. A partial, unexecuted policy module
remains in the protected `e2e-challenger/` directory and is not an approved
execution tool. No test signer or wallet was created.

The missing acceptance evidence is still a real escape initiation followed by
the deployed daemon's own successful challenge transaction, canonical event and
state checks, and ordinary cleanup. The local results establish that the
24-hour deadline need not delay that test; they do not close that live coverage
gap. Fresh-deployment live challenge acceptance therefore remains outstanding.

## Entirely local daemon end-to-end result

The isolated worktree is
`/Users/mingyech/.codex/local-tests/zkapi-challenger-20260930/source`, pinned to
`95b022fd339a391321481d31dffa4b947954b0a6`. Production implementation files are
unchanged. The original protocol checkout and deployed files were not changed.

The earlier harness and fixture helper are documented locally in
`source/docs/local-challenger-e2e.md` under that isolated test directory.
Its private run evidence, including exact daemon RPC calls, receipts, SQLite
databases and checkpoint snapshots, is retained alongside
`runs/2026-09-30T23-16-59.755Z/result.json`. These earlier files are not
published; the complete lifecycle command linked above is the shared process.

| Evidence supplied to challenger | Result | Challenge after initiation | Submission and restart checks |
| --- | --- | --- | --- |
| Finalized request, archived 256-byte proof | Passed | 2 chain seconds | One successful transaction; no duplicate attempt after completed restart |
| Active issued lease, no usage receipt or finalized transcript | Passed | 4 chain seconds | Injected RPC failure before broadcast; process restart retained nonce/calldata; one successful transaction across six attempts; no duplicate attempt after completed restart |

Both cases use the production request processor's acceptance path to write a
real SQLite database. The finalized case also runs the production lease-retirement
path. The helper generates fresh request and withdrawal proofs from the checked-in
v2 setup; it does not insert fabricated database reservations or transcripts.

The driver deploys the actual Poseidon library, vault and Groth16 verifier, makes
deposits, then submits a stale-state escape. An unrelated deposit changes the
root after the archived request. The real indexer reconstructs the current
zero-slot path, and the real challenger discovers the event, loads the durable
evidence, verifies and simulates the original proof, and submits its own
transaction. The driver does not directly call the challenge function.

Assertions verify the canonical challenge receipt/event, all 12 original request
inputs and proof bytes, restored Active note and expected root, removed pending
withdrawal, still-consumed nullifier, and unchanged vault/destination balances.
The checkpoint remains pending before two confirmations and clears afterward.
Immediate unchallenged finalization fails. Each successful challenge used
6,248,115 gas; no time jump to the deadline or shortened challenge period was used.
All spawned processes and local listeners were shut down after the run.

Scope: production request-processor methods are called directly, so server HTTP
routing is not covered. Oracle and provider management responses are loopback
mocks; Anvil's local unlocked account substitutes for the AWS signer. The prior
900,000-gwei signed state of the 1,000,000-gwei deposit is a synthetic bootstrap
fixture, not a tested earlier inference history. Public-network reorgs, external
provider behavior, signer configuration and live Sepolia acceptance remain outside
this result. The retry test injects failure before broadcast; it does not establish
recovery from a transaction accepted by the chain but missing its RPC response.

The successful command was:

```sh
node scripts/local-challenger-e2e.mjs target/debug
```

The contracts built with `forge build`. Rust binaries were rebuilt from the
pinned source using installed standalone Command Line Tools and the macOS 15.4
SDK. Initial builds ran out of disk space; an APFS copy-on-write clone of a
compatible existing dependency cache plus package-specific disabled debug info
allowed the build to finish without deleting user files or accepting the Xcode
license. A first runtime attempt exposed an unlinked Poseidon library in the
new test harness; that harness fix was reviewed, then the complete fresh run above
passed. Neither issue required a production implementation change.
