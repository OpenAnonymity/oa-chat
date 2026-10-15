# Real-shape fixtures of the revision 3 (0.2.0) zkAPI SDK

Data produced by the REAL revision 3 SDK modules, so that host code is tested
against what the SDK actually emits and not against a shape someone remembered.
This directory holds **data only**: no SDK code is copied here, and the files
are not hash-pinned (unlike `test/fixtures/zkapi-sdk-v2-fixture/`, which is a
package fixture and must not be edited).

| File | What it is |
|---|---|
| `snapshots.json` | Thirteen whole client snapshots (`ZkapiClient.snapshot()` plus the runtime slot the host's facade merges), and the SDK's error objects |
| `oracle-vectors.json` | Seeded inputs and the SDK's own outputs for `deriveExpiryRecords`, `nativeUnitsForUsd`, `nativeUsdMicros` and `CHAT_SPENDING_TIER_USD` |
| `wallet-db-v2.json` | A wallet database written by the real revision 3 store, as a fake-IndexedDB dump, and the SDK's public views of it |
| `regenerate.mjs` | The generator (person-run, see below) |

## Provenance

- Generated from the SDK `0.2.0` of the local zkapi repository's `v0.2` branch
  at `4b955d9` (asset manifest `sourceRevision`
  `e9951bacd62c6ae927d06196ad78b45db4f9c492`, circuit `zkapi-v2-concession-v1`,
  setup `dev`). The revision is not published, so the package has no 40-digit
  pin in this repository yet; every file therefore records, under
  `source.files`, the SHA-256 of each SDK module it was generated from, so a
  changed SDK is detected by comparing those, not by trusting a version string.
  An earlier generation came from the `82c8504` snapshot; the only differences
  are additive: a `gasless` object on every snapshot (`supported: false` while
  the profile pins none) and the sponsored-withdrawal fields of a withdrawal
  record (`fee_payer: "wallet"`, `payout`, `transit`, `user_op_hash` and
  `user_op_phase`, null for a wallet-paid exit).
- The proof setup in `source` is the SDK snapshot's own (`dev`). The host
  accepts `mpc-1` and `dev` on every network (the single-party development
  setup is reported, not blocked); the SDK package's own build accepts `dev`
  for chain 1 since `4b955d9` (the `82c8504` snapshot refused it). The fixtures drive SDK runtime code only and never pass
  through the host's profile validation.
- Hosts, addresses and keys are the SDK's placeholders or the host fixtures'
  (`test/zkapi/_registryFixtures.mjs`). The three deployments of `deployments`
  line up with that file: `current` is the activated registry's second version,
  `previous` the shipped note-bound deployment, `retired` one no row names.
- Every private field of a seeded note, plan or journal carries a `SECRET-`
  marker (`SECRET-secret_s`, `SECRET-proof`, ...). A reader that projects
  public fields must never forward one: tests assert that.

## The clock

`generatedAtMs` is `2026-11-15T12:00:00Z` (the same anchor as
`NOW_MS` in `_registryFixtures.mjs`), a constant and not the wall clock. The
generator freezes `Date` at that instant, so every `expiry_ts`,
`must_initiate_by`, lock instant and receipt date in the files is relative to
it and regeneration is byte-reproducible. Tests inject `now = generatedAtMs +
offset`; none may read `Date.now()` against these instants, or the fixtures
become time bombs.

## Units (the SDK mixes them)

- Milliseconds: `config.exit.{must_initiate_by, escape_at, lock.since,
  lock.releasable_after}`, `withdrawals[].{expiry, must_initiate_by}`,
  `unresolved_requests[].{created_at, escape_at}`, and the `data` of
  `request_settlement_pending` (withdraw shape).
- Seconds: `exit_locked.data.releasable_after`,
  `exit_release_pending.data.{releasable_after, must_initiate_by}`,
  `ownership_proof_wait.data.retry_after`, `note.expiry_ts`, `valid_until`.
- Amounts are gwei. Counts and balances are JS numbers (`credited_amount` is a
  number, or `null` for evidence `vault_credit`); bounds are decimal strings.
  BigInts are written as strings.

## `snapshots.json`

```
generatedAtMs, source, deployments, settlementWindowSeconds
scenarios.<name> = { description, clientSnapshot, runtime }
errors.<name>    = { producedBy, handSeeded, name, status, code, data, message }
```

The scenarios (names are stable; other tests refer to them):
`service_missing`, `service_changed`, `service_legacy` (three exit-only
causes), `kit_never_exported`, `kit_out_of_date`, `near_expiry`,
`just_outside_near_expiry`, `unresolved_request_settlement_wait`,
`mutual_lock_with_ownership_proof`, `escape_lock_released_proof`,
`device_not_newest_evidence`, `withdrawals_alert_credited_defeated` (own
records), `other_deployments` (other deployments' open and credited records).

`clientSnapshot` is what a host adapter receives; `runtime` is the in-memory
slot (`runtime.runtime`) the facade spreads in as `{ ...clientSnapshot, runtime }`.
Normalizers must reduce it to booleans, ids, times and amounts.

## `oracle-vectors.json`

`deriveExpiryRecords` entries are `{ nowMs, deposits, withdrawals, output }`
(seeded with a fixed PRNG; includes the escape clause and `payoutCredited`);
`nativeUnitsForUsd` and `nativeUsdMicros` entries are `{ label, quote, usd |
units, output, error }` for quotes with `answer` from 1 to 1e18 and ETH from
$300 to $200,000.

## `wallet-db-v2.json`

`dump` is `{ version, stores }` as `env.idb.dump()` returns it, so
`env.idb.seed(databaseName, fixture.dump)` loads it. It spans three
deployments: returned, set-aside, claimed-by-treasury and expired notes of the
legacy vault; credited, claimed, alerted and defeated escapes and the slot note
of the current one; one returned note of a retired one; and the request-journal
and request-evidence archive records (keys prefixed `request-journal:` and
`request-evidence:`), which hold proofs and must never be read by a history
view. `sdkViews[deploymentId]` is the SDK's own public projection (deposit rows,
expiry records, other deployments' open records and credits). The dump is
taken after those reads, because the SDK back-fills a deposit row for every
note it finds; that is the state of a database whose deployments were each
loaded once.

## Hand-seeded versus SDK-emitted

| Data | Origin |
|---|---|
| `clientSnapshot.config` (exit summary, service, other-deployment lists, unresolved requests, prepared-withdrawal summary, funding) | SDK-emitted: the real `BrowserWalletRuntime.init()` and `snapshot()` |
| `clientSnapshot.withdrawals[]` derived fields (`expiry`, `must_initiate_by`, `exit_deadline_near`, `challengeObserved`, background flags) and the stripping of private fields | SDK-emitted |
| `clientSnapshot.deposits[]` | SDK-emitted (the store's own public projection) |
| Own record fields (`payoutAlert`, `payoutCredited`, `creditedAmount`, `payoutCreditEvidence`, `payoutClaimed*`, `deviceNotNewest`, `concededFinal`, ...) | Hand-seeded values written through the real `putBrowserWithdrawal`; names and types follow what the SDK's own code writes (`closedWithdrawalPayout`, `claimEscapePayout`) |
| `clientSnapshot.wallet` | Hand-seeded: the proof worker's `walletStatus()` is WebAssembly; this is its shape |
| `runtime` slot: note state, plans, journals | Hand-seeded (placeholders and `SECRET-` markers); exit locks are built by the SDK's own `zkapiExitPolicy` functions with hand-chosen inputs; request archive records by its own builders |
| `errors.*` | SDK-emitted, every one: raised by the runtime's own code paths over the seeded wallet (`handSeeded: false`). `legacy_incompatible_proof_circuit` is the installed legacy SDK's own refusal |
| Operator answers (served manifest, tree snapshot, evidence, proof worker) | Stubbed in the generator: an operator that answers at once or never |
| `oracle-vectors.json` inputs | Hand-seeded by a fixed PRNG |
| `oracle-vectors.json` outputs | SDK-emitted |
| `wallet-db-v2.json` records | Hand-seeded inputs written by the real store functions (`commitBrowserWallet`, `detachBrowserClosedWithdrawal`, `updateBrowserWithdrawal`, `parkBrowserWithdrawal`, `recordBrowserExpiryClaims`, `archiveBrowserWallet`, `putBrowserRequestArchive`); the stored shapes, sanitizing and back-fill are the SDK's |

## Regenerating

```bash
node test/fixtures/zkapi-v2-real-shapes/regenerate.mjs <path to the zkapi checkout> # or its sdk directory
node test/fixtures/zkapi-v2-real-shapes/regenerate.mjs <path> --check               # exit 1 when a file would change
```

Run it when the pinned SDK revision moves, review the diff (a changed shape is
the point), and commit the result with the change that handles it. It imports
only plain SDK modules (it never runs an SDK script, package manager or git),
uses this repository's `test/zkapi/_fakeIndexedDb.mjs`, and reads the
installed legacy SDK from `node_modules` for the one legacy error (override
with `--legacy <sdk directory>`).
