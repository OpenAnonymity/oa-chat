# zkAPI protocol versions (2026-10-13)

**Status: the versioning machinery and the ten host behaviors version 2 needs
are implemented; version 2 is still a dormant `pending` row and cannot be
activated yet.** One frontend can carry more than one zkAPI protocol generation
("version") side by side. Today the registry has version 1 `active` and version
2 `pending` on both networks, so the production app is today's app
([Dormant means identical](#dormant-means-identical) says exactly what that
covers). Version 2 (circuit `zkapi-v2-concession-v1`, SDK `0.2.0`) has its ten
required host behaviors implemented, tested and listed in `WIRED`
([11.1](#111-protocol-wiring-requiredwiring)), so wiring no longer holds it
back. What does is not in this repository
([11.4](#114-what-still-keeps-version-2-pending)): a published SDK revision
that ships a deployed profile (the `0.2.0` snapshot's profiles are
placeholders), a recovery patch for that revision that provides the SDK half of
the withdrawal recheck
([11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)), and the
operator's finalized manifest and schedule. Activation is therefore a reviewed
data change plus an SDK pin and a patch
([Activate a new version](#activate-a-new-version)), not new host behavior.

**Sponsored withdrawals** (paying the network fee of a withdrawal out of the
withdrawal itself, over ERC-4337) are implemented as an optional part of the
successor family and are dormant in every shipped build: they appear only when
a reviewed profile pins the paymaster, factory and relay of a deployment. Their
privacy decision, signer rules, route and recovery behavior are in
[11.7](#117-sponsored-withdrawals-the-network-fee-paid-from-the-withdrawal).

**Proof setup.** The host accepts two proof setups for a version 2 deployment,
`mpc-1` (the multi-party ceremony) and `dev` (the single-party development
setup), by one rule on both networks. That is an owner decision and the
limitation is noted, not blocked: whoever holds the toxic waste of a `dev` vault's
keys can forge proofs, and a vault on those keys cannot later be switched to
`mpc-1`. The `0.2.0` snapshot's bundle is `dev`. What this host does, which
gates elsewhere still refuse it and what moving later costs is in
[Single-party development proof setup: known limitation](#single-party-development-proof-setup-known-limitation).

This guide describes the source as of 2026-10-13. Where this guide and the code
differ, the code is what the build and the app do.

This is the operator and engineer guide. It covers the registry, the build, the
runtime, the deposit-closing layers, the upgrade experience, storage keys,
privacy notes, runbooks, the protocol wiring and what remains before
activation, and the decisions taken. The base payment behavior stays in
[ZKAPI_PAYMENTS.md](ZKAPI_PAYMENTS.md); the privacy model is in
[PRIVACY_MODEL.md](PRIVACY_MODEL.md); the wallet recovery boundaries are in
[ZKAPI_RECOVERY_REVIEW.md](ZKAPI_RECOVERY_REVIEW.md); the living handoff log is
[APP_STATE.md](APP_STATE.md).

**Nothing in this repository runs a check automatically.** There is no CI
configuration here. Every command this guide names (`npm test`, the registry
check, the builds) is run by a person before merging; where the guide says a
change "fails", it means the command fails when it is run.

Upstream material this guide relies on (OpenAnonymity/zkapi, `0.2.x` line, read
from a local checkout because its commits were not on GitHub when this was
written): `docs/migration-concession-vault.md`, `sdk/README.md` and
`docs/versioning.md`. Where this guide says "upstream" it means those files; the
[proof-setup limitation](#single-party-development-proof-setup-known-limitation)
also cites the same checkout's `sdk/build.mjs`, `demo/contracts/script/`,
`protocol/rust/crates/zkapi-proof/`, `docs/design/concession-exit.md` and
`docs-site/` by path and line.

## Revision-4 Sepolia candidate

The October 17 candidate adds version 3, adapter `concession-v2`, circuit
`zkapi-v2-concession-v2` and vault revision 4. It is pending on both networks
until reviewed deployment pins are installed. The current shipped registry has
version 2 active and version 1 exit-only on Sepolia; Mainnet retains version 1
active and version 2 pending. The older status description below is historical.

The new family shares concession lifecycle and recovery semantics, adding
`deposit-activation` wiring. A deposit records its note; an operator proof later
activates it for requests. Pending activation does not prevent a wallet-funded
exit. The host displays activation from the SDK snapshot without adding a new
poller, event replay or client-side tree reconstruction. Unknown status is not
presented as ready. A paused vault does not display an immediate-exit promise.

Revision 4's exit tuple replaces the old root/leaf public inputs with the stored
registration commitment and packed amount/expiry. The adapter pins the new
mutual/escape selectors, 27 calldata words, byte offset 576 and proof length 256;
the local funding signer still checks note, destination and value before signing.
The SDK pin is `8f64e7c335e6a19a1180865a7835044d706bfade`. Its native confirmed
wallet withdrawal identity checks are registered as `wallet-recovery-v3`; its
host provider policy is `provider-verification-v3`, with exact file hashes.
Recovery classification also includes the SDK's new deposit-retry helpers.

Activation requires a finalized Sepolia manifest and profile published in a new
SDK pin (the current package profile is still `not_deployed`), proof and runtime
hash checks, an operational funded activator/challenger, and verification of the
built artifact and public routes. Change only Sepolia version 2 to exit-only and
version 3 to active, preserving old services and wallet stores. Mainnet version
3 stays pending. No production frontend or Mainnet deployment is part of this
candidate. The proof setup is single-party `dev`, as recorded in its manifest.

Sponsored withdrawals stay disabled (`gasless: null`). The inherited SDK
prepared-UserOp resume/claim paths do not fully enforce the confirmed operation
identity; this review does not authorize enabling that feature. Wallet-funded
withdrawal checks and fee estimates are covered by the new SDK tests.

Tests: `zkapi-proved-activation.test.mjs` covers profile pairing, sanitized
activation UI, real SDK calldata against an independent ABI encoder and recovery
classification. `provider-verification-v3.test.mjs` exercises actual SDK startup,
policy hooks, cancellation and cached-key rechecks. The provider test applies its
pinned patch explicitly while the version is pending, so a fresh install is
covered before postinstall begins treating the row as live.

## Contents

1. [Purpose and non-goals](#1-purpose-and-non-goals)
2. [Concepts](#2-concepts)
3. [Registry](#3-registry)
4. [Build](#4-build)
5. [Runtime](#5-runtime)
6. [Deposit closing](#6-deposit-closing)
7. [Upgrade UX](#7-upgrade-ux)
8. [Data and storage keys](#8-data-and-storage-keys)
9. [Privacy and security notes](#9-privacy-and-security-notes)
10. [Runbooks](#10-runbooks)
11. [Protocol wiring and what remains before activation](#11-protocol-wiring-and-what-remains-before-activation)
12. [Known limitations and decisions taken](#12-known-limitations-and-decisions-taken)
    - [Single-party development proof setup: known limitation](#single-party-development-proof-setup-known-limitation)
13. [Test map](#13-test-map)

## 1. Purpose and non-goals

**Purpose.**

- Let one frontend serve a user whose private balance sits on an older protocol
  generation and a user who is new, at the same time, from the same origin.
- Send every new deposit to exactly one version (the deposit target) and let
  older versions drain: chat, close and escape keep working on them.
- Make a new deployment of a known protocol family a registry row, and a new
  family one adapter module plus a row. (A family with mandatory host behaviors
  lists them as `requiredWiring`; its row can go live only when the host has
  implemented, tested and declared each of them, [11.1](#111-protocol-wiring-requiredwiring).)
- Guide a holder of an older version through the only possible move: withdraw
  the balance, then deposit again.
- Say plainly what the protocol's exit rules mean for the balance: a service
  pause, a chat still settling, a balance another device used, a payout the
  contract only credited, an exit kit ([7.6](#76-exit-state-notices)).
- Say plainly what it means when a version's service does not start while this
  browser holds a balance of that version: the balance is saved here, it is
  neither empty nor given up, and the one thing to do is reload
  ([5.10](#510-a-balance-the-page-holds-and-cannot-read)).
- Keep today's behavior, emitted SDK assets, wallet database and routes until a
  version is activated ([Dormant means identical](#dormant-means-identical)).

**Non-goals.**

- It is not a migration of notes. A balance cannot move between versions; the
  protocols share no state. An upgrade is two public Ethereum transactions.
- It is not an operator tool. It does not deploy vaults, run stacks or hold
  keys. It relays operator announcements it cannot compute (day 0, close of
  admission, stuck escapes) as reviewed registry data.
- It does not act on its own. It never withdraws, deposits, signs, gives up a
  balance, exports a kit or reloads without a user gesture. The one automatic
  write is the boot-time discard of a provably unused deposit draft
  ([5.5](#55-host-writes-to-the-wallet-slot)).
- It has no per-user rollout. There is no URL parameter, environment kill-switch
  or flag that picks a version; closing a version is a registry change.
- It does not decide what the SDK decides. The SDK enforces its own exit rules
  (a settling chat, an ownership proof, a release time, a near-expiry cutoff);
  the host explains and discloses them and never pre-blocks an exit on its own
  reading of them.
- It does not restore a balance that was given up ([7.9](#79-giving-up-a-zero-or-dust-balance)):
  there is no in-app undo, only a tested support procedure
  ([ZKAPI_RECOVERY_REVIEW.md](ZKAPI_RECOVERY_REVIEW.md#confirmed-give-up-of-a-zero-or-dust-balance-2026-10-13)).
  It cannot open an exit kit either; that is the companion tool's job.
- It cannot withdraw, give up or archive a balance whose version's SDK did not
  start, and it never tells the person such a balance is gone. The legacy SDK
  reads a note only after it has loaded its operator's manifest, so while that
  operator does not answer (or has been retired) the balance can only be said
  to be saved. A browser that holds a note of a retired version has no way out
  in the app: that is a precondition of
  [Retiring a version](#retire-a-version), not something the build checks
  ([5.10](#510-a-balance-the-page-holds-and-cannot-read)).
- It cannot control a tab that is already open on pre-rollout JavaScript.
- It does not recover notes that live in the SDK's default database
  `zkapi-browser-wallet-v1` (the pre-reset notes retained by the
  [September 30 reset](ZKAPI_PAYMENTS.md#september-30-clean-reset-profile)).

## 2. Concepts

### Version, adapter, deployment, lineage

| Term | What it is | Where it lives |
| --- | --- | --- |
| Version | One protocol generation of the app: id `v1`, `v2`, an ordinal, a label, an SDK pin, URL paths, transition policy and one entry per network. Data. | a row of [registry.json](../deployments/zkapi/registry.json) |
| Adapter | The code half of a version: how to validate a profile, what vault calldata looks like, which SDK methods start a deposit, how to read the SDK snapshot, the chat cutoff, the protocol wiring the host owes, the billing unit of its amounts and whether the family has been reviewed for giving up a balance (`abandon`). Code, one per protocol family (`note-bound-v1`, `concession-v1`). | [adapters/](../chat/zkapi/versioning/adapters/) |
| Deployment | One vault plus one operator stack on one network, identified by deployment id, chain id, vault address and protocol base URL (an origin, optionally with a path prefix: [one hostname for several deployments](#one-hostname-for-several-deployments)). One per (version, network). | the version's profile (file or inline `config`) |
| Lineage | The registry-level namespace `fresh-20260930`. It is the value of `OA_ZKAPI_DEPLOYMENT` and the name stem of the shared wallet database. Changing it would orphan wallets, so the forward-only check refuses it. | `registry.lineage` |

Version 1 is adapter `note-bound-v1` (vault revision 1, SDK `3342c95` plus the
`wallet-recovery-v1` patch). Version 2 is adapter `concession-v1` (vault
revision 3, SDK `0.2.0`). Its reference revision is `4b955d9`, the `v0.2`
branch of the local zkapi repository, which is not published; the `82c8504`
snapshot the first implementation was written against is superseded
([11.6](#116-the-reference-revision-82c8504-to-4b955d9) lists the
differences).

### Status lifecycle

Per version, per network:

| Status | Meaning | Assets built and served | In the app's version table | Deposits |
| --- | --- | --- | --- | --- |
| `pending` | registered, not deployed | no | no | no |
| `active` | deployed and accepting deposits. At most one per network: the deposit target | yes | yes | yes |
| `exit-only` | deposits closed; chat, close and escape still work | yes | yes | closed |
| `retired` | assets removed; a tombstone `{deploymentId, chainId, vault}` is kept so leftovers are recognized | no | as a tombstone | closed |

A tombstone lets the app recognize a leftover note, not open it: a browser that
still holds a note of a retired version has no way out in the app
([5.10](#510-a-balance-the-page-holds-and-cannot-read)), which is why that is a
precondition of [Retire a version](#retire-a-version).

Allowed moves:

- `pending -> active -> exit-only -> retired`, forward only.
- **Rollback**: `exit-only -> active` for a lower-ordinal version, only while
  at least one higher-ordinal live row exists and every such row is
  `exit-only`. This is the single backward move ([Roll back](#roll-back)). A
  close with no live successor (version 1 `exit-only` while version 2 is still
  `pending`) is not reversible by it: the check refuses to reopen that version.
- A row that ever had `activatedAt` can never become `pending` again, and a row
  that was `pending` may be reshaped or dropped.

[assertForwardOnly](../chat/zkapi/versioning/registryModel.mjs) enforces this
between two registries; `scripts/zkapi-registry-cli.mjs check --base <ref>`
runs it against a git ref, so a `git revert` of an activation fails that
check. The check is a command someone runs before merging
([The forward-only check](#the-forward-only-check)); the build and `npm test`
do not run it, and the build accepts any registry that validates on its own.

### Deposit target

The deposit target of a network is its unique `active` row. Zero is allowed
("deposits unavailable"; for example version 1 `exit-only` while version 2 is
still `pending`). The successor of a non-active version is the target when the
target is a different version; this is decided by status, never by comparing
ordinals, so a rollback has correct wording.

### Dormant means identical

With version 1 `active` and nothing else live, the build is `single` mode and
the page is dormant: no holdings probe, no deposit guard, no watcher, no
version pill, no banners, no served-config or `/build.json` request and no new
wallet-database access. The version table embedded in the bundle has one row
whose `assetBase` is `zkapi/`, and boot loads `./index.js` with the same asset
URLs as before. Precisely:

**Identical to the pre-versioning build**

- Every file under `dist/zkapi/` except `zkapi.css`: `browser-config.json` (the
  reviewed profile, byte for byte), `sdk-assets.json`, the WebAssembly, the
  worker and both proving keys. A test pins the emitted file list and the
  configuration bytes
  (`dormant registry: single mode emits exactly the legacy assets...` in
  [zkapiVersionedBuild.test.js](../test/architecture/zkapiVersionedBuild.test.js)).
- The Vercel `rewrites`: one proxy route, `/zkapi-deployment/:path*`, still
  first.
- The wallet database name, its version, the Web Lock and the channel.
- The requests the app makes to the zkAPI operator, the indexer, the RPC and the
  inference provider. The provider-visible headers are the same set and values:
  they are rebuilt from an allowlist, and the legacy SDK already sent exactly
  `authorization`, `content-type`, `http-referer` and `x-title: oa-chat`
  ([9](#9-privacy-and-security-notes)).
- The words a dormant page shows. The protocol-version error rewrites
  ([5.8](#58-cross-tab-behavior-and-error-mapping)) apply only when the build is
  versioning active, so a dormant page shows the SDK's own sentences, and the
  Welcome dialog keeps its previous wording. A failed start is the same: the
  plain words of a balance the page cannot read
  ([5.10](#510-a-balance-the-page-holds-and-cannot-read)) need the facade's
  `held` fact, which a dormant page never has, so its panel, chat bar, dialog
  and toasts say what they always said (an empty balance and the SDK's message).
- The request path. The protocol behaviors of [11.1](#111-protocol-wiring-requiredwiring)
  add no lock acquisition, `runtime.init()`, `connectWallet()`, exit preemption,
  error rewrite, signer rule or RPC to any withdrawal, deposit, chat or error
  path of a build that is not versioning active, or whose protocol family does
  not list them. The facade has no `history` member there, every `ui.*` helper
  they add returns an empty string, list or null, and the account dialog's
  markup is byte-identical.

**Different, even while dormant**

- The JavaScript, and more of it. `index.html`, `startup.js`, the app and
  prelude bundles and every chunk differ from the pre-change build (their
  content hashes change). Payment code is now reached through the `boot.js`
  module, which imports the SDK-free versioning modules statically and then
  the SDK and `./index.js` dynamically in the same tick. That is not only a
  different split. Measured on the mainnet build, as the static import closure
  of the boot, SDK and integration chunks beyond the app entry (what a dormant
  page fetches to start payments, gzip level 9), the single chunk of 768,788
  bytes (214 KB gzipped) became 17 chunks of 993,858 bytes (290 KB gzipped):
  about 225 KB (29%) more raw and 76 KB (35%) more gzipped, behind a deeper
  request chain (the boot chunk and its own imports first, then the SDK and
  integration chunks with theirs, where it was one chunk). The extra weight is
  the facade, its copy tables, both adapters, the notice builder and the
  exit-kit and give-up dialogs (a 52 KB chunk of their own), which `boot.js`
  and `RightPanel` import statically and a dormant page never renders. The app
  entry's own static closure is 2 KB larger (1,790,224 to 1,792,298 bytes).
  The version UI module (`versioning/ui.js`), which only a versioning-active
  build loads, is not counted. Loading the notice and dialog components only
  when a facade exists would take that share out of a dormant page; it is not
  done ([APP_STATE.md](APP_STATE.md)). No request goes to a new host. A
  dormant boot waits for its code without a time limit, as startup always did.
- `dist/zkapi/zkapi.css`: the version notice and exit-state styles are
  appended, so its content hash and the `?v=` the page links to change.
- `dist/build.json` gains three `zkapi` fields: `registrySha256`,
  `depositTarget` and `versions`. Each `versions[]` entry ends with `setupId`
  and `proofSetup`, which read `null` for version 1 (its profile and bundle name
  no proof setup) ([4.6](#46-provenance-vercel-rewrites-and-the-dev-server)).
- Three behaviors, all fail-safe: a failed payment boot now starts the app
  ticket-only with one toast instead of rejecting `startChatApp`
  ([5.1](#51-boot-sequence)); `AccountModal` takes `parseTokenAmount` from a host
  copy ([tokenAmount.mjs](../chat/zkapi/services/tokenAmount.mjs)) instead of
  the SDK; and boot reads (and, if present, deletes) the sessionStorage hint
  `oa-zkapi-version-switch`, which nothing writes while dormant.
- The facade is attached to the SDK client as `zkapiClient.oaVersioning`. It is
  inert: its gates are open, it subscribes to nothing and starts no timer.

**How this is checked.** `zkapi-boot.test.mjs` pins the dormant boot (no probe,
no database, no guard, no watcher, no notices, an unbounded wait for the code,
the same asset URLs, and that the history reader and the give-up service are
never called or imported); `zkapi-version-ui-render.test.mjs` renders the
account dialog with a dormant facade and with none and requires the same
markup, and records the calls of a dormant withdrawal: only settle and
withdraw, with no wallet connection, initialization, lock or re-read, and no
new key in its details; `zkapi-error-copy.test.mjs` requires that a dormant
page rewrites no error, including the real legacy `incompatible_proof_circuit`
shape; `zkapiVersionedBuild.test.js` builds the dormant registry and compares
the emitted tree with the legacy builder's. A
before and after comparison of the rendered output against the pre-change
sources was also done once, with a throwaway harness that is not kept in this
repository and is not part of `npm test`.

### Build modes and "versioning active"

| Term | Rule |
| --- | --- |
| `mode` `sdk-default` | `OA_ZKAPI_NETWORK` set, `OA_ZKAPI_DEPLOYMENT` unset: the SDK's own defaults and database, no registry. `__OA_ZKAPI_VERSIONS__` is `[]`. |
| `mode` `single` | one live version (`liveCount === 1`) |
| `mode` `multi` | more than one live version |
| ticket-only | `OA_ZKAPI_NETWORK` unset: no zkAPI code or assets at all |
| `liveCount` | rows with status `active` or `exit-only` for the network |
| versioning active | the table has more than one row (a live version and a tombstone count), **or** its single row is not `active`. Probe, deposit guard, watcher, integrity check and banners run if and only if this is true. |
| version pill | shown only when `liveCount > 1` |

A lone `exit-only` row is versioning active even though it has no sibling: the
pinned legacy SDK ignores the profile's deposits flag, so only the guard stops a
new deposit into a vault the registry closed (a rule of "more than one live
version, or any tombstone" would have left it unguarded). The single definition
is `isVersioningActive` in
[versioning/index.js](../chat/zkapi/versioning/index.js), shared by boot and the
facade. A lone `exit-only` page therefore has no pill but a closed gate, and its
notices key on the gate, not on the pill.

## 3. Registry

### Location and reading

- Data: [deployments/zkapi/registry.json](../deployments/zkapi/registry.json),
  `schema: 1`, two-space JSON with a trailing newline (a test asserts it). The
  registry carries no hash of itself: the build computes `registrySha256` over
  exactly that serialization and records it in `build.json`.
- Version 1 profiles stay in `mainnet.json` and `sepolia.json` (bytes
  unchanged). Later versions carry their profile inline as the entry's `config`.
- Pure model, shared by Node and the browser, with no Node, SDK or network
  imports: [registryModel.mjs](../chat/zkapi/versioning/registryModel.mjs).
- Node reader and plan: [scripts/zkapiRegistry.mjs](../scripts/zkapiRegistry.mjs)
  (`planFromRegistry` is pure; `verifyPlanOnDisk` reads the installed SDKs).
- The browser never imports `deployments/**`. The build projects two defines,
  `__OA_ZKAPI_VERSIONS__` (the table) and `__OA_ZKAPI_WALLET_DB__`.

### Schema

Top level (unknown fields are refused at every level, so a typo cannot silently
disable the rule it meant to set):

| Field | Type and rule | Today |
| --- | --- | --- |
| `schema` | `1` | `1` |
| `lineage` | lowercase id; must equal the accepted `OA_ZKAPI_DEPLOYMENT` | `fresh-20260930` |
| `walletDatabase` | template naming `{lineage}` and `{network}` once each; must not resolve to `zkapi-browser-wallet-v1` | `zkapi-browser-wallet-{lineage}-{network}-v1` |
| `walletDatabaseVersion` | positive integer; asserted against each SDK store's `DB_VERSION` literal | `3` |
| `versions` | 1 to 32 rows, `ordinal` strictly increasing | v1, v2 |

Version row:

| Field | Type and rule | v1 / v2 today |
| --- | --- | --- |
| `id` | `^[a-z][a-z0-9-]{0,31}$`, unique | `v1` / `v2` |
| `ordinal` | positive integer | 1 / 2 |
| `label` | plain text, at most 64 characters; copy shows the number ("version 2") | `Version 1` / `Version 2` |
| `adapter` | an id of [adapters/index.mjs](../chat/zkapi/versioning/adapters/index.mjs) | `note-bound-v1` / `concession-v1` |
| `circuitId` | must equal the adapter's | `zkapi-v2-note-bound-v1` / `zkapi-v2-concession-v1` |
| `vaultRevision` | must equal the adapter's | 1 / 3 |
| `sdk.alias` | npm package name, unique across all rows (retired and pending included) | the canonical `@openanonymity/zkapi-browser-sdk` / `zkapi-sdk-v2c` |
| `sdk.source` | dependency specifier ending in `#<revision>`, equal to `package.json` `dependencies[alias]`; null only while pending | `github:OpenAnonymity/zkapi#3342c95...` / null |
| `sdk.revision` | 40-hex commit, equal to the lock's resolved commit; null only while pending | `3342c95871e8...` / null |
| `sdk.storeSha256` | SHA-256 of the SDK's `./store` module; gates the database rename | pinned / null |
| `sdk.patches` | unique names registered in `SDK_PATCHES` ([patch-zkapi-sdk.mjs](../scripts/patch-zkapi-sdk.mjs)) | `["wallet-recovery-v1"]` / `[]` |
| `sdk.honorsDepositsFlag` | whether the SDK refuses `trusted_deployment.deposits: "closed"` itself | `false` / `true` |
| `publicPath` | absolute directory path where assets are served; unique | `/zkapi/` / `/zkapi/v2c/` |
| `proxyPath` | same-origin rewrite prefix; unique; equal to the profile's `deployment_api_proxy_path` | `/zkapi-deployment/` / `/zkapi-deployment-v2c/` |
| `transition.closeByMarginSeconds` | integer, 0 to 90 days | `259200` (72 h) |
| `transition.reminderDays` | at most 8 strictly decreasing day counts, the first inside `promptWindowDays` | `[7, 3, 1]` |
| `transition.promptWindowDays` | 1 to 366 | `14` |
| `transition.dustThresholdUsdMicros` | optional whole number of millionths of a dollar, 0 up to the family's smallest chat key (`adapter.abandon.smallestChatTierUsdMicros`, one dollar). Absent means that key; 0 turns the dust leg of [giving up a balance](#79-giving-up-a-zero-or-dust-balance) off (an empty balance can still be cleared). A family with no `abandon` data refuses the key | absent / absent |
| `transition.abandonEnabled` | optional boolean; `false` is the operator's switch that turns the give-up action off for the row | absent / absent |
| `gate.recoveryReview` | `{revision, verdict, patch}`, verdict `pending`, `patched` or `not_required` | patched `wallet-recovery-v1` at `3342c95` / pending |
| `gate.protocolWiring` | `pending`, `done` or `not_applicable` | `not_applicable` / `pending` |
| `gate.manifestSha256` | SHA-256 of the finalized deployment manifest the profile was generated from | null / null |
| `networks` | exactly `mainnet` and `sepolia` | see below |

Network entry:

| Field | Type and rule |
| --- | --- |
| `status` | `pending`, `active`, `exit-only` or `retired` |
| `activatedAt` | ISO-8601 timestamp with a zone. Required for every non-pending status, forbidden for `pending`. Version 1 uses `2026-09-30T00:00:00Z` for both networks: the deployment record states only the date, and midnight is a lower bound that keeps any later `depositsClosedSince` valid. |
| `profile` | file name of a reviewed profile (`mainnet.json`) |
| `config` | inline profile. Live entries need exactly one of `profile` and `config`; a pending entry needs `config` with `deployment_status: "not_deployed"` |
| `depositsClosedSince` | ISO timestamp; required for `exit-only`, not before `activatedAt`; display and copy only |
| `admissionClosesAt` | ISO timestamp; copy only; never drives logic |
| `retiredAt` | ISO timestamp; required for `retired` |
| `tombstone` | `{deploymentId, chainId, vault}`; required for `retired`, forbidden otherwise |
| `notices` | at most 16 `{kind: "stuck_escape", noteId, destination, expiresAt, text}`; only on `exit-only` entries; `text` plain, at most 280 characters |

`activatedAt` of version 1 follows
[ZKAPI_FRESH_DEPLOYMENT_20260930.md](ZKAPI_FRESH_DEPLOYMENT_20260930.md).

### Derived values (never duplicated in the registry)

| Value | Rule |
| --- | --- |
| deployment id, chain id, vault, rpc, protocol base URL, key hashes | read from the reviewed profile and checked against the row's `circuitId` |
| wallet database | `walletDatabase` with `{lineage}` and `{network}` filled: `zkapi-browser-wallet-fresh-20260930-mainnet-v1`, `...-sepolia-v1` |
| `assetBase` | `publicPath` without the leading slash (`zkapi/`, `zkapi/v2c/`) |
| `depositsOpen(v)` | `status === 'active'`. A build-time constant; dates never drive it |
| emitted `trusted_deployment.deposits` | `"closed"` appended last, only for a row with `honorsDepositsFlag` that is `exit-only`; otherwise the config is emitted exactly as reviewed. A `concession-v1` profile may not set it itself |
| `configSha256` | SHA-256 of `JSON.stringify(emittedConfig, null, 2) + "\n"`, the bytes the build writes. Embedded in the table and checked against the served file at boot |
| `registrySha256` | SHA-256 of the registry serialized the same way |
| runtime table | live rows ordinal ascending, then retired tombstones; pending rows never appear |

### Validation rules by error code

`validateRegistry` runs in every build and in tests (the build wraps a failure
as `[build] The zkAPI version registry is invalid (<code>): ...`; the CLI prints
`[zkapi-registry] <code>: ...` and exits 1). Every failure is a `RegistryError`
with one of these stable codes:

| Code | Raised when |
| --- | --- |
| `schema` | wrong or unknown field, malformed id, label or path, `networks` not exactly mainnet and sepolia, bad `patches` list, timestamp not ISO-8601 with a zone or not a real calendar day, `schema` not 1, not 1 to 32 rows |
| `lineage` | malformed, or different from the accepted `OA_ZKAPI_DEPLOYMENT` |
| `wallet_namespace` | `walletDatabaseVersion` not a positive integer; template without `{lineage}` and `{network}` once each; a name that is the SDK default or invalid; two networks sharing a database |
| `ordinal` | not a positive integer, or not strictly increasing |
| `duplicate_id`, `duplicate_alias` | a version id, or an npm alias, used twice (across all rows) |
| `path_collision` | a `publicPath` or `proxyPath` reused; a public path with a prefix relation to a proxy path; two proxy paths with a prefix relation. Public paths may nest (`/zkapi/v2c/` under `/zkapi/`) |
| `unknown_adapter` | the row's `adapter` is not registered |
| `adapter_mismatch` | the row's `circuitId` or `vaultRevision` disagrees with its adapter |
| `status`, `status_fields` | unknown status; a field that status forbids (for example `depositsClosedSince` on `active`, `tombstone` on `exit-only`, `profile` on `pending`, `profile`, `config` or `admissionClosesAt` on `retired`) |
| `activation_time` | `pending` with `activatedAt`; non-pending without it; `depositsClosedSince` or `retiredAt` earlier than `activatedAt` |
| `pending_shape` | `pending` without an inline `not_deployed` config |
| `profile_source` | a live entry with both or neither of `profile` and `config` |
| `profile` | a live profile refused by its adapter (strict), a `not_deployed` placeholder on a live entry, another circuit, missing `trusted_deployment` pins, unusable identity |
| `profile_missing` | `profile` names a file that was not supplied |
| `exit_only_fields` | `exit-only` without `depositsClosedSince` |
| `retired_fields` | `retired` without `retiredAt` or a well-formed tombstone; a tombstone chain id that is not the network's chain (mainnet 1, sepolia 11155111) |
| `notice` | notices on a non-`exit-only` entry, more than 16, an unknown kind, a bad note id, destination or `expiresAt`, text empty, over 280 characters or with control characters |
| `transition` | margin or window out of range; `reminderDays` not strictly decreasing, over 8 entries, or starting beyond the prompt window; `dustThresholdUsdMicros` not a whole non-negative number, above the family's smallest chat key, or set for a family with no give-up data; `abandonEnabled` not a boolean |
| `multiple_active` | more than one `active` row on a network |
| `no_live_version` | a network with no `active` or `exit-only` row (all pending or retired). An empty or tombstones-only table would otherwise read as "legacy SDK defaults" at boot, so `resolveRuntimeTable` refuses it too |
| `identity_collision` | within one network, over all non-pending rows (tombstones included): a reused deployment id, a reused `(chainId, vault)`, or two live rows whose protocol base URLs are the same, or one a path prefix inside the other (two deployments may share a hostname under different prefixes). Uniqueness is per network: each network has its own database, build and config |
| `parameter_mismatch` | live rows of a network differ in `openrouter_inference_base` or `request_charge_cap` (request-visible parameters stay version-identical) |
| `sdk_pin` | a live row with `source`, `revision` or `storeSha256` null, or a `source` that does not end in `#<revision>` |
| `gate_recovery_review` | the review covers another revision; verdict `pending`; `patched` without a patch named in `sdk.patches`; `not_required` that names a patch |
| `gate_wiring` | `protocolWiring` not `done` or `not_applicable`; a name in the adapter's `requiredWiring` missing from [WIRED](../chat/zkapi/versioning/wiring.mjs); `not_applicable` for an adapter that requires wiring |
| `gate_manifest` | `concession-v1` without `manifestSha256`, or an adapter with no manifest that has one |
| `forward_only`, `tombstone_mismatch`, `identity_changed`, `identity_unverified` | raised by `assertForwardOnly`, not `validateRegistry` ([below](#the-forward-only-check)) |
| `recovery_patch_coverage` | raised by `assertRecoveryCoverage` in [scripts/zkapiRegistry.mjs](../scripts/zkapiRegistry.mjs), not `validateRegistry`: a live row of a family that lists `withdrawal-operation-recheck` whose `sdk.patches` names no reviewed patch that covers it for the row's own SDK revision ([4.5](#45-patches-per-version)). Applied by `planFromRegistry` to the shipped registry (so a build and the Vercel route generator refuse it) and by the registry CLI check; no override |

A live profile must also pass its adapter's `validateProfile` with the registry's
strict options: chain id for the network, native ETH billing, verified OA keys
(`require_oa_key_source`), `proving_keys_base_url === "./proofs/"`,
`deployment_api_proxy_path` equal to the row's `proxyPath`, manifest URLs equal
to the protocol base URL's `/config.json`, a credential-free HTTPS base URL for
protocol and indexer (an origin, or an origin and a plain path prefix: [see below](#one-hostname-for-several-deployments)) and credential-free HTTPS origins for verifier and RPC, and the reviewed OpenRouter inference base.
`concession-v1` adds `vault_revision 3`, `exit_concession 1`,
`clearance_ownership_proof "required"`, `deployment_status` absent or
`deployed`, no `deposits` key, a deployment id that does not contain
`note-bound`, a request verifying-key hash, and a proof setup: its
`trusted_deployment.setup_id` is `mpc-1` or `dev`, and the rule is the same on
both networks (`ACCEPTED_SETUP_IDS` of
[adapters/concessionV1.mjs](../chat/zkapi/versioning/adapters/concessionV1.mjs);
Sepolia differs from mainnet only in the network's own values). There is no
network in the rule and no switch: the profile's `allow_dev_setup` field is not
read, and an `allowDevSetup` key on a network entry is an unknown field. The
build also passes the SDK bundle's own manifest `setupId` to the same check
(`verifyPlanOnDisk` for the installed package, the emission step for the
bundle it just built). It must be one of the two and must equal the profile's,
so a bundle serves one setup on both networks. Three refusals, each naming no
network because the same profile is refused the same way everywhere:

| Case | Message |
| --- | --- |
| the profile pins another id, or none | `The profile must pin an accepted proof setup (mpc-1 or dev).` |
| the bundle's manifest names another id, or none | `The SDK bundle must be built for an accepted proof setup (mpc-1 or dev).` |
| both are accepted ids but differ | `The SDK bundle is built for the <a> proof setup, but the profile pins the <b> proof setup.` |

Accepting `dev` is not hiding it: the build warns, `build.json` records it and
the registry check repeats it
([the limitation](#single-party-development-proof-setup-known-limitation)).
The SDK package's own build had one rule of its own for chain 1 up to
`82c8504` (a bundle that is not `mpc-1` was refused with
`development_setup_on_mainnet`); `4b955d9` dropped it. The host never bypassed
or reimplemented that rule, and still passes the refusal of a revision that has
it on with the words in the section linked above.

The strict origin and inference-base checks apply only through the registry. The
legacy `validateZkapiDeploymentPins` wrapper in `zkapiBuild.mjs` is the same
adapter without them, so its accept and reject behavior is exactly what the
pre-registry build tests assert.

### One hostname for several deployments

A new version does not need a new hostname. Two protocol generations answer on
the same route names (`/v2/billing/quote`, `/v2/openrouter/leases`,
`/v1/tree/snapshot`, `/config.json`), so a single hostname has to tell them
apart by something the browser can vary, and the only such thing is the URL
path: the SDK's requests carry no custom header and the app's static rewrite
cannot add one. The rule is therefore:

- **The older deployment keeps the root it was pinned at.** A live pin cannot
  move (`identity_changed`), and its SDK appends its routes to that origin.
- **A newer one is served under a plain path prefix of the same hostname**,
  named after its protocol version (`/v0.2`, then `/v0.3`, `/v1.0`, and so on),
  and its profile pins that URL: `protocol_server_url` and `indexer_url` are
  `https://<hostname>/<prefix>` (no trailing slash), and
  `deployment_manifest_url` and the one entry of
  `allowed_deployment_manifest_urls` are `https://<hostname>/<prefix>/config.json`.
  The service must publish the same URL as `protocol_server_url` in its manifest
  (the SDK compares the two), so the pin is the address the service really
  lives at, never a prefix the host adds behind the SDK's back.

```
version 1   https://zkapi.example.com            proxy /zkapi-deployment/
version 2   https://zkapi.example.com/v0.2       proxy /zkapi-deployment-v2c/
(later)     https://zkapi.example.com/v0.3       proxy /zkapi-deployment-v3c/
```

**Naming the prefix.** Use the deployment's protocol (SDK) version with its
leading `v`: `v0.2` for the `0.2.x` line, `v0.3` for the next. The dots are plain
characters of one segment, and `v0.2`, `v0.20`, `v0.3` and `v1.0` are all
distinct services. Do not use the registry row ids `v1` and `v2` themselves:
those are the protocol's own API route names (`/v2/billing/quote`), so a prefix
named `/v2` would shadow the root deployment's API, and the base is refused. The
prefix is data of the deployment, not derived from anything: a later upgrade
picks its own name by the same convention, and the registry does not need to
change for it.

**What a prefix may be** (`chat/zkapi/versioning/serviceBase.mjs`, shared by the
adapters, the registry model and the route generator): one to three plain
segments of letters, digits, dots, dashes, underscores and tildes (each at most
64 characters, 96 in all), written exactly, with no trailing slash, query,
fragment, credentials, escapes, empty or dot segments. The first segment cannot
be `v1`, `v2`, `config.json` or `_bundler` (in any case): those are routes of
the protocol or of this app's proxy, and a prefix named like one would shadow
the root deployment's own API on the same hostname. `rpc_url` and `verifier_url`
stay origins.

**What is distinct.** Identity is the base URL, not the origin. Two live rows
may share a hostname under different prefixes; they may not have the same base
or one prefix inside another (`/v0.2` and `/v0.2/next`: a request under the inner
one would be the outer one's as well; `/v0.2` and `/v0.20` do not overlap). `identity_collision` says "shares its
protocol URL with ...". A root and a prefix of one hostname are distinct because
the root's routes are fixed names that a prefix never starts with.

**What the build generates.** One rewrite per live version, scoped to the
service's subtree on both sides:

```
/zkapi-deployment/:path*            ->  https://zkapi.example.com/:path*
/zkapi-deployment-v2c/v0.2/:path*   ->  https://zkapi.example.com/v0.2/:path*
```

The SDK builds `<protocol_server_url>/v2/...` and forwards
`<proxyPath><path of that URL>`, so the prefix travels through the proxy
unchanged and lands where the service is mounted. A version's proxy path does
not reach another deployment's routes on the shared hostname (there is no
`/zkapi-deployment-v2c/:path*` for a prefixed version). Both SDK generations
(the pinned legacy one and `4b955d9`) map a URL under a prefix this way, which
`test/zkapi/service-base.test.mjs` shows against the real `deploymentProxyUrl`.

**What the operator does.** Serve the new stack under the prefix on the
existing hostname (an ingress rule that routes `/<prefix>/*` to it, with or
without stripping the prefix, so long as the service's manifest says the
prefixed URL), and put that URL into the profile passed to
`deployment-profile.mjs` as `--protocol-server-url` and `--indexer-url`. Name
the prefix by the version convention above (never one of the reserved names,
and never one the legacy stack's own routes use). The legacy stack at the root is not
touched. The indexer shares the protocol base (the registry requires it), so it
is served under the same prefix.

**What this does not change.** The cohort and IP visibility of
[9](#9-privacy-and-security-notes) are as before: the app's host still sees
which proxy path (`/zkapi-deployment/` or `/zkapi-deployment-v2c/`) a browser
uses, and the operator, who now has one hostname, sees both in its own logs. The
anonymity set is per vault, not per hostname. Direct (non-proxied) use of the
URL, such as the exit-kit companion or `zkapi-clientd`, is by the full base URL
and needs the same ingress rule.

### The forward-only check

`assertForwardOnly(base, next)` compares two registries. It throws code
`forward_only` when:

- the lineage, database template or database version changed;
- a non-pending row was removed, or changed ordinal, adapter or circuit;
- a row moved to an earlier stage on some network, except the rollback above.

It also holds identity across the change, so a typo or a swapped deployment
cannot pass as a lifecycle move:

| Code | Raised when | Override |
| --- | --- | --- |
| `tombstone_mismatch` | a row that was live (`active` or `exit-only`) in the base becomes `retired` with a tombstone that differs from the deployment id, chain id and vault the base row named (read from its inline `config`, or from the profile file as committed at the base ref) | none |
| `identity_changed` | a row that is live in both registries changes its deployment id, chain id or vault, or its proof setup or key pins (`setup_id`, `request_proving_key_sha256`, `withdrawal_proving_key_sha256`, `request_verifying_key_sha256`, `request_vk_keccak256`, `withdrawal_vk_keccak256`), or its row-level `sdk.revision` or `sdk.storeSha256`; or a row that is `retired` in both changes its tombstone | `--allow-identity-change` |
| `identity_unverified` | a deployment id, chain id or vault that has to be compared cannot be read (a profile file that does not exist at the base ref, or a profile without `trusted_deployment` pins) | none: the profile has to be readable at the base ref |

A different deployment is a new version, not an edit of an existing row, so
`identity_changed` is a reviewed exception: use `--allow-identity-change` for
one change, such as an SDK pin bump of a live version, and say so in the PR. The
override never covers `tombstone_mismatch`. Only the pins above are compared;
other profile fields (RPC, origins) are not.

The proof pins are held because a vault verifies proofs against the keys it was
deployed with. A profile that names another setup or key set under the same
deployment id and vault describes a vault that does not exist, and a vault on
`dev` keys cannot become an `mpc-1` vault in place
([the limitation](#single-party-development-proof-setup-known-limitation)). The
comparison runs for every move a live row can make (active to active, active to
`exit-only`, the rollback), in both directions between `dev` and `mpc-1`, and
reads a profile file from the profiles each side was committed with, so editing
`mainnet.json` or `sepolia.json` in place is caught too. Hashes compare without
regard to case, and a pin that is absent on both sides is equal; a pin that
appears or disappears is a change. A `pending` row has no identity yet, so
it takes either accepted setup when it is activated. The legitimate way to
change keys is a further row: the old row stays on its own keys and moves to
`exit-only`, and the new row carries the new setup.

Run it with `node scripts/zkapi-registry-cli.mjs check --base origin/main`
(see [4.7](#47-the-registry-cli)). It validates the working-tree registry first,
so an activation PR that is not committed yet is what is judged. Nothing runs
it for you: there is no CI job and no npm script, so run it before merging any
change to `deployments/zkapi/registry.json`.

## 4. Build

### 4.1 Environment contract

| Variable | Meaning |
| --- | --- |
| `OA_ZKAPI_NETWORK` | `sepolia` or `mainnet`; unset is ticket-only. Unchanged. |
| `OA_ZKAPI_DEPLOYMENT` | `fresh-20260930` (the registry lineage) or unset. Unchanged value; the meaning is now "build every live version of the lineage for this network". Any other value throws `OA_ZKAPI_DEPLOYMENT must be fresh-20260930, or unset for SDK defaults`; a value without a network throws too. |

Existing Vercel environments, database names and the generated `buildCommand`
stay valid. There is no per-version environment switch. The registry is
validated, and every live SDK is verified on disk, before `dist/` is touched.
A registry build prints a line such as `Built zkAPI versions: v1 (active);
deposits go to v1` (before the `Built app bundle` lines). A live version built on
the `dev` proof setup adds one `[build] WARNING: zkAPI <id> on <network> is
built on the single-party development proof setup (dev). ...` line per version,
printed once, after the on-disk verification and before anything is emitted
([the limitation](#single-party-development-proof-setup-known-limitation)).

```sh
OA_ORG_SAME_ORIGIN=true OA_ZKAPI_NETWORK=mainnet \
  OA_ZKAPI_DEPLOYMENT=fresh-20260930 npm run build
```

### 4.2 Asset layout

| Version | Assets | Proxy rewrite | Config |
| --- | --- | --- | --- |
| v1 | `dist/zkapi/` (unchanged, so users' cached proving keys stay valid) | `/zkapi-deployment/:path*`, `rewrites[0]` while version 1 is live | `dist/zkapi/browser-config.json` |
| v2 | `dist/zkapi/v2c/` (new URLs, because proving keys are fetched force-cached) | `/zkapi-deployment-v2c/:path*` (a sibling, not under `/zkapi-deployment/`, which the first rewrite would capture) | `dist/zkapi/v2c/browser-config.json` |
| shared | `dist/zkapi/zkapi.css`, written once by the orchestrator | | |

The orchestrator removes `dist/zkapi` once, then emits each live version in
ordinal order (an SDK build never deletes and the file sets are disjoint).
Per version the files are `browser-config.json`, `sdk-assets.json`, `proofs/*`,
`wasm/*` and `assets/zkapiWasmWorker.js`. Version 2 adds about 16.7 MB plus the
worker bundle, measured from the `0.2.0` snapshot (request key 6.1 MB,
withdrawal key 7.9 MB, WebAssembly 2.8 MB); measure it again from the pinned
commit at activation.

### 4.3 Wallet database rename and hash gating

Every version of a lineage opens one database per network (the shared wallet,
[5.4](#54-the-shared-wallet-database)). The SDK store hard-codes
`const DB_NAME = 'zkapi-browser-wallet-v1';`, so the build rewrites that line
inside the bundle (never in `node_modules`):

- An esbuild `onLoad` transform maps each live version's `./store` realpath to
  `{database, sourceSha256}`. The source must hash to the row's
  `sdk.storeSha256` and contain the declaration exactly once, or the build
  throws "Review the wallet storage namespace for this SDK source".
- It also asserts the shared-slot literals, each exactly once:
  `const DB_VERSION = <walletDatabaseVersion>;`, the lock name and the
  BroadcastChannel name `zkapi-wallet:active-runtime`. A bumped version or
  renamed lock/channel fails the build.
- A `browserWalletStore.js` outside the map throws instead of silently opening
  the default database (modes other than `sdk-default`).
- After bundling, `assertZkapiBundleEmission` reads every emitted chunk: none
  may contain `zkapi-browser-wallet-v1`; each chunk holding a live store must
  contain the lineage database name; in a faceted build every variant must be in
  the graph. A failure names the module that carries the literal, and
  distinguishes an SDK store from host code that merely names the default
  database (which also fails closed).

### 4.4 Facade plugin and name-parity gate

[scripts/zkapiFacadePlugin.mjs](../scripts/zkapiFacadePlugin.mjs) is active only
when `facadeRequired(plan)`: more than one live version, or one live version
installed under a non-canonical alias (version 1 retired, version 2 alone).
Single-version builds with the canonical alias are wired exactly as before.

- Imports of `@openanonymity/zkapi-browser-sdk/<sub>` from files under
  `chat/zkapi/` resolve to generated `oa-zkapi-facade:<sub>` modules: live
  bindings holding the union of every live SDK's export names (read from
  esbuild's metafile; no SDK code runs).
- Each live version is one `oa-zkapi-variant:<id>` chunk. The checked-in
  [variants.js](../chat/zkapi/versioning/variants.js) stub (one export,
  `loadVariant`, rejecting `no_variants`) is replaced at bundle time by a loader
  whose `loadVariant(id)` imports exactly one variant and binds every facade.
  A second, different id in one page is refused (`variant_conflict`); an unknown
  one is `unknown_variant`.
- Importers outside `chat/zkapi`, and any direct import of a live non-canonical
  alias, are build errors: either would bundle a second unbound SDK.
- Boot order rule: SDK-free modules are imported statically; the SDK client,
  runtime and store are imported dynamically after `loadVariant`.

**Name parity.** A facade exports the union of names, so a name only some SDKs
export would be `undefined` under the others with no esbuild error. The plugin
therefore scans every `.js` and `.mjs` file under `chat/zkapi` with esbuild's own
parser (comments and strings never count) and fails the build when an imported
name is not exported by every live SDK, naming the name, subpath, SDK alias,
version id and importing files. Rules of `GUARDED_UNION_ONLY_NAMES`
([zkapiFacadePlugin.mjs](../scripts/zkapiFacadePlugin.mjs), `[]` today):

- Each entry is `{subpath, name, reason}`; the reason is mandatory.
- An entry only excuses a union-only name (some live SDK exports it, another
  does not). A name no live SDK exports is never excused.
- An entry nothing imports, or that every live SDK now exports, fails the build
  as stale.
- The scan covers all of `chat/zkapi/**`, not only the reachable graph. Names
  read from a dynamic `import()` result, star re-exports and computed namespace
  members are not checked.
- Retiring version 1 leaves any entry that listed a version-1-only name stale,
  so the retirement change must prune the list.
- The scan depends on esbuild's message wording. The parity-gate tests run
  against the installed esbuild, so a bump that changes the wording fails
  `npm test`; run it after any esbuild update.

Pitfalls recorded while building this:

- `loadVariant` must actually be called by the boot path. A side-effect-only
  import of the loader is tree-shaken away together with every variant, and a
  faceted bundle with no variant in the graph fails `assertZkapiBundleEmission`.
- Both SDKs publish the package name `@openanonymity/zkapi-browser-sdk`; only the
  npm alias tells them apart. Never key anything on the package name or version.
- esbuild reports real paths (macOS `/var` is `/private/var`), so importer and
  metafile comparisons use `realpath`.
- Class names are minified: identity of an SDK class is never asserted by `.name`.
- `import * as ns` of the SDK from chat code also sees the facade's `__oaBind`;
  do not enumerate those namespaces.

Host helpers that exist in only one SDK live in `chat/zkapi/services` instead:
the amount parser moved to [tokenAmount.mjs](../chat/zkapi/services/tokenAmount.mjs)
for that reason (the real `0.2.0` SDK no longer exports it).

### 4.5 Patches per version

`patches/zkapi-browser-sdk-wallet-recovery.mjs` (`wallet-recovery-v1`) is bound
to revision `3342c95` and version 1 only: it cannot apply to `82c8504` or to
`4b955d9` (all file hashes differ). The mechanism is a per-version list:

- A row names patches in `sdk.patches`; `SDK_PATCHES` in
  [patch-zkapi-sdk.mjs](../scripts/patch-zkapi-sdk.mjs) maps each name to a
  module. An unknown name cannot build. Each patch is bound to one revision and
  one set of file hashes and verified before any file is touched (pristine and
  already-patched bytes both pass).
- `postinstall`, `pretest` and `predev` run the script. It is driven by the
  registry: a dormant row (pending or retired on every network) is skipped, a
  live legacy-alias row is required (missing package, changed pin or changed
  bytes fail loudly), and a live row under another alias is patched when
  installed and skipped when not (an install must never fail for a package npm
  has not fetched; the build still refuses it).
- A patch module gets its own line in `.vercelignore`.
- **Coverage.** Some wiring has a half only the SDK can provide
  ([11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)). `PATCH_COVERAGE`
  in [patch-zkapi-sdk.mjs](../scripts/patch-zkapi-sdk.mjs) says, by patch name,
  which wiring names a registered patch provides the SDK half of
  (`{ 'wallet-recovery-v1': ['withdrawal-operation-recheck'] }` today). It is a
  separate frozen map and deliberately not a field of a patch entry, because
  the entry is hashed into the build provenance. `reviewedRecoveryPatches()`
  joins it with the revision each patch is bound to, and
  `recoveryCoverageGaps(registry)` lists every live row (active or exit-only on
  any network) whose adapter lists a name of `SDK_HALF_WIRING`
  (`['withdrawal-operation-recheck']`) and whose `sdk.patches` names no patch
  that covers it **for the row's own `sdk.revision`**. A patch bound to another
  revision does not count, mirroring what `patchSdkVersion` would refuse. A
  `not_required` recovery verdict alone is not coverage either: the row must
  still name a registered patch. For a revision that provides the SDK half
  itself, register an entry with `files: []` and one `PATCH_COVERAGE` line; it
  rewrites nothing and still refuses any other revision.
- Main guards of modules that are also bundled need a basename plus realpath
  check, or a bundled copy would run the patch (or the CLI) on import and a
  symlinked checkout would silently do nothing.
  `scripts/patch-zkapi-sdk.mjs` and `scripts/zkapi-registry-cli.mjs` do this.
  `scripts/generate-zkapi-vercel-config.mjs` does not: its guard compares
  `path.resolve(argv[1])` with the module URL, so run it by its real path (from
  a symlinked checkout it writes nothing and prints nothing).
- The registry gate `gate.recoveryReview` makes the review of a new revision a
  validated fact rather than a convention ([3](#validation-rules-by-error-code)).

### 4.6 Provenance, Vercel rewrites and the dev server

`dist/build.json` keeps `zkapi.network`, `deployment`, `walletStorage` and `sdk`
(the lowest-ordinal live version) and adds:

- `zkapi.registrySha256`, `zkapi.depositTarget`;
- `zkapi.versions[]`: `{id, status, adapter, circuitId, deploymentId,
  configSha256, sdk: {alias, version, revision, patches, assets}, publicPath,
  proxyPath, walletStorage: {database, sourceSha256}, setupId, proofSetup}`.
  The last two are additive and come last. `setupId` is the proof setup id of
  the version's keys: the emitted bundle's own manifest `setupId` when assets
  were emitted, else the reviewed profile's pin, and `null` for a family that
  names none (version 1). `proofSetup` is `'ceremony'` for `mpc-1`,
  `'development'` for `dev` and `null` otherwise, so a deployment on the
  single-party setup is readable from the build record alone.

The lock lookup is per alias. `build.json` is also what the running app polls
for [stale builds](#57-the-watcher-and-stale_build).

`generate-zkapi-vercel-config.mjs` emits one rewrite per live version, version 1
first (each forwards only its service's own subtree: a version on a path prefix
of a shared hostname gets `<proxyPath><prefix>/:path*` to
`<origin><prefix>/:path*`, a root deployment `<proxyPath>:path*` to
`<origin>/:path*`), computed from static JSON only (the bundled generator imports `node:`
builtins only and runs with `import.meta.resolve` denied; a test pins this).
A retired version gets no route and a pending one none yet. `build.env` and
`buildCommand` are unchanged. A second origin needs no CSP change because the
app ships none.

```sh
OA_DEPLOYMENT_ORG_ORIGIN=<org origin> OA_ZKAPI_NETWORK=<network> \
  OA_ZKAPI_DEPLOYMENT=fresh-20260930 \
  node scripts/generate-zkapi-vercel-config.mjs vercel.generated.json
```

The dev server never enables zkAPI: `__OA_ZKAPI_*__` are build defines and bare
SDK specifiers are not browser-resolvable, so `chat/startup.js` takes the
ticket-only path. New startup code stays behind `typeof __OA_ZKAPI_*__` guards.
Exercise multi-version behavior with `npm run build` and `npm run preview`
(serves `dist/`), plus the fixture-SDK build test.

### 4.7 The registry CLI

[scripts/zkapi-registry-cli.mjs](../scripts/zkapi-registry-cli.mjs) is a
standalone command. No test imports it; the build tests run it as a subprocess,
and nothing else runs it (no npm script, no CI): it is a command for a person to
run before merging.

| Command | Purpose |
| --- | --- |
| `node scripts/zkapi-registry-cli.mjs --help` | usage |
| `node scripts/zkapi-registry-cli.mjs store-hash <alias>` | SHA-256 of the installed package's `./store` module: the value a row pins as `sdk.storeSha256`. Fails with "is not installed" for an alias npm has not installed |
| `node scripts/zkapi-registry-cli.mjs check --base <git-ref> [--file <registry.json>] [--allow-identity-change] [--package-root <dir>]` | validate the working-tree registry, require every live row to have the SDK half of the wiring it needs ([4.5](#45-patches-per-version)), then require it to be a legitimate successor of the one committed at `<git-ref>`, including [identity continuity](#the-forward-only-check). Prints `zkAPI registry is a valid forward move from <git-ref>.` Then, on stderr, one warning per live row whose profile pins `dev`, and one more for each such row whose installed SDK package would refuse it for mainnet. Neither changes the exit code |

Behaviors worth knowing:

- The setup warnings are printed after the verdict, for every live row (active
  or exit-only) on either network whose reviewed profile pins `dev`, including
  when the base ref has no registry ("Nothing to compare"). The second kind is
  a probe of the installed SDK package: it calls the package's own exported
  `assertDeployableProfile` exactly as the build does and reports only
  `development_setup_on_mainnet`, which only a revision before `4b955d9`
  throws. A package that is not installed, that exports
  no such check, or that refuses for any other reason adds nothing here (the
  build verifies all of those). `--package-root` names the directory whose
  `node_modules` holds the SDK packages (this repository by default), so the
  probe can be run from another tree.

- The coverage rule (`recovery_patch_coverage`) has no override and runs before
  the comparison, so it also holds when the base ref has no registry. The build
  applies the same function to the shipped registry, so skipping this command
  does not skip the rule.

- A base ref at which `deployments/zkapi/registry.json` does not exist prints
  "Nothing to compare" and exits 0. That is the case for any ref older than the
  change that introduced the registry, so use a base that has it
  (`origin/main` once it does).
- An unusable ref (not a commit, or beginning with `-`) fails, and so does an
  invalid working-tree registry (`[zkapi-registry] <code>: ...`, exit 1).
- `--file` checks another registry file; profile files named by its rows are
  read next to it, and at the base ref from the same directory.
- `--allow-identity-change` lifts `identity_changed` only, which includes a
  changed proof setup or key pin. See
  [The forward-only check](#the-forward-only-check) for what it never lifts.

## 5. Runtime

### 5.1 Boot sequence

[chat/zkapi/boot.js](../chat/zkapi/boot.js) is called by `chat/startup.js` with
no arguments. Every option on it is a test seam and is never reachable from
`startChatApp(options)` (a test asserts this). It never throws and returns
`{integration, unavailable?}`.

```
0  empty table (sdk-default): import ./index.js with assetBase zkapi/ ; return   // today's startup
1  consumeVersionSwitch()        one-shot hint, validated enums and ids only
2  selectZkapiVersion()          read-only probe (+ optional draft discard), unless
                                 one live row and no tombstone: then no probe, no IndexedDB open
   verifyServedConfig()          in parallel with 3 (versioning-active builds only)
3  loadVariant(version.id)       multi builds; `no_variants` means nothing to load
4  installActiveVersion()
5  import SDK client, runtime, store ; facade.attach() ; client.oaVersioning = facade
   (a build that is not versioning active starts step 7's import in the same
   tick; a versioning-active build loads the notices module beside 7)
6  installDepositGuard()         versioning-active builds, before any UI exists
7  import ./index.js ; createZkapiPaymentIntegration({configUrl, workerUrl, mode: 'browser'})
8  startVersionWatcher()         versioning-active builds
```

**Modules loaded on use.** Two modules are reached only through a boot seam
and are never in the static import graph (a test asserts it, and the boot chunk
contains neither): the give-up service
([abandonedNote.mjs](../chat/zkapi/services/abandonedNote.mjs), SDK-bound,
`importAbandonedNote`, imported when a person confirms
[giving up a balance](#79-giving-up-a-zero-or-dust-balance)) and the history
reader ([otherVersionHistory.mjs](../chat/zkapi/versioning/otherVersionHistory.mjs),
SDK-free, `readHistory`, called when Payment history is opened). Boot hands
both to `facade.attach` only on a versioning-active build, so a dormant build
neither imports nor calls them.

**Failure isolation.** Any rejection or timeout in steps 3 to 7 (and, in step 2,
a table no validated registry could produce) resolves to
`{integration: null, unavailable: {code, message}}`; so does a failure of the
sdk-default path and of a build with one `active` row, which used to reject
`startChatApp`. `startup.js` then calls `createChatApp` without the integration
(ticket-only, `analytics: false`) and, once the app is ready, shows one error
toast: "zkAPI could not start in this tab. Reload to try again. Your balance is
saved in this browser." When `import('./zkapi/boot.js')` itself fails there is
no boot message and `startup.js` shows its own shorter text, "zkAPI could not
start in this tab. Reload to try again." Codes:
`invalid_version_table`, `variant_unavailable`, `variant_timeout`,
`sdk_unavailable`, `integration_unavailable`, `asset_base_missing`,
`boot_failed`. Only the code is logged (`[zkapi] Private payments could not
start: <code>`).

**Time budgets** (defaults; `timeouts` option):

| Wait | Bound | On expiry |
| --- | --- | --- |
| holdings read | `probeMs` 2000 ms | `holdings_unreadable`: deposits blocked, boot continues |
| whole selection (probe, optional discard, second probe) | `probeMs * 3 + 250`, one budget for the three steps | decide on `holdings: null`: `holdings_unreadable`, deposits blocked; a reload re-reads (a discard that committed before the deadline is not undone) |
| served-config fetch | `integrityMs` 2000 ms (+250) | `unverified`, no block |
| each load of code (variant, SDK, integration, notices) | `variantMs` 20 s, never past what is left of `totalMs` | unavailable; for the notices only a console warning |
| wait for notices after the integration exists | `uiMs` 3 s | proceed; the notices attach late |
| the whole boot | `totalMs` 30 s | the step that ran out reports its code |

The code-loading bounds and `totalMs` apply to versioning-active builds only. A
build that is not versioning active (sdk-default, or one `active` row) is
today's app and waits for its code without a limit, as startup always did: a
slow link is not a failure there, and a limit would only turn a slow start into
a ticket-only one. It has no probe and no served-config request either.

A probe that cannot answer is not an unavailability: payments, chat and exits
work, and only deposits are blocked.

**Served identity.**
[configIntegrity.mjs](../chat/zkapi/versioning/configIntegrity.mjs)
`verifyServedConfig` fetches the version's `browser-config.json`
(`cache: 'no-store'`, `credentials: 'omit'`) and compares its SHA-256 with the
embedded `configSha256` (raw bytes first, then the parsed and re-serialized
bytes, so a transparent re-encoding is `ok`). Mismatch means the deposit gate
code `config_mismatch`; a failed fetch or non-JSON body is `unverified` and
blocks nothing. After the SDK's first successful `init()`,
`assertServedIdentity` requires `runtime.manifest.deployment_id` and the funding
vault to equal the version's own (latched in the facade).

### 5.2 The holdings probe

[walletHoldings.mjs](../chat/zkapi/versioning/walletHoldings.mjs) reads the
shared database without importing an SDK. It is host-owned and read-only for
these reasons:

- The build has to be chosen before any SDK module is imported, so an SDK's own
  holdings API is not available yet. The pinned `3342c95` has none.
- The successor SDK's read writes a migrated request-journal record, and the
  successor is unpublished. A host probe that wrote would be a second schema
  author of a database whose version must never move.

How it stays read-only: `indexedDB.open(name)` **without a version**, so it can
never request an upgrade; `onupgradeneeded` (which fires only when the database
does not exist) aborts the versionchange transaction, so nothing is created and
the answer is "no wallet". It defines no stores, bumps no version, uses one
readonly transaction over `runtime`, `withdrawals` and `deposits` (missing
stores read as empty), closes its connection right after the read and gives up
after 2 s (a timeout, a blocked open and an error all end in decision-table row
2, `holdings_unreadable`).

Classification is a port of upstream `browserRuntimeHoldsState`,
`isOpenBrowserWithdrawal`, `browserWalletHoldings` and `isUnclaimedPayoutCredit`,
made fail-closed: a slot key outside the pinned metadata set (`version`,
`deploymentId`, `billingAsset`, `updatedAt`, `stateSeq`, `exitKitExportedSeq`)
that is truthy, a non-empty array or a non-empty object counts as held. A
malformed container throws `holdings_unreadable`. The output is memory-only:
holdings are never logged, put in a URL or sent through `networkLogger`.

Result: `holdings: [{deploymentId, runtime, withdrawals: [{recordId, noteId,
mode, phase, expiryTs}], credits: [...]}]` (the runtime entry first) and `slot:
{deploymentId, kind}` with kind `empty`, `draft_only`, `unsent_prepared`,
`pending_deposit`, `note` or `other`. `expiryTs` (seconds) comes from the
matching `deposits` row, else the record's own state. Unclaimed payout credits
are holdings too (a credit-only deployment appears with `runtime: false` and no
withdrawals).

### 5.3 Selection and the decision table

`chooseZkapiVersion({table, holdings, prefer})` is a pure function of the table,
the holdings and one validated one-shot `prefer`. It reads no URL, hash,
`localStorage` or network. "Load target" is the deposit target, else the newest
live version. First match wins:

| # | Condition | Result | `reason` | Deposit block |
| --- | --- | --- | --- | --- |
| 1 | one live version and no tombstone | that version; the database is not even opened | `single_version` | none |
| 2 | the probe threw, timed out or returned malformed holdings (not an array, malformed entries, two runtime owners) | load target | `holdings_unreadable` | `holdings_unreadable` |
| 3 | the runtime slot's owner maps to a live version X | X | `runtime_holds_note` | none |
| 4 | the owner is a retired tombstone | load target | `retired_deployment` | `foreign_runtime` |
| 5 | the owner is unknown, or has no deployment id | load target | `unknown_deployment` | `foreign_runtime` |
| 6 | slot empty and `prefer` names a live version other than the load target that holds an open withdrawal or unclaimed credit | that version | `requested_previous` | none |
| 7 | slot empty | load target | `no_runtime_note` | none |

The slot owner always wins (rows 3 to 5 never consult `prefer`). Open
withdrawals and credits of every live version are reported in
`selection.open` and `selection.credits` for banners; consumers must filter out
the loaded version's own id. Row 6 never selects the version that would load
anyway, so the "Version 1 could not be reached. Return to version N." copy
cannot go circular. A user whose only state is an open legacy withdrawal lands
on the target with a banner and an "Open version P" button (P is the version
with the unfinished withdrawal); the target's gate blocks deposits meanwhile.

The table is generic over N versions; a version 1 holder is offered an upgrade
straight to the current target, never through intermediate versions.

Row 3 with slot kind `note` is also the host's own evidence that a balance of
that version is saved in this browser, which the state uses for one thing the
SDK cannot say when it did not start: the empty snapshot of a version that
failed to start is not an empty balance
([5.10](#510-a-balance-the-page-holds-and-cannot-read)). Row 1 reads nothing, so
a lone live version has no such evidence.

Optional inputs beyond the three above: `chooseZkapiVersion`
takes `slotKind` and `draftDiscarded` so a `Selection` can report them;
`selectZkapiVersion` takes `canDiscard`, `noteDiscard` and the older
`recordDiscard`; `discardDepositDraft` takes `timeoutMs`, `expectedDeploymentId`
and `now`. The watcher must pass the probe's `slotKind` into every preview, or an
owned slot reads as `other` and a boot-time draft would be forgotten.

**Draft discard before deciding.** When a deposit target exists, row 3 picks a
different live version and `slot.kind` is `draft_only` or `unsent_prepared`,
selection tries the host
discard ([5.5](#55-host-writes-to-the-wallet-slot)) and decides again on a
fresh read:

- `canDiscard()` (read-only loop-guard check) is asked before the attempt;
  `noteDiscard()` charges the guard only after a discard that happened.
  A refused attempt, a busy lock or a slot with nothing to clear is not charged,
  so reloads beside a busy tab cannot raise the loop notice without a write. (The
  older `recordDiscard` option, which checks and charges once before the
  attempt, still works when neither new option is given.)
- **Lost race.** Several tabs booting together all see the same pinned draft and
  only one can clear it: the others get `lock_busy`, or `not_discardable` once it
  is gone. They read once more and decide on what is there (with
  `draftDiscarded: false`). Only a read that still shows the pin returns the
  pinned version. `no_locks`, `unreadable`, a throwing discard and a loop-guard
  refusal do not re-read, which keeps the boot budget.
- `selection.draftDiscarded` means "cleared and not back": it is false when the
  slot is pinned again by a discardable kind on a non-target version after the
  discard, so UI consumers need no suppress logic.

### 5.4 The shared wallet database

All versions of a network share one IndexedDB,
`zkapi-browser-wallet-fresh-20260930-{network}-v1` (today's renamed database),
rather than one database per version or the SDK default.

Why shared:

- Only a shared slot lets tabs still running pre-rollout JavaScript (the
  single-version build, same database name) see the same records. Their runtime
  refuses a slot another deployment holds ("This browser contains a wallet for
  `<id>`"), which is what protects a note from a stale tab. A separate database
  would show them an empty slot and let them deposit.
- The successor SDK's `other_deployment_withdrawals` and
  `other_deployment_credits` reports can only name the other generation's
  records when both read the same database.
- The default database `zkapi-browser-wallet-v1` holds retired pre-reset notes;
  a successor SDK would hard-refuse the runtime slot there with no build able to
  clear it, inviting "clear site data". Upstream documents sharing the default
  database; this app deliberately uses the lineage-scoped one for both versions.

Invariants (each asserted at build or in tests):

| Invariant | Enforced by |
| --- | --- |
| database version is `walletDatabaseVersion` (3), never bumped | build asserts each store's `DB_VERSION` literal |
| the lock and BroadcastChannel are `zkapi-wallet:active-runtime`, unrenamed | build asserts both literals; `WALLET_LOCK_NAME` in walletHoldings is pinned to them |
| only the `DB_NAME` declaration of a hash-pinned store is rewritten | `sdk.storeSha256` plus single-occurrence check |
| one SDK per page | exactly one variant imported; `loadVariant` refuses a second id; `configure` throws after init. `globalThis.zkapiClient`, `localStorage` `zkapi-browser-deployment` and `zkapi-withdrawal-v2`, the tab-owner key, the lock and the channel are identical in both SDKs |
| a build switch is a full reload | `requestVersionSwitch` ends in `location.reload()` |
| the host writes the slot in two places only: the guarded draft discard and the confirmed give-up of a zero or dust balance | `readWalletHoldings` and the history reader are read-only. `discardDepositDraft` clears a provably unused draft under the wallet lock; `giveUpBalance` retires a bare note through the SDK's own `archiveBrowserWallet` transaction under the same lock ([5.5](#55-host-writes-to-the-wallet-slot)) |
| Web Locks are load-bearing | the discard and the give-up refuse when `navigator.locks` is absent (fail closed): without locks two builds overwrite each other |
| never clear site data to get past a check | upstream rule; no code path does |

#### Payment history of the other versions

Every list a loaded SDK builds (deposits, withdrawals, expiry history) is
filtered by its own deployment id, so after a build switch the records of the
other versions sit in the shared database and are shown by no build. No SDK read
can serve them: the unfiltered `readBrowserWalletSnapshot(null)` writes
(it back-fills deposit rows), and the SDK is only available after the version
is chosen. The host therefore reads them itself, in
[otherVersionHistory.mjs](../chat/zkapi/versioning/otherVersionHistory.mjs),
under the same read-only rules as the holdings probe, and shows them in the
Payment history of the balance dialog next to the loaded version's own:

- **Read-only, bounded, memory-only.** `readOtherVersionHistory({database, table,
  loadedDeploymentId})` shares the probe's helpers
  (`openExistingDatabase`, `createDeadline`, which `walletHoldings.mjs` exports
  for it), opens the database without a version (it can never
  create or upgrade one), runs ONE readonly transaction over the `deposits` and
  `withdrawals` stores, takes no wallet lock, closes its connection and gives
  up after 2 s (`history_unreadable`, `history_timeout`: unknown, never
  "empty"). It never loads the runtime slot (note secrets, plans, journals) or
  the archives (note states, and the request journals and evidence of newer
  SDKs, which hold proofs). Each store is read with a cursor and every stored
  record is reduced through the allowlist as it arrives, so at most one raw
  record (a withdrawal record carries note state, plan and proof) is in memory
  at a time, never a whole store; a result that is not a cursor is
  `history_unreadable`. Nothing is stored, logged or sent: rows live in the
  facade's memory and are replaced by each read.
- **An allowlist, not a filter.** A pure projection
  (`projectOtherHistory`) copies only the public fields it names
  (`DEPOSIT_ROW_FIELDS`, `WITHDRAWAL_RECORD_FIELDS`); a field a newer SDK adds
  is ignored until someone classifies it, and a drift test fails until then.
  Every private field of the fixture carries a `SECRET-` marker that the output
  must never contain.
- **Which rows.** Deposit rows, withdrawal records and a note's treasury expiry
  claim, newest first, at most 100 of each kind. A withdrawal that needs
  attention (open, an unclaimed credit, a payout alert) is kept ahead of closed
  ones and never cut; when anything is cut the list ends with one "older
  payments aren't shown" row. The loaded deployment is excluded, and so is every
  row when the loaded deployment is not one the table names. A deployment with
  no table row is "Earlier version", with no amount. Rows are keyed by
  (deployment id, note id): note ids repeat across vaults.
- **Units.** A row's amount is in the unit of its own version's adapter
  (`billing`: asset, unit, `perEth`). A dollar figure comes from the loaded
  SDK's formatter only when that unit is exactly the loaded one
  (`sameUnitAsLoaded`); otherwise the row shows ETH computed from its own
  `perEth`, and a unit that is not a power of ten shows no amount.
- **Expiry rows** are derived with a port of the SDK's `deriveExpiryRecords`
  (the newer rule: a credited payout, or an escape that already finalized,
  suppresses the expiry row) and re-evaluated at render time, so a deadline that
  passes appears without a re-read. The installed legacy SDK's own rule lacks
  the credited-payout clause, so a legacy-only build can show a credited
  escape's note as expired; the host port follows the newer rule. Parity is
  tested against the installed legacy module (fuzzed) and against vectors
  produced by the real `0.2.0` module.
- **No actions.** A foreign row carries none of the `data-sync-withdrawal`,
  `data-finalize-withdrawal`, `data-withdraw-background`,
  `data-restore-withdrawal`, `data-retry-*` or
  `data-cancel-background-preparation` hooks: another vault's note id would be
  sent to the loaded vault. The only control is "Open version P" (a
  `data-zkapi-history-open` button), offered only when
  `state.previous.versionId` is that version and `previous.canOpen`; it asks
  the facade for a build switch with reason `finish_previous` or
  `claim_credit` and view `withdrawals`. When this version's own balance holds
  the wallet the row says why instead ("withdraw or finish the balance on this
  version first"), and a balance a newer device used is explained with no
  button.
- **No promise it cannot keep.** The loaded SDK never reconciles another
  deployment's records, so a foreign status is the last value the other build
  wrote. The words never say that confirmation continues automatically and
  never offer "Check status". For a retired or unknown version they say the
  app can no longer open it; there is no in-app claim for such a payout
  ([11.5](#115-known-limits-and-support-runbooks)).
- **Facade.** `facade.history` exists only on a build with versions to tell
  apart: `status()` (`idle`, `loading`, `ready`, `unreadable`), `rows()`,
  `ensureFresh()` (shared, reused for 10 s, never rejects), `invalidate()`
  (marks stale; the watcher's preview calls it) and `signature(nowMs)` (changes
  when a read changes a row or a deadline passes, never on a balance or a
  ticking time; `ui.historyItems` and `ui.historySignature` read the clock
  when the caller gives none, so the deadline rows the signature counts are
  also drawn). The dialog calls `ensureFresh()` when it opens, when Payment
  history opens and on a facade announcement while the history is visible,
  never from a render. History rows stay out of
  `rawSnapshot()`, the upgrade intent and `provesUpgradeWithdrawal`.
- **Not done.** The SDK's deposit back-fill is not ported: both SDKs back-fill
  deposit rows on every read of their own deployment, so a deployment that was
  ever loaded by a build that writes them has its rows, and one that never was
  has none. Foreign USD figures use the loaded SDK's current price, not a
  historical one.

### 5.5 Host writes to the wallet slot

The host never writes the wallet slot, with two documented exceptions, each
under the SDK's own cross-tab wallet lock and each re-verified on a fresh read
inside it: the automatic discard of a draft that pins a closed version (below),
and the confirmed give-up of a zero or dust balance that pins an exit-only
version ([the second half of this section](#giving-up-a-balance-a-user-gesture)).
Everything else the host does to the wallet database is a read.

#### Draft discard (automatic)

A draft (`depositQuote` only) or a never-sent prepared plan pins the runtime
slot to its version; a version that no longer accepts deposits cannot discard
its own, so the user would be stuck on it. `discardDepositDraft` is the first of
those exceptions
([ZKAPI_RECOVERY_REVIEW.md](ZKAPI_RECOVERY_REVIEW.md) describes the SDK-owned
side):

- It runs only for a non-target live version and only for kind `draft_only` or
  `unsent_prepared`. `unsent_prepared` uses the `canceledDeposit.mjs` predicate
  verbatim ([unsentDeposit.mjs](../chat/zkapi/versioning/unsentDeposit.mjs)), and
  the host additionally requires the plan to carry only known plan fields.
- It requests `navigator.locks` `zkapi-wallet:active-runtime` exclusively with
  `{ifAvailable: true}` (never waits), then in ONE readwrite transaction
  re-reads the slot, re-verifies `version === 1`, the owner (`expectedDeploymentId`)
  and that every key is a known field, and puts the slot back with
  `depositQuote: null` (and `pendingDeposit: null` for an unsent plan). Every
  other field keeps its value and position. After the commit it posts
  `{updatedAt}` on the SDK's channel so other tabs re-read.
- Safety: promotion to `pendingDeposit` is atomic under the lock, and the
  submission claim (`phase: awaiting_wallet`, `submissionId`, `submissionOwner`)
  is committed under the same lock before any wallet prompt, so a claimed or
  sent plan is visible here as such and is never touched; a stale tab whose
  claim loses the race gets "durable pending deposit is missing" and signs
  nothing.
- `selection.draftDiscarded` shows a dismissible one-line notice ("Cleared an
  unused deposit quote. Nothing was spent.").
- Ping-pong guard: a pre-rollout tab with the Send Ethereum screen open
  re-creates its draft every few seconds. The loop guard allows at most 2
  discards per 60 s; beyond that discards stop and the notice reads "Close other
  open tabs of this app, then reload."
- User-gesture fallback: in the loaded closed version, "Cancel unfinished
  deposit" calls `discardUnsentDeposit` in
  [canceledDeposit.mjs](../chat/zkapi/services/canceledDeposit.mjs) (the
  SDK-sanctioned `runtime.commit` under the same lock, same predicate), then
  offers Reload. It never sets the dialog's busy flag, because the facade refuses
  a discard while the dialog is busy.
- Known gap: where storage is readable but not writable, `canDiscard` allows the
  boot discard uncharged (bounded to one per page load).

#### Giving up a balance (a user gesture)

The loader gives the owner of the runtime slot priority, the deposit target
cannot take a non-empty slot, and deposits are closed on an exit-only version,
so a holder of a few cents there is pinned to it. Before this action the only
ways out were an Ethereum withdrawal (its network fee can exceed the balance)
or waiting for expiry and the treasury's claim, up to the note's lifetime.
`giveUpBalance` in
[abandonedNote.mjs](../chat/zkapi/services/abandonedNote.mjs) is the second
exception to "the host never writes the slot". It is reached only by the
confirmed action of [7.9](#79-giving-up-a-zero-or-dust-balance), never at boot.

**The write**, in this order:

1. Refuse unless the protocol family opted in (`adapter.abandon.supported ===
   true`) and the operator switch is stated as on (`enabled === true`, computed
   by the facade as `transition.abandonEnabled !== false`). Both are enforced by
   the service itself, before anything is read or started, so a caller that
   forgets either one is refused (`not_applicable`, `disabled`).
2. Without `navigator.locks` refuse (`no_locks`): nothing would serialize the
   write with another tab's chat or withdrawal.
3. `await runtime.init()` BEFORE taking the host's lock. The SDK's own
   initialization takes the same lock and Web Locks are not re-entrant:
   awaiting it inside the lock can never finish. The loaded manifest must then
   name the deployment the person was shown (`config_mismatch` otherwise).
   Request `zkapi-wallet:active-runtime` exclusively with `{ifAvailable: true}`;
   a busy lock is `lock_busy` and nothing waits. This `init()` is also why a
   balance whose version's SDK did not start cannot be given up: the legacy
   SDK's initialization loads the operator's manifest before it opens the
   wallet, so with that operator down it rejects and nothing is written. The
   facade does not offer the action for such a balance at all
   ([5.10](#510-a-balance-the-page-holds-and-cannot-read)).
4. Inside the lock: `runtime.reload()`, read the client's facts once (a getter
   that throws is an unknown, never "no claim"), the store's request archive
   when the SDK has one (the service reads the store through its namespace, so
   the successor's `listBrowserRequestArchive` is reached exactly when the
   installed SDK exports it and an SDK without one links all the same; one that
   cannot be read is an unknown, not an empty archive), and every withdrawal
   record unfiltered by deployment, then evaluate the strict verdict on that
   fresh read.
5. `store.archiveBrowserWallet('abandoned', noteId)`: one IndexedDB
   transaction, owned by the SDK, over the slot, the archives and the deposit
   history. It compares the note id again inside the transaction and aborts if
   the slot holds another note (the last defence against a writer that takes
   no lock). The note, secret included, is kept in the `archives` record; the
   deposit history row stays.
6. Still inside the same lock callback: `runtime.reload()` and
   `runtime.notify()`. The SDK forbids an unlocked reload, which could install
   an older slot over a writer's newer one.

Not used, on purpose: `runtime.archiveNote` (it takes the wallet lock itself,
so inside the host's lock it deadlocks, and outside it leaves a gap between the
check and the write), `runtime.commit({state: null})` (destroys the secret),
parking the note (needs an irreversible clearance and leaves an open record
that keeps the version gated) and a host IndexedDB write (a second author of
the SDK's schema).

**The verdict** (`abandonVerdict`, pure; `blockedBy` is one of
`ABANDON_BLOCKED_BY`) refuses unless every condition holds, and treats a fact
that is absent, of an unknown shape or unreadable as a refusal:

- the family opted in and the switch is on; the slot holds a note of the loaded
  deployment, and it is exactly the note id and balance the person was shown
  (`changed` otherwise);
- the slot holds a **bare** note: its keys are exactly `state` plus known
  metadata. A journal, a lease, the tab's own unsettled chat key, a prepared
  withdrawal, a pending deposit or quote, a truthy exit lock, an unfinished
  late attempt (the archive keeps those, and they would pin the slot with the
  balance gone), a key this build has never heard of, or a malformed state each
  refuse;
- no open withdrawal record of any deployment of this wallet (a record that
  names no deployment counts as this one), no confirmed treasury claim for the
  note (that state has its own "Start a new balance"), no unresolved request
  and no non-empty request archive. An expired-but-unclaimed note is allowed;
- the balance is zero, or dust ([the money rule](#the-money-rule)).

**Family opt-in.** `note-bound-v1` is `supported: true`. `concession-v1` is
`supported: false` until it has its own recovery review: its store's archive
also supersedes the note's request-journal archives and drops the exit lock,
billing asset, state sequence and exit-kit mark, none of which the verdict has
been reviewed against. The request-archive refusal is deliberately coarse for
the same reason (any record of the deployment refuses) and is replaced by that
family's own rule when it is reviewed, not loosened by guessing.

##### The money rule

Amounts are gwei. A balance of 0 is eligible with no price. Otherwise

```
limit = min(ceiling, max(chargeCap, units worth the threshold at the quote))
dust  = 0 < balance < limit
```

- `chargeCap` is the deployment's `request_charge_cap`: below it the SDK
  itself cannot issue a chat key, so the balance cannot pay for one chat.
- The threshold is `transition.dustThresholdUsdMicros`, default and maximum the
  smallest chat key (one dollar, which is exactly what the SDK refuses below).
  The line is the larger of the cap and the threshold at the quote, then held
  under the ceiling: with a cap of 50,000 gwei and the default threshold it is
  the ceiling below about $200 per ETH, the threshold from there to about
  $20,000 and the cap above that.
- The **ceiling** (`adapter.abandon.dustCeilingUnits`, 5,000,000 gwei, 0.005
  ETH) is an absolute amount that does not depend on the quote. The SDK accepts
  any feed answer in `(0, 1e18]`, so a depressed quote would otherwise turn a
  multi-ETH note into "dust". ETH is always shown beside any dollar figure.
- A missing, malformed, expired or future-dated quote is never used. Without
  one, only the quote-free part applies, and a balance at or above the charge
  cap is `price_unknown` ("check the price"), never guessed. A missing charge
  cap means zero only.

**What it changes.** The slot is empty, so the loader picks the target on the
next load; other tabs see the neutral reason `previous_withdrawal_finished`
(never "Withdrawal confirmed"); the facade clears the upgrade intent so no
false "Upgrade complete" appears. The exact balance is kept out of VersionState
and the fingerprint (only `{available, kind, blockedBy}` are in them), so a
chat spend does not re-probe. A tab on pre-rollout JavaScript can still re-pin
the slot (a documented limit).

**No undo in the app.** The `archives` record keeps the full note state.
[ZKAPI_RECOVERY_REVIEW.md](ZKAPI_RECOVERY_REVIEW.md#confirmed-give-up-of-a-zero-or-dust-balance-2026-10-13)
holds the support procedure that commits it back under the wallet lock, which a
test performs against the real store.

**Safety argument.** The value is bounded by the money rule above: a balance is
dust only below the smaller of the 0.005 ETH ceiling (which does not depend on
the quote) and the larger of the request charge cap and the smallest chat key
at the current quote. So it never exceeds 0.005 ETH, and it is under one dollar
except where one dollar is worth less than the charge cap (above about $20,000
per ETH with the 50,000 gwei cap of the reviewed profiles), where the cap is
the line instead. The dialog shows the ETH amount beside any dollar figure, so
what is given up is stated exactly. No funds move and the deposit
is swept at expiry as it would have been; the secret and the history are
retained by the SDK's own transaction and restorable by a tested procedure;
every SDK writer takes the same lock and re-checks inside it, so the decision
and the write are atomic against them; the check is strict and fails closed on
unknown shapes and on protocol families not reviewed for it; the gesture is
explicit and its confirmation bound to what was shown; the operator can switch
it off per version; nothing happens at boot.

### 5.6 Switching builds: the switch protocol and the loop guard

[switchProtocol.mjs](../chat/zkapi/versioning/switchProtocol.mjs):

- A switch is always a full page reload. `requestVersionSwitch({reason, view,
  prefer, from, canReload})` refuses while work is in flight (`why: 'busy'`) and
  refuses a third switch in 60 s or an unwritable guard (`why: 'loop'`). It
  writes the sessionStorage hint, rewrites `oa-zkapi-running-modal` to the
  intended view (or removes it) and calls `location.reload()`.
- Reasons (fixed enum): `upgrade_withdrawn`, `moved_in_other_tab`,
  `previous_withdrawal_finished`, `finish_previous`, `claim_credit`,
  `draft_cleared`. Views: `balance`, `fund`, `withdrawals`.
- It throws only for a `reason` or `from` outside the sets (a caller bug). An
  unknown `view` becomes null (the reloaded page opens on its default view and
  the saved view is removed) and a `prefer` that is not a version id is dropped.
- `consumeVersionSwitch` runs once at boot. It deletes the hint before
  validating it and accepts only: `v: 1`, an age under 5 minutes, enum reason
  and view, a `from` that is in the table, and a `prefer` that is a non-retired
  table version. Anything else yields no hint.
- The loop guard is a separate key that consuming a hint never clears:
  timestamps of switches and discards, at most 16 entries, a 60 s window, at
  most 2 switches and 2 discards per window. Storage failures resolve to "do not
  switch / do not discard".
- The numbers are the constants `LOOP_WINDOW_MS`, `MAX_SWITCHES_PER_WINDOW`,
  `MAX_DISCARDS_PER_WINDOW`, `SWITCH_HINT_MAX_AGE_MS` and
  `UPGRADE_INTENT_TTL_MS` of switchProtocol.mjs: engineering bounds of this app,
  not upstream rules.
- A page never reloads itself with work in flight. A mid-session change shows a
  Reload button gated by `canReload` (no busy provider and no running activity);
  `AccountModal` and the chat runtime register busy providers.
- The upgrade intent ([7.3](#73-guided-upgrade-stages)) lives in `localStorage`
  and survives a new tab; it holds ids and a stage only.

### 5.7 The watcher and `stale_build`

[versionWatcher.mjs](../chat/zkapi/versioning/versionWatcher.mjs) runs only in
versioning-active builds. It is receive-only on the wallet channel (it never
posts).

- **Holdings.** On `focus`, on becoming visible, on a message on
  `zkapi-wallet:active-runtime` and when the SDK's normalized snapshot
  fingerprint changes (debounced 500 ms, probe bounded to 2 s) it re-probes,
  computes what a fresh load would pick (`chooseZkapiVersion` with the probe's
  `slotKind`, and `prefer` = the loaded id when the boot reason was
  `requested_previous`) and hands that preview to the facade. The facade turns
  it into `reload-required`, `ready_to_switch` and the rest. A preview that picks
  another version does not require a reload while the loaded version still has
  an open withdrawal or credit (otherwise "Open version 1" would loop); a
  preview of `holdings_unreadable`, `unknown_deployment` or `retired_deployment`
  never requires one. The fingerprint is the adapter's `watchFacts(reading)`:
  the facts that move with every settled chat (the exit kit's state sequence, a
  lock's re-based instant, a pending request's freshness, bound and earliest
  time, the cost warning) are removed by name, so a chat never reads the
  database, while anything else, including a field added later, still wakes
  it. Another deployment's unfinished record and an exported kit wake it once.
- **Discard retry.** When the lock was busy at boot it retries the discard every
  10 s, at most 6 times. The loop guard is charged once per pinned draft, before
  its first attempt, so a person whose other tab is merely mid-settlement is not
  told to close tabs. Each successful discard ends that pin and the next is
  charged again.
- **Build status.** `/build.json` (relative to the base URI, `cache: 'no-store'`,
  `credentials: 'omit'`, the endpoint the app's own update check uses but
  independent of the update toast's dismissal) is fetched every 5 minutes while
  the page is visible and when it becomes visible; there is no request at boot.
  The `stale_build` latch is **restrict-only**: it sets when the fetched
  `zkapi.depositTarget` is non-null and differs from the loaded bundle's, or the
  fetched status of the loaded version is no longer `active` while the bundle
  says `active`. It makes `canStart` false ("Reload to update before
  depositing"), leaves `canResume` and exits untouched, and only a reload clears
  it. A failed fetch, a different network, a build with no zkAPI section and any
  unrelated deploy change nothing.
- Honest limit: operator-side closure is the only control for tabs running
  pre-rollout JavaScript. Such a tab can still start a legacy deposit until it
  reloads; the shared slot protects the note, not the cost. The latch protects
  only the tabs of a bundle that already contains the watcher: the bundle that
  precedes a first activation is today's dormant single-version build, which
  has no watcher and no latch. Its tabs can still see the app's own update
  toast (the general update check polls `/build.json` too), which invites a
  reload and closes nothing.

### 5.8 Cross-tab behavior and error mapping

- A change in another tab reaches this one through the SDK's own subscription
  (snapshot changes) and the channel, then the preview above.
- The SDK refusal "This browser contains a wallet for `<id>`" is mapped in
  [zkapiErrorCopy.mjs](../chat/zkapi/services/zkapiErrorCopy.mjs) by
  `selection.reason`: a live-version holder gives the reload-required copy
  ("moved to version R in another tab ... Nothing is lost"), a retired or unknown
  owner the retirement copy (which never claims "Nothing is lost"),
  `holdings_unreadable` "We could not read your saved balance. Reload to try
  again."
- `deposits_closed`, `previous_withdrawal_open` and `deployment_retiring`
  errors are mapped to the copy table in the same module.
- A revision 3 SDK's refusals about exiting a balance and its paused service
  are mapped as well, in plain words and never with the SDK's own text (which
  can name an operator URL or an exit RPC the host has no control for): the
  four manifest codes of a paused service only together with status 503 and
  `data.exits === true` (the legacy SDK's `incompatible_proof_circuit` has
  neither and is never a paused service), `native_vault_unverified`,
  `note_near_expiry`, `device_not_newest`, `request_settlement_pending` (the
  withdraw shape that carries `escape_at`; the chat shape is left to the SDK's
  words), `ownership_proof_wait`, `exit_release_pending` and `exit_locked`.
  [exitRefusal.mjs](../chat/zkapi/versioning/exitRefusal.mjs) reads each once
  ([the units trap](#the-units-trap)).
- `explainZkapiError(error, {about})` is called on every error path. Before it
  rewrites, it tells the facade (`noteRefusal(error, about)`) so the balance can
  say what happened as a notice and not only as a toast; `about` is
  `{noteId}` or `{recordId}` when the attempt was about something other than the
  balance in the slot.
- The error that stopped a version's SDK from starting is mapped too, but only
  while the page holds a balance it cannot read
  ([5.10](#510-a-balance-the-page-holds-and-cannot-read)). The SDK's text for it
  names the operator's address, so `facade.isStartFailure(error)` (true for the
  error object, or the `cause` of one, that the client held while it was not
  started) turns it into the one sentence `held.summary`, in place, on the
  dialog's paths (`explainZkapiError`), in the page-wide `zkapiErrorMessage` and
  at the chat runtime's own start (`checkCanSend`, closing a chat key, the
  settlement's last failure). At the chat runtime's calls it is scoped to that
  error on purpose: any other error from the same start, including one the
  version words reword on the dialog's paths (a retiring deployment, a closed
  deposit), keeps the SDK's text at that call.
- All the rewrites apply only when the build is versioning active
  (`isVersioningActive`). An SDK-default page and a page with one `active` row
  keep the SDK's own words, because the rewritten sentences name a version in an
  app that never shows a version number. The Welcome dialog likewise routes its
  payment-service line through the version UI helpers only when they exist
  (`ui.refusalMessage`, which returns its words at once and tells the facade
  after the caller's stack has unwound, because the panel asks while it
  renders).
- A stale pre-rollout tab keeps working only as far as its own runtime lets it:
  its `reload()` refuses over a slot another deployment holds.

### 5.9 The runtime facade

[versioning/index.js](../chat/zkapi/versioning/index.js) exports the singleton
`zkapiVersioning`, attached to the SDK client as `zkapiClient.oaVersioning`. It
is SDK-free and inert unless the build is versioning active. It never signs,
broadcasts, deposits or reloads on its own.

| Member | Purpose |
| --- | --- |
| `multiVersion`, `active`, `target`, `table`, `selection`, `ui` | context getters (`ui` is null until the notices load or when dormant) |
| `depositGate()` | `{canStart, canResume, code, successor}`; never throws |
| `sendGate(now)` | `{canSend, code: null or 'near_expiry'}`; fails open. `near_expiry` comes from the adapter's host cutoff (`chatCutoffSeconds`) or from the SDK's own `exit.nearExpiry` flag; a held refusal never pre-blocks a chat. The chat runtime asks it only for a send that would open a new key |
| `state(now)`, `subscribe(fn)` | the `VersionState`, or null when dormant; subscribers hear snapshot changes, tier boundaries, watcher events and session flags, never clock ticks |
| `previewSelection()`, `requestSwitch(...)`, `registerBusy(fn)` | watcher preview, reload request, busy provider |
| `beginUpgrade()`, `endUpgrade()`, `markWithdrawn()`, `abandonUpgrade()`, `upgradeStage()` | upgrade view and persisted intent ([7.3](#73-guided-upgrade-stages)) |
| `acknowledgeReminder(tier)`, `lastReminderTier()` | reminder tier memo |
| `discardUnsentDeposit()` | the user-confirmed discard |
| `noteSignal('deployment_retiring')` | monotone `admissionClosed` flag |
| `noteRefusal(error, about?)` | hold what a refused attempt said (below); never throws, idempotent per error object, a no-op on a page with one version |
| `recheckService()` | `Promise<{ok: true} \| {ok: false, why: 'unavailable' \| 'still_unavailable' \| 'busy'}>`: the SDK's own `runtime.assertServiceAvailable()`, the check every deposit and chat starts with. `unavailable` means this page's runtime cannot be asked (the caller offers Reload) |
| `isStartFailure(error)` | `true` only for the error object (or the `cause` of one) that this page's SDK client held while it had not started, and only while `state().held` is set ([5.10](#510-a-balance-the-page-holds-and-cannot-read)). `false` on a page with one version and for every other error; never throws. The chat runtime and `explainZkapiError` use it to say the plain sentence instead of the SDK's text, which can name the operator |
| `exportExitKit(passphrase)`, `canExportExitKit()`, `noteKitSaved(saved)` | the exit kit ([7.8](#78-the-exit-kit)): the SDK's `client.exportExitKit`, rejecting `{code: 'exit_kit_unavailable'}` where there is none; keeps neither the text nor the passphrase. `noteKitSaved(false)` keeps the "created, not saved" fact in memory for the slot note |
| `formatAmount(units)` | the page's money words (`client.formatMoney`, else ETH), `''` when it cannot be said |
| `operationRecheckRequired()` | `true` when the loaded family lists `withdrawal-operation-recheck`: the only thing that turns the recheck of a withdrawal on ([11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)) |
| `abandonPreview()`, `giveUpBalance({noteId, balanceUnits})` | giving up a zero or dust balance ([7.9](#79-giving-up-a-zero-or-dust-balance)); only offered when boot supplied the service. For a balance the page cannot read the preview is null and the call answers `{done: false, why: 'unavailable'}` without calling the service |
| `history` | only on a build with versions to tell apart: the other versions' payment history ([5.4](#54-the-shared-wallet-database)) |
| `flags()` | booleans `draftDiscarded`, `discardLoop`, `admissionClosed`, `staleBuild`, `configMismatch`, `withdrawalConfirmed`; part of what subscribers are told about |
| `attach`, `attachUi`, `watch` | host plumbing (boot, late notices, watcher); UI code must not call `watch`. `attach` and `resetForTests` forget every refusal, latch, kit flag, history and in-flight state, the failed-start latch and the errors it remembered included (a facade attached to another client carries nothing of the first one's failure); `resetForTests` is a test hook |

The gate is fail-open in exactly one situation: the build is not versioning
active. A versioning-active build with no installed version (boot failed or has
not finished), an adapter that does not resolve, or any exception while deciding
yields `{canStart: false, code: 'version_unavailable'}`.

`VersionState` fields worth knowing (the full typedef is in
[versionState.mjs](../chat/zkapi/versioning/versionState.mjs)):

- Units: `closeByTs` and `expiryTs` are epoch **milliseconds**, the unit of
  `now`; the SDK's note expiry and the normalized snapshot's `expiryTs` are
  seconds.
- `show` is the pill switch only (`liveCount > 1`). Notices key on `gate` and
  `phase`, never on `show` alone.
- `reminderTier` and `closeByTs` are non-null only where an upgrade applies: the
  loaded `exit-only` version with a target, or another version's set-aside
  records. On the deposit target `expiryTs` is informational, so a toast can
  never say "7 days left to upgrade" to someone with nothing to upgrade to.
- `claimed` is an optional input of `deriveVersionState` (the facade passes
  `client.noteExpiryClaim`): the normalized snapshot has no field for a treasury
  claim, so the pure function alone never emits it.
- `notices` (additive): the bounded, unescaped text of each operator
  `stuck_escape` notice that relaxed the gate for a record this browser holds,
  with its `noteId` (shown only as "Reference number N" beside its version, the
  one place a note number appears).
- Facts about the balance, additive and (with one exception, `held`) never
  phases, all JSON-plain: `service` (`{message, code}`; the SDK's message is
  never shown, the words follow the code), `exit` (the slot note's near-expiry
  flag, `mustInitiateByMs`, `boundAtState`, `stateFresh`, `escapeAtMs`, `frozen`
  `{untilMs, mode}`, `deviceNotNewest`, `wait` `{kind, untilMs, escapeAtMs,
  mustInitiateByMs, boundAtState}`, `kit` `{exported, outOfDate,
  depositPathSaved, unsaved}`, `rpc` `{recommended, wrongChain}`; null with no
  slot note), `payouts` (`{credited, alerts}`), `setAside` (`{near,
  earliestMustInitiateByMs, device}`), `abandon` (`{available, kind,
  blockedBy}`) and `held` (`{unreachable: true}` or null). Facts that came from
  a refused attempt can only tighten these, never loosen one; every `...Ms` is
  epoch milliseconds inside a believable window, otherwise null.
- `held` is the one fact that is also a phase. It says this browser holds a
  balance of the loaded version that the page cannot read because that
  version's SDK did not start: `phase` is `balance-unreachable`, `holding` is
  never `none`, `upgrade.blockedBy` and `abandon.blockedBy` are
  `service_unreachable`, and every fact above that comes from the SDK's
  snapshot (`exit`, the deadlines, `payouts`, `setAside`) says nothing
  ([5.10](#510-a-balance-the-page-holds-and-cannot-read)).
- A set-aside record this device may not exit (`deviceFlagged`) is kept in the
  full set-aside list, so it does not make the phase `withdrawing`, but is out of
  the actionable list: it drives no upgrade nudge, tier or reminder.
- `previous`: `{versionId, openWithdrawals, credits, canOpen, closeByTs}`;
  `canOpen` needs an empty slot and no busy work, because the loader honors a
  preference only for an empty slot. For a set-aside-only holder on an exit-only
  version, `previous.versionId` is the loaded version itself and the action is
  Withdraw or Restore.
- `reload`: `{required, canReload, reason, targetId}`; the reason is only as
  specific as its evidence ([7.4](#74-copy-and-evidence-rules)).
- Phase precedence: `reload-required`, `balance-unreachable` (only with
  `held`), `legacy-unreachable` (only when the selection reason is
  `requested_previous`), `service-paused`,
  `admission-closed`, `finish-previous-withdrawal`, `claim-previous-credit`,
  `withdrawing`, `expired`, `upgrade-overdue`, `upgrade-soon`,
  `upgrade-available`, `current`.

**Held refusals.** What an attempt was refused for (a chat key near expiry, a
withdrawal that must wait for a settling chat, a paused service) is held in
the facade, in memory only, so the balance can say it as a notice and not only
as a toast. A reload asks the SDK again; nothing is stored.

- Producers, all on catch paths and none in a render: `explainZkapiError`
  (the dialog's actions), `ui.refusalMessage` (the welcome panel, which tells
  the facade after the call stack has unwound) and the `onAccessRefused` seam
  of [chat/zkapi/api.js](../chat/zkapi/api.js), the one change to the chat
  request path, which acts only when the facade is multi-version, only reads
  the error and rethrows the same object (`note_near_expiry`,
  `native_vault_unverified`, `exit_locked`).
- An error carries no balance, so the caller says which one it was about
  (`about`: `{slot: true}`, `{noteId}` or `{recordId}`). The chat path says
  `slot`, since a chat key is always drawn from the slot balance; the dialog
  names the slot note for a withdrawal of the shown balance and the record for
  every button of a set-aside record. A refusal about another note or record,
  or about a note that is not the slot note, is not attached to the slot
  balance at all. A refusal nobody tied to the slot note is held for 60 s
  whatever it says and is never a standing fact: a set-aside record's refused
  action must not turn the live balance into "used on another device".
- A refusal that states a fact about the balance (`near`, `device`) stands
  until the slot holds another note. A wait ends at its own instant (held 60 s
  past it, extended while the snapshot still reports an unresolved request with
  a later time), and one with no usable instant is held 60 s. A settlement
  refusal is dropped on the first report of `stateFresh === true` after a
  not-fresh reading, never on a snapshot that has not caught up yet.
- The service latch (a refusal that said the service is paused) lasts 5 minutes
  or until "Check again" succeeds. A granted chat does not clear it: the SDK
  reuses an active key without a service check, so it is no evidence that the
  service recovered.
- The state signature includes the history signature and the kit flag, never an
  exact balance or a ticking time; the boundary timer also arms a wait's end, a
  freeze's end and the end of a hold. Every wait the facade performs for work it
  does not control is bounded (history 15 s, the service check 20 s, a give-up
  60 s), so a page is never left "busy" or "loading" for good. A give-up that
  outlives its limit is reported as one that could not be confirmed ("reload to
  see where it stands") and still runs its follow-up when it finishes.

**Chat cutoff and admission.** `sendGate(now)` returns `near_expiry` when the
loaded adapter has `chatCutoffSeconds` and `now >= expiry - cutoff` for the slot
note. `note-bound-v1` uses `23_700` s (6 h 35 m): upstream's lease settlement
bound (21,600 s deadline + 300 s lease TTL + 5 s grace = 21,905 s) plus about
half an hour of margin, chosen here because `3342c95` has no native near-expiry
refusal and an unsettled lease in the last hours can leave a note that can be
neither closed nor escaped in time. `concession-v1` uses `null`: the SDK refuses
new requests itself (`note_near_expiry`), and its snapshot carries the same
fact ahead of time as `config.exit.near_expiry` (computed locally and re-read
by the client's 15-second reconcile; the SDK enforces the rule again at the
call), which `sendGate` reads so that no attempt is made and a notice says so
([7.6](#76-exit-state-notices)); the settlement window is the SDK's, and the
host has no table of its own. The runtime asks the gate in
`checkCanSend`, after the expired check, and only for a send that would open a
new key: a follow-up that reuses the live key of its own session and cap opens
none, so it is not refused and the person is not told that chats are paused
while theirs works. Withdrawals and settlement of existing leases are
unaffected, and the toast does not open the funding dialog because the person
needs Withdraw. The gate exists only in versioning-active builds; a dormant
page never refuses a chat. A 410 `deployment_retiring` (or `retriable: false` at
status 410) from lease acquisition sets the session flag `admissionClosed`,
which stops retries and points to Withdraw; `admissionClosesAt` is copy only.

### 5.10 A balance the page holds and cannot read

A version's SDK has to start before the page can read anything about its
balance. The legacy SDK (`note-bound-v1`, `3342c95`) loads and validates its
operator's deployment manifest first, checks the payment contract against it,
and only then opens the wallet. When that fails (no answer, an answer this page
does not trust, a service on another protocol, a contract the network provider
cannot confirm) the client never becomes initialized, reports the error, and
has no note, deadline or record to show. It attempts the start once per page
load and replays the rejection to every later caller, so a reload is the only
retry. The successor SDK starts without its operator and reports a paused
service instead (`service-paused`; exits stay available), so in practice this
state is a version 1 balance whose operator is down. The host does not depend
on that: any loaded version whose client reports an error and never starts is
treated the same way. (Not to be confused with the held refusals of
[5.9](#59-the-runtime-facade), which are errors an attempt was refused with.)

What every surface would say for such a snapshot is the problem. No note reads
as an empty balance: "$0.00", "Add funds", "Deposits moved to version 2", an
upgrade that is not needed. The balance is in this browser the whole time. The
state names the fact instead.

**How it is detected.** `VersionState.held` is `{unreachable: true}` and the
phase is `balance-unreachable` only when all three of these hold. Each is read,
none is inferred from another:

1. **The host's own read says the slot holds a note of this version.** The boot
   selection, or a fresher readable preview of it, has reason
   `runtime_holds_note`, `slotOwner` equal to the loaded version's id and slot
   kind `note` ([5.2](#52-the-holdings-probe)). A deposit draft, an unsent plan,
   a deposit in flight, another version's slot, an unknown deployment and a
   wallet that could not be read are not it. A preview that says the balance
   moved (a reload is required) ends the fact, and a preview that could not read
   the wallet says nothing, so the boot read stands.
2. **The version's SDK tried to start and did not.** The facade's `startFailed()`
   is true when the client is not `initialized` and has reported an error while
   it was not. A client that has not finished starting has reported none, so a
   slow start is not a failure. The failure is latched: it is set the moment the
   client's own `error` change reaches the facade, and held until the client
   reports `initialized === true` (it is forgotten when the facade is attached
   to another client). The latch is not a nicety. The legacy client never
   recovers from a failed start in place, and a later quiet refresh that a host
   answers with its own page (the production host serves its page for any path it
   does not know) "succeeds", clears `lastError` and leaves the client not
   started, so the error alone cannot be the memory. The same latch keeps
   `legacy-unreachable` from flickering for a previous version that was asked to
   open and did not start. Every error object the client holds while it is not
   started is also remembered (objects only, in memory, forgotten with the
   client), so the one that replaced the error that stopped the start is told
   the same way. Boot does not start the client: the first start is the balance
   dialog's own, made when the app creates it (it initializes the wallet
   method), or the chat runtime's start on a send, and every caller shares the
   SDK's one memoized start.
3. **The snapshot has nothing.** No note and no deadline. A started SDK that
   reads a note, or a set-aside record, is the ordinary balance, and a started
   SDK that reads no note is the opposite fact (the slot really is empty, or the
   SDK disagrees with the host, which the SDK's own reading settles). Only a
   failed start counts.

**What the state says.**

| Field | Value |
| --- | --- |
| `held`, `phase` | `{unreachable: true}` and `balance-unreachable`. The phase is placed right after `reload-required` (a page that must reload is told that first) and before `legacy-unreachable`, `service-paused`, `admission-closed` and the rest, each of which would speak from a snapshot with nothing in it: a paused service's "you can still withdraw" is false while the SDK is not running. The `service` fact keeps its code |
| `holding` | `previous` on an exit-only version, `current` on the deposit target; never `none` |
| `gate` | unchanged on an exit-only version (`deposits_closed`, successor named); `holdings_unreadable` on the deposit target, which closes it ([6.3](#63-gate-codes)). `canResume` is false |
| `upgrade` | `available` false, `canStart` false, `blockedBy: 'service_unreachable'` (where there is a target to move to), `stage: 'idle'` |
| `abandon` | `{available: false, kind: null, blockedBy: 'service_unreachable'}`. The verdict's `no_note` is renamed because it would say the balance is not there, a verdict that offered the action (it had a note to look at) is not believed either, and a verdict that was not computed stays null |
| `exit`, `closeByTs`, `expiryTs`, `reminderTier`, `previous`, `payouts`, `setAside`, `unsent` | nothing claimed: null, 0 or false |
| `reload` | `{required: false, canReload: true}` unless work is in flight, so the one action is enabled |

**What the person sees.**

| Surface | Shows |
| --- | --- |
| System Panel | "Private balance: Saved in this browser" in place of an amount, a quiet "unavailable" pill (not the error styling, and not "attention" when the client holds no error any more), no used or expiry line, no Withdraw and no Add funds; "Balance details" opens the balance. The `held` notice with one Reload |
| Balance dialog | one view, `ui.heldBalance` ([UpgradeView.js](../chat/zkapi/components/UpgradeView.js) `renderHeldBalanceView`): the section "Saved in this browser", the explanation and Reload (disabled, with the reason beside it, while work is in flight). It stands for the balance card, the closed-deposits view, the Withdraw view and the upgrade view, so the four cannot say different things, and the version banner stays out because the view says what its notice says. No wallet-method or funding controls sit above it, and the SDK's start error is not stored as the funding line. Payment history stays. Until the version helpers have loaded, one plain line stands in |
| Welcome | the same view in place of the amount form and the funding buttons; its "Payment service" line is the plain summary; Skip stays |
| Chat bar, composer, balance control | "Private balance unavailable" with the summary sentence, sending blocked. The held fact decides, not `lastError`, so it still says so after a refresh cleared the SDK's error (without it the same client reads as an unfunded wallet) |
| A send, closing a chat key | the toast and the transition message are the summary sentence; no operator address, no `config.json`, no status code |
| Version pill | still "Version N", the version that holds the balance |
| Ticket (OA) mode | nothing: nothing about this balance is at risk there |

**What is withheld.** Everything that needs the started SDK, and it is withheld
both by not drawing it and by refusing it if it is asked for anyway:

| Action | Not drawn | Asked anyway |
| --- | --- | --- |
| Add funds, a deposit | no amount form, wallet-method or funding controls in the dialog or the welcome; the panel button opens the balance, not the funding view | the gate is closed (`deposits_closed` on an exit-only version, `holdings_unreadable` on the deposit target); the deposit guard and the signer refuse as before ([6](#6-deposit-closing)) |
| Upgrade | no call to action, no steps; an upgrade view asked for is the held view | `upgrade.canStart` is false, stage `idle` |
| Withdraw | no Withdraw button on the panel; the Withdraw view is the held view | the SDK has no note to withdraw |
| Give up | no notice, no link in the balance card | `abandonPreview()` is null; `giveUpBalance` answers `{done: false, why: 'unavailable'}` and never calls the service ([7.9](#79-giving-up-a-zero-or-dust-balance)) |
| Exit kit, reminders, near-expiry, settlement and payout notices | nothing: they are all read from the snapshot | nothing to read |
| A new chat | refused at the start of the SDK, with the summary sentence | |

Reload is the only action. It reloads the same build (no switch request, no
hint written; refused while work is in flight) and so asks the SDK to start
again; nothing on the page retries by itself.

**Why nothing else is offered.** A withdrawal reads the note from the client's
wallet status, which is empty until the start succeeds. The give-up, the "Start
a new balance" that follows a verified expiry payment and every other archive
go through `runtime.init()` (or `archiveNote`, which begins with it), and so
through the same manifest load. The give-up's verdict also needs the charge cap
and the price quote that only a started client carries. The host does not read
the note itself: the holdings probe reports a slot's kind and owner, never an
amount, and a host-side withdrawal or archive would be another author of the
SDK's wallet schema for a balance the SDK can still withdraw once its service
answers on a later load. So the page says what is true (saved here, service not
available, reload) and offers nothing else.

**How it ends.** The reload starts the SDK, the client reports `initialized`,
the latch is cleared, `held` is null and the balance is the ordinary one,
equal to a page that had started the first time (subscribers hear the failure
and the return). Nothing was stored: the state is derived on every read from
the boot selection, a preview, the client and the snapshot, in memory.

**Limits, all deliberate.**

- **A start that never answers reads as a start in progress.** The client has
  reported no error, so `startFailed()` is false and the page says what it says
  for any start in progress; a healthy exit-only load shows the same words at
  the same moment. There is no signal that tells a slow start from a hung one
  without a clock, and a timer would call a slow start a failure. A "checking
  your balance" reading needs a new `held` variant and its words on every
  surface (each consumer tests `held.unreachable === true`), so it is a product
  decision (a timeout, or a neutral state), not made.
- **A lone live version has no host evidence.** Row 1 of the decision table
  opens no database, so a lone exit-only version (a registry with one live row
  that is not `active`) cannot say that the slot holds a note: its failed start
  reads as it did before this state existed (an empty balance, `deposits_closed`,
  the SDK's own words). Covering it means probing when the lone live row is not
  the deposit target, which changes row 1 and `selectZkapiVersion`'s "the
  database is not even opened", and makes the reason `no_runtime_note` or
  `runtime_holds_note` instead of `single_version`. Not done.
- **No cause and no deadline.** The words do not say why the service is not
  available, and the page does not know when the balance expires, so there are
  no withdraw-by reminders for it. A note that expires while its service is
  down is claimed by the treasury as ever.
- **Reload cannot help a service that is not coming back.** For a version that
  is retired, or whose operator is gone, the same view says "Reload to check
  again" for ever. That is the retirement precondition below, not something the
  view can fix.

**What a retirement does to a holder.** A browser whose wallet slot still holds
a note of a version cannot be moved on by anything in this app once that
version's service is gone:

- It cannot withdraw it (the SDK that could has no manifest to start from, or
  the version is retired and its build is no longer shipped).
- It cannot give it up or archive it (the same start), and an expired note does
  not release the slot by itself: the slot is cleared only by a started SDK,
  through the person's own "Start a new balance" after a verified expiry
  payment or a confirmed give-up.
- It cannot deposit into the successor, because the slot is one balance at a
  time and the successor's SDK refuses a wallet another deployment holds.

So such a person is stuck until the note expires and, beyond that, until an
in-app archive action exists that works without the version's service. That
action does not exist. It would be the host's third write to the wallet slot,
needs its own recovery review (the give-up's review covers only a zero or dust
balance of a started SDK), and has to keep the note in the SDK's `archives`
store as the give-up does. Until it exists, retiring a version or letting its
operator go is a precondition the registry cannot check and the build does not
check: see [Retire a version](#retire-a-version) and [Roll back](#roll-back).

**Where it lives.**

| Piece | Where |
| --- | --- |
| the fact, its latch and the error memory; `isStartFailure` | `startFailed`, `startErrors` and `isStartFailure` in [versioning/index.js](../chat/zkapi/versioning/index.js) |
| `held`, the phase, the gate code, the renamed refusals | `deriveVersionState` in [versionState.mjs](../chat/zkapi/versioning/versionState.mjs) (`initFailed` is its input) |
| the stage | `deriveUpgradeStage` in [upgradeFlow.mjs](../chat/zkapi/versioning/upgradeFlow.mjs) |
| words | `held.label`, `held.unreachable`, `held.summary` in [copy.mjs](../chat/zkapi/versioning/copy.mjs) |
| notice and views | the `held` notice in [VersionNotices.js](../chat/zkapi/components/VersionNotices.js); `renderHeldBalanceView` in [UpgradeView.js](../chat/zkapi/components/UpgradeView.js); `BalanceExtras.js` draws nothing for it |
| panel, dialog, welcome | `heldUnreachable()` in [RightPanel.js](../chat/zkapi/components/RightPanel.js); `renderHeldBalance` in `AccountModal.js` and the closed view of `WelcomePanel.js`, both reaching the helpers only through `zkapiClient.oaVersioning` |
| chat bar and balance control | `heldWords` in [zkapiUxState.mjs](../chat/zkapi/services/zkapiUxState.mjs) |
| error words | `heldStartMessage` in [zkapiErrorCopy.mjs](../chat/zkapi/services/zkapiErrorCopy.mjs); `plainStartFailure` in [zkapiChatRuntimeCore.mjs](../chat/zkapi/services/zkapiChatRuntimeCore.mjs) |
| evidence | the recorded start failure of the legacy client, [client.json](../test/fixtures/zkapi-legacy-start-failed/client.json) (a manifest that answers 503, the error a refresh replaces it with, and the same client after a refresh a host answered with its own page) |

## 6. Deposit closing

A version that is not `active` must take no new deposit, yet a deposit that
already started must stay completable. The host enforces this itself because
the pinned legacy SDK `3342c95` **ignores `trusted_deployment.deposits`**:
no code path in it reads the flag and extra profile keys are not rejected. Nor
can the operator's gateway stop it: upstream's gateway cutoff (410 on the two
deposit-only tree routes) only stops `zkapi-clientd`; the browser deposit path
uses `/v1/tree/snapshot`, which withdrawals also need, and direct contract
deposits cannot be stopped at all.

### 6.1 The four layers

| Layer | Where | What it does |
| --- | --- | --- |
| 1. UI gate | `AccountModal`, `WalletMethodControls`, `WelcomePanel`, `AddressDepositFlow` | read `zkapiClient.oaVersioning?.depositGate()` before creating any draft, quote or flow; a closed flow stops polling and says why, and a render that finds the gate open again restarts it (`reopenIfAllowed`) |
| 2. SDK-singleton wrappers | [depositGuard.mjs](../chat/zkapi/versioning/depositGuard.mjs) `installDepositGuard` | instance-level non-enumerable wrappers (no Proxy) on the two SDK singletons refuse the adapter's `depositEntryPoints`, and every other `/deposit/i` method the adapter does not list as a recovery entry point, with `DepositsClosedError` before any RPC, IndexedDB write or wallet prompt |
| 3. Signer layer | `AddressFundingProvider.validateCall` | the Send Ethereum signer's deposit branch (and the fee quote) consults the gate when signing; saved journals are re-validated without it |
| 4. Profile flag | the emitted `browser-config.json` | `trusted_deployment.deposits: "closed"` for SDKs with `honorsDepositsFlag` (version 2 and the unpublished legacy re-cut); version 1 emits byte-identical config |

The guard is deny-by-default. It wraps `adapter.depositEntryPoints` (legacy
client: `deposit`, `performDeposit`, `prepareDepositQuote`, `quoteDepositUsd`;
runtime: `prepareDeposit`, `prepareDepositQuote`) and also every other function
whose name matches `/deposit/i` on the two singletons (own or inherited, never
a getter) that `adapter.recoveryEntryPoints` does not name, so a method an SDK
adds or renames cannot start a deposit on a closed version because nobody
classified it. `adapter.recoveryEntryPoints` (confirmation, retry, recovery,
reads, `claimPendingDepositSubmission` and the rest) are never wrapped. A name
listed as both is guarded. A guarded method the adapter does not classify is
refused on a closed version unless a started deposit exists (it has no
arguments the guard can compare), so a read-only method that is missing from
`recoveryEntryPoints` would be refused too: classify it. Two things report the
gap: boot logs `[zkapi] Deposit methods not classified by the adapter (guarded
by default): <names>` (names only), and the drift tests in
[zkapi-deposit-guard.test.mjs](../test/zkapi/zkapi-deposit-guard.test.mjs)
enumerate every `/deposit/i` method of the installed legacy SDK against
`note-bound-v1` and of the fixture SDK against `concession-v1`, and fail until
each is listed. The fixture stands in for the unpublished version 2 package and
this test discovers no registry alias and reads no `ZKAPI_V2_SDK_DIR`, so
installing the real package does not bring it under the test: the activation
change must point the second test at the installed `zkapi-sdk-v2c` client and
runtime ([Activate a new version](#activate-a-new-version), "The code change").
The names themselves are already classified: the same classification run
against the real `0.2.0` client and runtime reports nothing unlisted in either
list. What is missing until then is the pin that keeps it so, not the
classification.

### 6.2 The allow rule for a started deposit

The pending plan is read from memory (`runtime.runtime.pendingDeposit`), never
through `runtime.pendingDeposit()`, which initializes, takes the wallet lock and
may commit: a refusal must do none of that.

```
allow if gate.canStart
else  started = pending && !isUnsentPreparedDeposit(slot)
      allow iff started
            && (requestedAmount == null || Number(requestedAmount) === Number(pending.amount))
            && (preparedOperationId == null || preparedOperationId === pending.operationId)
```

Client entry points take decimal text in the funding unit (gwei for native ETH,
six decimals for a token deployment). A USD price quote carries no comparable
amount and passes only while a started deposit exists. An unsent prepared plan
is never "resumable". A gate that throws or is malformed refuses: only an
explicit `canStart === true` (or a matching started deposit) passes.

Refusal is `DepositsClosedError`: `code: 'deposits_closed'`, `status: 409`,
`data: {versionId, successorId, closedSince, gateCode}`, message from the copy
table. A native SDK refusal with the same code is recognized as well.

The Send Ethereum flow turns it into state rather than a retry loop:
`flow.closed` is `{code: 'deposits_closed', gateCode, versionId, successorId,
closedSince}`, a closed flow is not running, has no timer, is not ready and has
no fee, and `verifyReady` on it throws the same error shape (so
`explainZkapiError` words it like every other closed deposit).
`flow.reopenIfAllowed()` resolves to whether the flow restarted: it does nothing
unless the injected gate now explicitly allows (`canStart` or `canResume` is
`true`) and then starts again with the amount last asked for.

Residual time-of-check gap: another tab cancels between the wrapper and
`prepareDeposit`. The signer-layer gate and the SDK's own refusals are the other
layers; layer 4 closes it natively for SDKs that honor the flag.

### 6.3 Gate codes

`DepositGate = {canStart, canResume, code, successor}`; `canResume` is
`hasPendingDeposit && !hasUnsentPrepared`. When `canStart` is false the code is
the first that applies:

| Code | Source | Reload button |
| --- | --- | --- |
| `version_unavailable` | facade: a versioning-active build with no installed version, or an error while deciding | yes |
| `foreign_runtime` | selection rows 4 and 5, or a fresh preview that finds an owner this build cannot open (a boot block is never reopened by a preview) | yes, except for a retired owner |
| `holdings_unreadable` | selection row 2, or a balance the page holds and cannot read on the version that takes deposits ([5.10](#510-a-balance-the-page-holds-and-cannot-read)): its SDK did not start while the wallet slot holds its note, so the deposit it would start cannot start either. Restrict-only (below) | yes |
| `config_mismatch` | served-config hash mismatch, or identity mismatch after init | yes |
| `stale_build` | the build-status latch | yes |
| `deposits_closed` | status is not `active`, or the SDK reports `config.deposits === "closed"`, or the target is another version | only when a fresh load would pick the target (the reload notice) |
| `previous_withdrawal_open` | another live version has open withdrawals not covered by an unexpired matching operator notice, or `config.other_deployment_withdrawals` is non-empty. Open records of retired deployments are ignored (no bundle can finish them). A deployment with no table row blocks but cannot be named | "Open version P" when `previous.canOpen` |
| `reload_required` | the tab is told to reload because a fresh read found the wallet held by another live version (the balance moved in another tab), and nothing above already closed the gate. Restrict-only: it never reopens a gate another code closed, a started deposit stays completable, and only the reload clears it | yes (the reload notice is its text) |

A tab that has been told to reload therefore does not offer a deposit under the
notice: the amount form and the funding buttons are closed until it reloads,
rather than left usable for the SDK's foreign-wallet refusal to stop.

The order of evaluation is: the boot selection's block (`foreign_runtime`,
`holdings_unreadable`), `config_mismatch`, `stale_build`, `deposits_closed`,
`previous_withdrawal_open`, a balance the page cannot read
(`holdings_unreadable`) and `reload_required`. The last two only restrict:
neither replaces a code that is already set, so an exit-only version with a
balance it cannot read keeps `deposits_closed` (and its successor), and the
deposit target keeps `config_mismatch`, `stale_build` or
`previous_withdrawal_open` when one of them applies. A reload clears the
unreadable one when the service answers on the next load. `canResume` is false
meanwhile: the snapshot of an SDK that did not start reports no deposit.

Unclaimed credits never block deposits; they raise `claim-previous-credit`.

**Operator notices.** An entry in `notices` relaxes the gate only for a record
that matches note id, mode `escape` and phase `pending`, while unexpired and
only on an `exit-only` row. This mirrors upstream's exception for an escape the
operator announced as stuck on a destination that rejects ETH. The notice's
`destination` is validated in the registry but is not compared in the match
(upstream matches by note id).

## 7. Upgrade UX

### 7.1 Surfaces

| Surface | Change |
| --- | --- |
| System Panel header | muted pill `Version N` after the existing help button (so the `Private balance:` then billing-help ordering holds), with its own `?` ("About versions", ids `zkapi-panel-version-help-toggle` and `zkapi-modal-version-help-toggle`) |
| Balance dialog card | pill beside the readiness pill; never between the expiry text and its `?` |
| Panel and dialog banner | one `[data-zkapi-version-banner]` block per surface (value `panel` or `dialog`); static text, no live region, no focus theft; the clock patches text only |
| Ticket (OA) mode | keyed `#zkapi-upgrade-notice` slot after the closing notice (value `ticket` on the banner hook); only the upgrade (soon or overdue), previous and credit notices reach it, never the neutral note or operator text; no toast |
| Standalone toolbar chip | title and `aria-label` gain ` · Version N` only when the pill shows |
| Dialog view `upgrade` | entered by `zkapi-payment-required {view: 'upgrade'}`; part of `RESTORABLE_VIEWS` |
| Balance card | under the balance and the version banner: the exit kit's status row and the give-up link (`ui.balanceExtras`, [7.8](#78-the-exit-kit), [7.9](#79-giving-up-a-zero-or-dust-balance)) |
| Withdraw view | the fine print about a settling chat and, while one holds the balance, the choice of how to withdraw (`ui.exitChoice`, [7.7](#77-a-settling-chat-and-the-emergency-exit)) |
| Payment history rows | per record: a "Payout held" card with the claim button, a payout-alert note, a device explanation (`ui.recordExtras`); then the other versions' rows, text only ([5.4](#54-the-shared-wallet-database)) |
| System Panel, balance held | "Saved in this browser" where the amount would be, a quiet "unavailable" pill, "Balance details" for the button, and the `held` notice with Reload; no used or expiry line, no Add funds, no Withdraw ([5.10](#510-a-balance-the-page-holds-and-cannot-read)) |
| Balance dialog, balance held | one view, `ui.heldBalance`, in place of the balance card, the closed-deposits view, the Withdraw view and the upgrade view; no wallet-method or funding controls above it; Payment history stays |

The pill is amber only inside the prompt window. With one live version the DOM
is unchanged. Banners are built from `gate` and `phase`, so a lone `exit-only`
version, which has no pill, still explains its closed gate.

An operator `stuck_escape` notice that took effect for a record this browser
holds is shown as a plain info notice with no action on the panel and the dialog
(text bounded to 280 characters, escaped, never a link), and never on the ticket
surface.

DOM hooks (stable for tests and CSS):

- `[data-zkapi-version-badge]` (with `data-zkapi-version-tone`),
  `[data-zkapi-version-badge-group]`;
- `[data-zkapi-version-banner]` with a `data-zkapi-version-sig` that is opaque
  (id, tone, paragraph count and action state per notice; text is not part of it,
  so a text change is patched and a structural change re-renders), notices
  `[data-zkapi-version-notice]`, text `[data-zkapi-version-text]`, clock targets
  `[data-zkapi-version-closeby]` and `[data-zkapi-version-tier]`;
- notice ids (`[data-zkapi-version-notice]`): the existing ones plus `near`,
  `wait`, `frozen`, `device`, `payout`, `claim`, `setaside`, `kit` and
  `abandon` ([7.6](#76-exit-state-notices)) and `held` (the phase notice of a
  balance the page cannot read, one Reload action, never on the ticket
  surface); the `service` notice gains a "Check again" action;
- actions `[data-zkapi-version-action]` with value `upgrade`, `reload`,
  `open-previous`, `claim-credit`, `cancel-unsent`, `dismiss`, `check-service`,
  `open-withdraw` and `open-payments` (both dispatch the existing
  `zkapi-payment-required` event with view `withdraw` or `withdrawals`),
  `export-exit-kit` and `abandon-open`. The balance card's and the exit choice's
  buttons carry the same hook, so the dialog's one delegation reaches
  `ui.act` once per click;
- `[data-zkapi-balance-extras]`, `[data-zkapi-kit-row][data-kit-state]`,
  `[data-zkapi-abandon-row]`; `[data-zkapi-exit-choice]` (with
  `data-zkapi-exit-mode`), `[data-zkapi-exit-bound][data-bound]` and radios
  `input[name="zkapi-withdraw-concede"]` (`wait`, `zero`, `bound`);
  `[data-claim-payout="<recordId>"]`, `[data-zkapi-record-alert]`,
  `[data-zkapi-record-device]`; `[data-other-version-record]`,
  `[data-zkapi-history-open]`; the dialogs `[data-zkapi-exit-kit-dialog]` and
  `[data-zkapi-abandon-dialog]`;
- `[data-zkapi-upgrade-view]`, `[data-upgrade-step]` (`withdraw`, `reload`,
  `deposit`) and `input[name="zkapi-upgrade-destination"]` (`connected`,
  `new-address`, `other`); the upgrade's withdraw button is the existing
  `#zkapi-withdraw-btn`;
- `[data-zkapi-balance-held]` with its text `[data-zkapi-held-text]`: the view
  of a balance the page cannot read, in the dialog and the welcome;
- help: `privateBalanceHelpContent(scope, 'version', open, detail)` takes a
  `{title, body}` detail of trusted, already escaped HTML.

The version and exit-state styles are sections appended to
`chat/zkapi/zkapi.css`. Do not add a later `@media (prefers-reduced-motion)`
block after them: an existing test reads the last one, so a rule that needs it
goes inside the existing block.

### 7.2 Banner tiers, prompt window and reminders

Policy numbers are registry data (`transition`); their sources:

| Number | Value | Source |
| --- | --- | --- |
| close-by margin | 72 h before expiry | upstream "Rules for the window" (a request in flight needs settlement, a transaction can revert on a moving root, an owner may be away) |
| reminders | 7, 3 and 1 days before close-by | upstream "Schedule" |
| prompt window | 14 days before close-by | this app's decision; upstream asks to spread the move and never announce "everyone migrate today" |
| legacy chat cutoff | 23,700 s | this app's decision, derived from upstream's lease settlement bounds ([5.9](#59-the-runtime-facade)) |

Deadlines: `closeByTs = deadline expiry - closeByMarginSeconds`, for the slot
note and for every set-aside record in the adapter's `sweepablePhases`
(`parked`, `restored`; a started escape cannot be swept). The earliest drives the
tier. `reminderTier` is the smallest configured day count at least the time left
(inclusive bounds), `0` once close-by has passed before expiry, null otherwise;
`expired` and `claimed` keep their existing states.

| Phase | When | Words and controls |
| --- | --- | --- |
| `upgrade-available` | an upgrade applies and close-by is more than `promptWindowDays` away | neutral info banner, "Upgrade now" as a secondary link; says keeping the balance until close-by is fine. Day 0 never shows a prominent call to action (no herding) |
| `upgrade-soon` | inside the window, or any tier is set | amber pill, "Upgrade balance" primary; tier text at 7, 3 and 1 days |
| `upgrade-overdue` | close-by passed, before expiry | "Upgrade now. Withdrawals can take a while to confirm. After {expiry}, the service treasury can claim your full original deposit, and nothing is refunded." |

Rules: an empty balance gets no prompt (and an empty or dust balance that can
be given up is offered that instead, [7.9](#79-giving-up-a-zero-or-dust-balance));
the nudge never blocks chat (the `near_expiry` cutoff is a separate rule); times
show local date **and** time (legacy expiry rounds up to UTC midnight). A
set-aside-only holder gets `finish-previous-withdrawal` carrying the earliest
set-aside deadline, with Withdraw or Restore as the action; outside every tier
that notice is neutral, not amber. A set-aside record this device may not exit
is excluded: it drives no tier, reminder or upgrade nudge.

**Reminder toast.** One toast per tier in zkAPI mode only (ticket mode suppresses
zkAPI toasts; the banner is there either way). "Already shown" is the lowest tier
of the facade's value (storage `oa-zkapi-upgrade-reminder-v1`) and an in-memory
memo, so storage that refuses writes yields one toast per tier, not one per state
change. Dismissals of banners are page-lifetime and in memory only.

**Clock and patching.** The System Panel patches version text at most every 5 s,
text only, and asks for one structural re-render per 30 s when a tier boundary
or expiry is crossed; the facade arms one boundary timer for the next close-by,
tier, window or expiry boundary. A missed timer can lag a banner by about 5 s.

### 7.3 Guided upgrade stages

The stage is derived from facts on every call
([upgradeFlow.mjs](../chat/zkapi/versioning/upgradeFlow.mjs)); there is no event
log. One persisted intent records "this browser started an upgrade from X to Y";
without it the stage falls back to `idle` and the ordinary banner and Withdraw
controls still work.

| Stage | Where | Facts | UI |
| --- | --- | --- | --- |
| `idle` | any | nothing in progress, nothing to move, or a bare `withdrawing` intent on the target | banner call to action |
| `review` | version F, view `upgrade` | the person opened it | two public transactions and their fees, destination choice, the existing `#zkapi-withdraw-btn` |
| `withdrawing` | F | an open phase before submission, or a prepared withdrawal | the existing withdrawal journey inside the view |
| `confirming` | F | `closed_unconfirmed`, `submitted_unconfirmed`, `challenged_unconfirmed`, `recovery_unconfirmed` or `finalizing` | status line; the SDK reconciles every 15 s |
| `ready_to_switch` | F | holdings empty and a fresh load picks the target | Reload (enabled only when `canReload`) |
| `deposit` | target | intent `withdrawn` or `depositing`, no note, deposits allowed or resumable | "Your balance is withdrawn. Deposit to finish upgrading to version N." with Continue and Dismiss |
| `done` | target | a note is in the target (any intent toward it qualifies) | status line; the stored intent is cleared at once |
| `blocked` | any | expired, unsent plan, started deposit, set-aside close, deposits blocked with nothing started | explanation; never a Reload that would re-select the same build |

A balance the page cannot read narrates no stage: with `held` set the stage is
`idle` whatever the intent, the open view or the withdrawal phase say, because
none of those facts can be known while the SDK has not started (a stored
`withdrawn` intent does not turn the deposit target's empty snapshot into
"Deposit to finish upgrading"). The state's `upgrade.blockedBy` is
`service_unreachable` and the one notice carries the one action
([5.10](#510-a-balance-the-page-holds-and-cannot-read)).

Intent `oa-zkapi-upgrade-v1`: `{v: 1, network, from, to, stage, since}` with
stage `withdrawing`, `withdrawn` or `depositing`. Rules:

- It is first written when the person opens the upgrade view (`beginUpgrade`),
  and only on an `exit-only` version with a target and an upgrade available.
- It advances to `withdrawn` only when this tab **observes** the SDK close a
  withdrawal record that was open, with `payoutVerified === true`, for the
  upgrade's own note (the slot note id captured in memory at `beginUpgrade`,
  never persisted; with no captured id, only a wallet that now holds nothing
  qualifies). Empty holdings alone never advance it: an expired and archived
  balance also leaves the wallet empty. A closure without evidence stays
  unproven and is looked at again if the SDK later adds it; a closure first seen
  on a page never counts.
- It advances to `depositing` when a pending deposit exists on the target.
- It expires after 45 days, is cleared at `done` or by Dismiss on the deposit
  step (`abandonUpgrade`, which also stops the page reading a stored copy), and
  is read inside try/catch; the UI renders correctly without it.
- Nothing is ever prefilled in a deposit amount (never deposit the exact
  leftover balance).

The dialog keeps the upgrade steps for up to 15 s (`UPGRADE_SETTLE_MS`) after a
background withdrawal completes, until the preview delivers `ready_to_switch`;
a page that must reload while no step is ready leaves the steps for the balance,
which carries the reload banner and button. Banner suppression in the dialog is
id-based: a banner is withheld only for notice ids the dialog's own view says,
and a banner it cannot read, or one carrying host markup, is shown (a repeated
line costs less than a lost reminder).

### 7.4 Copy and evidence rules

Words live in one table, [copy.mjs](../chat/zkapi/versioning/copy.mjs), with
token substitution and plain-words fallbacks (a missing number never leaves
"version" dangling).

| Token | Meaning |
| --- | --- |
| `N` | the deposit target's number |
| `F` | the version this page is on |
| `P` | the other version with unfinished business (`previous.*`, `deposits.blocked.previous` read only this) |
| `R` | the version a reload would load (`reload.otherTab`) |
| `V` | the version a reference number or a retired label belongs to (`operator.reference`) |
| `closeBy`, `expiry` | local date and time |
| `message`, `amount` | operator text; a dollar figure. For the service pause `message` is the host's own words chosen by the service code (`serviceCopyKey`); the SDK's message is never a token |
| `until`, `escapeAt`, `exitBy`, `setAsideBy` | local date and time of the exit facts: the end of a freeze, the time a settling chat must settle by, the latest start of an exit, the earliest set-aside deadline. With `options.now`, an instant that has already passed is left out, so the template reads as a whole sentence without it |
| `bound` | the most a settling chat can take, through `formatAmount`; the larger of the refused attempt's bound and the standing one, so a disclosure never understates it |
| `retryIn` | whole seconds until a refused withdrawal may be retried (with `options.now`) |
| `limit`, `eth`, `destination`, `count`, `reference`, `retired` | supplied by the component that renders: amounts and the ETH unit word (so no unit word sits in template text), a short address, a number, the note reference, a flag |
| flags `reload`, `waiting`, `blocked`, `sepolia`, `retryOne`, `countOne`, `hasReference` | wording switches (the last three are derived: "1 second", a count of one, a reference number that may be 0) |

Build tokens with `copyTokens(state, {formatter, table, formatAmount, now})`;
do not assemble them by hand. The pill text is empty without a version.

A new template passes the same sweeps as every other: no `nullifier`, `vault`,
`circuit`, `deployment`, `manifest`, `note(s)`, `proof`, `escape hatch` or
`mutual close` vocabulary, no exclamation mark, no straight apostrophe, no word
of three or more capital letters (a unit word such as ETH arrives through a
token the component builds), no hanging preposition when a token is missing and
no "nothing is lost". Use "emergency exit", "payment contract" and "withdrawal
request". A component outside `copy.mjs` keeps its own frozen words table and a
vocabulary sweep of it.

Style rules: product language ("Private balance", "version N"); never
nullifier, vault, circuit, deployment or note numbers; sentence case; no emoji;
errors use `--color-destructive-text`; anything mentioning MetaMask passes
through `walletMethodText`; an upgrade is never described as unlinkable;
operator strings (`service.message`, notice text) are bounded to 280 characters,
stripped of control characters, escaped and never rendered as links or
instructions; Sepolia users re-enter the test-network password after a
build-switch reload and the upgrade view says so.

Evidence rules, so that no sentence claims more than the facts prove:

- "Withdrawal confirmed. Your balance is back in your wallet" (`upgrade.withdrawn`)
  is said only when the facade's `withdrawalConfirmed` is `true`, which needs the
  payout-verified closure above. A false or missing fact says only that deposits
  moved (`deposits.closed`). The Reload click records a withdrawal
  (`upgrade_withdrawn`) only on that evidence; otherwise it sends
  `previous_withdrawal_finished` with no view and writes no intent.
- `upgrade_withdrawn` as a reload reason needs an intent of stage `withdrawn` or
  `depositing`; `moved_in_other_tab` needs a fresh read whose reason is
  `runtime_holds_note` ("saved in this browser" is never asserted for a wallet
  that reads empty); the neutral reason `previous_withdrawal_finished` is the
  default; `draft_cleared` needs a boot slot kind of `draft_only` or
  `unsent_prepared` and an empty preview.
- A page on the deposit target is never told "Deposits moved to version N. This
  page is on version N" (keys `deposits.closed`, `send.closed`, `send.largerKey`,
  `admission.closed`, `abandon.zero`, `abandon.dust` and `held.unreachable` drop
  `N` when it equals `F`; for the last one that is the sentence about using
  version N).
- `ui.facts()` carries `withdrawalConfirmed` and `previewReason`; every renderer
  claims nothing when a fact is missing.
- A balance the page cannot read is said as saved and not available, never as
  empty, moved, safe or lost, and its words name no cause: whatever stopped the
  start (no answer, an answer the page does not trust, a service on another
  protocol) is "not available" to the page, and the SDK's own text for it names
  the operator. The three keys:

  | Key | Where | Says |
  | --- | --- | --- |
  | `held.label` | the panel where the amount would be; the dialog's section title | "Saved in this browser" |
  | `held.unreachable` | the `held` notice, the dialog's and welcome's view | "Your balance is still saved in this browser. Version 1's service isn't available right now, so the balance can't be shown yet. Reload to check again." and, only with a newer version to use, "To use version 2, first withdraw this balance from version 1." (`F` and `N` are the version that holds the balance and the deposit target; without `F`, "This version's service") |
  | `held.summary` | one sentence for the narrow surfaces: the chat bar, the welcome's payment-service line, a toast, a transition message | "Your balance is saved in this browser, but its service isn't available right now. Reload to check again." |

  Reload is the only thing offered, and the words say Reload and never "when the
  service is back": the legacy SDK attempts its start once per page load, so
  nothing on the page retries by itself and waiting would not bring the balance
  back. The words also never say "deposit", "moved", "safe" or "nothing is
  lost", name no address and carry no status code or SDK text. The balance
  dialog has one more line of its own (`HELD_BALANCE_LINE` in `AccountModal.js`,
  a string constant because that file may not import) that stands in for
  `held.unreachable` until the version helpers have loaded.

### 7.5 Funding methods

| | MetaMask | Send Ethereum (browser-held address) |
| --- | --- | --- |
| Withdraw destination | the connected account (SDK default; a saved plan's destination wins) | a typed destination is required. Denied: the zero address, the current vault and demo token, every registry vault (live and tombstoned) and, while versions differ, this browser's own funding address (the list is computed by the signer's destination rule, `fundingDestination` in `addressFunding.js`, from the version table; the facade holds no copy of it). A saved destination is exempt so a started withdrawal stays completable |
| New funding address | n/a | "A new funding address for version N in this browser", only on an explicit click through `createScopedFundingProvider(target).ensureAddress()`, with a browser-only-custody warning |
| Gas | the wallet | warns only when the funding address balance is known to be zero; no fee estimate is invented |
| Deposit on the target | `DepositAmount` as today | the existing flow; "Funds received" works if funds were sent to the target's address |
| Amount prefill | none | none |

**Each vault has its own funding scope.** A Send Ethereum address is keyed by
`chainId:vault:native-eth`, so the target version gets a new browser address by
construction; the previous version's encrypted row stays in the browser.
[scopedFundingProviders.mjs](../chat/zkapi/services/scopedFundingProviders.mjs)
is the way back to those scopes for leftover ETH:

- Discovery is local facts only (`listRetiredScopes`: address, last return,
  pending sweep) and runs when the dialog opens. No balance is read and no
  network request is made until the user asks.
- The section is the "Leftover ETH from a previous version" disclosure of the
  funding controls, one row per earlier version, and every button in it is one
  explicit gesture. **Check balance** reads that address once; the copy says,
  before the button, that checking links the older address to the current one
  at the network provider. **Move to this address** (offered only after a
  balance above zero was read) asks for a confirmation, then reuses the public
  ETH return and its sweep journal (`sweepRetiredScope`). **Check saved
  transaction** (offered while a return from that address is saved and
  waiting) settles it with `recoverRetiredScope`. A tombstone has no RPC, so a
  live version on the same chain supplies it.
- The four vm-evaluated sources cannot import this module, so the dialog reaches
  it through `zkapiClient.oaVersioning.ui.rescue`: `createScopedFundingProvider`,
  `listRetiredScopes`, `checkRetiredScopeBalance`, `sweepRetiredScope` and
  `recoverRetiredScope`, each loading the module on first use. A page whose `ui`
  has no `rescue` simply shows neither the section nor the "new address" choice.
- A provider of another scope is **sweep-only**: it accepts only `sweep` and
  `recovery` authorizations, never deposits, exits or claims, never resumes
  through the loaded SDK, and uses its own version's call profile and
  deployment id.
- A non-sweep transaction another build left saved blocks the scope's return.
  It is never rebroadcast, but the marker is released once the network has
  settled it for good: receipt in a finalized block (confirmed or reverted), or
  no receipt and the sender's finalized transaction count past its nonce
  (replaced). Outcomes: `released` (with `finalState`), `pending` (not final, or a
  reorg) or `address_scope_retired` ("Finish it there"). An invalid receipt or
  an RPC failure fails closed and keeps the marker.
- Known gap: a transaction the network never saw and no nonce displaced stays
  blocked, and a password-locked (version 1 envelope) retired row can be listed
  and checked but not swept (`address_locked`).

Calldata the Send Ethereum signer may sign is data per adapter (a call profile
of selectors, word counts and rules):

| | `note-bound-v1` | `concession-v1` |
| --- | --- | --- |
| deposit | `c588341c`, 34 words | `56d2e1ea`, 2 words (the vault appends the leaf) |
| mutual close | `7fca9c82`, 56 words | `72cd2e44`, 26 words, words 13 and 14 zero |
| initiate escape | `9073639b`, 56 words | `a38d62aa`, 26 words, word 13 non-zero and different from the nullifier, word 14 within what the person confirmed ([the rules below](#concession-and-operation-rules-of-the-signer)) |
| finalize escape | `ff8f5585`, 1 word | same |
| claim payout | none | `88c10aee`, 1 destination word; authorization kind `payout-claim`, recovery kind `escape-payout-claim` |

`validateCall` signs by default (`signing = true`); only journal re-validation
passes `{signing: false}`, so the deployment pin and the deposit gate apply to
new signatures only. An installed gate must say `canStart === true` or
`canResume === true`; only `null` or `undefined` means "no gate". The recovery
context `deploymentId` must equal the installed version's when signing.

#### Concession and operation rules of the signer

An authorization of kind `withdrawal` may carry three more strings, all set by
the dialog from what it showed (`runAddressAction` copies them from its
`details` and never fills one from the SDK's saved plan):

- `conceded`: the exact amount (gwei) the person confirmed, for a forced
  emergency exit or a plan that already exists;
- `concededMax`: a cap, the most a settling chat could still cost as it was
  disclosed before the click ([7.7](#77-a-settling-chat-and-the-emergency-exit));
- `operationId`: the prepared withdrawal the person looked at; it must equal
  the recovery context's operation, on every profile, and is set only where the
  recheck is on ([11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)).

The rules, which apply only where the call profile's escape exit has a
concession word (`concession-v1`; the `note-bound-v1` profile and behavior are
untouched):

- With neither amount an escape concedes nothing (word 14 must be 0); with both,
  both must hold; a malformed value refuses instead of passing.
- A requested mutual close that the SDK turns into an escape (when the service
  cannot or will not clear it) is signed within the cap. The reverse, an escape
  requested and a mutual close signed, is refused on every profile.
- A repeat that names no concession (an attempt that stopped before anything
  was signed and is tried again) is held to the amount the signer itself
  already accepted for the same operation and note, as a cap, from its own
  journal and from this page session's memory (the smaller of the two, so
  the hold ratchets down to the most recent amount and going back up needs the
  bound named again). A refused attempt leaves neither, so repeating it bare is
  refused again until the person confirms a bound. The SDK's saved plan is never consulted: it
  records what the SDK proved, not what anyone confirmed. Nothing is persisted
  for this, so after a reload an unsigned conceding escape needs its bound
  named again ([11.5](#115-known-limits-and-support-runbooks)).
- The refusal is code 4100 with its own words (nothing was sent; start the
  withdrawal again from the beginning to see what it gives up). The SDK takes a
  4100 for a send that never reached the network and clears an escape plan that
  reserved no clearance before those words are restored, so they name no
  button.
- The journal keeps what was signed: the mode actually signed (the request is
  kept as `requestedMode`) and the exact amount, so a build that only knows
  "the mode authorized is the mode signed and the concession is the amount
  authorized" reads every entry unchanged. Rolling back to such a build with a
  journal entry written under the conversion rule would otherwise read it as
  damaged.
- The Sepolia-only test-token mint branch of the provider is gone: no network
  is treated differently from another, and a registered deployment pays in
  native ETH.
- A sponsored withdrawal (its network fee paid from the withdrawal through an
  ERC-4337 operation) is judged by its own rules, not by these: the signer signs
  a hash of the operation and judges the operation where it would leave the
  browser, against the same authorization (destination, mode and concession) plus
  the fee bounds the person was shown
  ([11.7](#117-sponsored-withdrawals-the-network-fee-paid-from-the-withdrawal)).

### 7.6 Exit-state notices

A revision 3 protocol makes the host say several facts about a balance. Each is
an additive notice built from the `VersionState` alone (never a phase; the
facade holds the refusals and the clock). They appear on the System Panel and
the balance dialog unless noted; the ticket surface carries only what puts funds
at risk (`upgrade`, `previous`, `credit`) and none of these.

| Notice id | Says | From | Action |
| --- | --- | --- | --- |
| `service` | "The private service can't be reached right now, so new chats and deposits are paused. You can still withdraw your balance." The cause is worded by the service code: unreachable, changed, untrusted link, an incompatible protocol, or (`native_vault_unverified`) the payment contract not confirmed with the network provider; an unknown code gets the generic text and no operator words | `config.service` (`available`, `code`) and the refusals of an attempt | "Check again" (`recheckService()`; Reload when the page cannot ask; a toast when still paused) |
| `near` | New chats are paused because the balance is close to its end and must be withdrawn by a time. Never mentions upgrading | `exit.nearExpiry`, `exit.mustInitiateByMs`, the `note_near_expiry` refusal | Withdraw (`open-withdraw`) |
| `wait` | A refused withdrawal says when it can be tried again, or why it cannot go now: a chat still settling (with the time it must settle by), an earlier withdrawal request about to expire (a count of seconds), an earlier attempt that has expired but is not yet confirmed as unable to go through (try again shortly). Dialog only | `request_settlement_pending`, `ownership_proof_wait`, `exit_release_pending` | none |
| `frozen` | The balance is frozen while an earlier withdrawal can still go through (new chats resume after a time) or, with no end named, while a withdrawal of it has started and not finished (new chats resume when it finishes or can no longer go through); you can still withdraw | `exit.lock`, the `exit_locked` refusal | Withdraw |
| `device` | This balance was used on another device or copy after this browser last saved it, so this browser can't safely withdraw it: withdraw it from the device that used it last, or use the newest exit kit with the companion tool. Promises no in-app restore | `exit.deviceNotNewest`, a flagged set-aside record, the `device_not_newest` refusal | none for the slot note (a Payment history link only when a set-aside record is flagged) |
| `payout` | A withdrawal paid out less than the balance minus the last chat's budget. It can't be changed; report it to the service operator. Dismissible for the alerts seen | `payoutAlert === 'concession_exceeded_bound'` | Dismiss |
| `claim` | A payout the payment contract could only credit is held for you; claim it from Payment history | an unclaimed credited escape | Open Payment history (`open-payments`) |
| `setaside` | A set-aside balance is close to its deadline. On the panel and the dialog it stands in for this version's own "finish the previous withdrawal" notice, which would tell the same deadline a second time in the words of an upgrade | `exit_deadline_near` records that are not device-flagged | Open Payment history |
| `kit` | No exit kit was made, or one was made and not saved ([7.8](#78-the-exit-kit)) | `exit.kit`, the facade's unsaved flag | Create exit kit (`export-exit-kit`) |
| `abandon` | An empty or very small balance on a version that no longer takes deposits can be given up ([7.9](#79-giving-up-a-zero-or-dust-balance)); replaces `upgrade` on the surfaces that carry it | `state.abandon` | Give up this balance (`abandon-open`), Withdraw instead |

Interactions: a balance another device used shows `device` alone, with no
`near`, `wait` or `frozen` beside it and no Withdraw button, because those
would send the person to a withdrawal that is rejected. `abandon` hides `near`
and `kit`. A note that holds nothing but an unfinished exit shows `frozen` in the
dialog's balance card and the panel (a quiet `frozen` pill, no "ready to
finish" line); a frozen balance used on another device says the device words in
the panel, the composer and the toolbar chip as well, not "you can still
withdraw". `service-paused` stays a phase, and the deposit gate is **not**
closed for it: the SDK clears its own manifest problem only inside
`assertServiceAvailable()` on an attempt, so a host pre-block could strand the
person. Exits stay enabled, and the host replaces the SDK's jargon with its own
words.

A balance the page cannot read ([5.10](#510-a-balance-the-page-holds-and-cannot-read))
shows the `held` notice alone. None of the notices above is built for it, since
each reads a snapshot that has nothing in it and each of their actions needs the
SDK that did not start, and the gate's own explanation is not said beside it
(the `held` notice covers every gate code, a safety block included, with the same
Reload). The ticket surface carries none of it.

Clock-driven words (an instant that passes, a count of seconds) sit in
notices that carry `data-zkapi-version-clock`, so the dialog's patcher knows
there is text to move without a close-by deadline on the page. An instant that
has already passed is left out of a sentence, so the sentence still reads whole.

#### The units trap

The SDK mixes seconds and milliseconds, and the one place that knows is the
normalizer (adapters/concessionV1.mjs) and
[exitRefusal.mjs](../chat/zkapi/versioning/exitRefusal.mjs):

| Unit | Fields |
| --- | --- |
| milliseconds | `config.exit.{must_initiate_by, escape_at, lock.since, lock.releasable_after}`, `withdrawals[].{expiry, must_initiate_by}`, `config.unresolved_requests[].{created_at, escape_at}`, `request_settlement_pending.data.{escape_at, must_initiate_by}` |
| seconds | `exit_release_pending.data.{releasable_after, must_initiate_by}`, `exit_locked.data.releasable_after`, `ownership_proof_wait.data.retry_after` (a delay, not an instant), `note.expiry_ts`, `valid_until` |

Amounts are decimal strings of gwei (the SDK writes `credited_amount` as a JS
number). Every instant that leaves the normalizer is an epoch-millisecond safe
integer between `1e11` and `1e14`, and every instant that leaves
`readExitRefusal` is inside `[now, now + 90 days]` (a value up to a minute
behind the clock reads as "just ended"), otherwise null: a unit slip is "not
known" and never a 1970 date or a timer armed for the year 58000. A refusal's
SDK message is never read (it can name an operator URL), and
`config.exit.exit_rpc_url` is read as nothing at all.

### 7.7 A settling chat and the emergency exit

A chat is not recorded on Ethereum while it settles. An emergency exit proves
the balance as of the last state the browser holds, so it can give up part of
the balance that the settling chat may or may not have used. The SDK enforces
the rules; the host discloses them and records what the person chose
([ExitChoice.js](../chat/zkapi/components/ExitChoice.js), read at submit by
`AccountModal.submitWithdrawal`).

- **Fine print.** Whenever `exit.boundAtState` is above zero, the Withdraw view
  says the most a settling chat could cost, with its ether amount beside any
  dollar figure, and carries that number in `data-bound`. It is the cap the
  Send Ethereum signer later accepts ([the rules](#concession-and-operation-rules-of-the-signer)).
- **The choice** is drawn while the balance is known to wait on a settling chat
  (`stateFresh === false`, or a settlement refusal is held), and depends on the
  kind of withdrawal selected, because an emergency exit never waits for a
  chat to settle and the SDK's default is to concede nothing:
  - normal withdrawal: **wait** (the default; giving something up is never
    preselected), leave now giving up nothing now, or leave now giving up the
    bound;
  - emergency exit: leave now giving up nothing now (the default) or giving up
    the bound.
  The bound option carries the sentence the protocol requires: the chat is not
  recorded on Ethereum, so more than it actually cost may be given up.
- **What is asked of the SDK.** Wait, or no choice drawn: no forced escape, and
  the Send Ethereum call carries `concededMax = bound` (no cap when no bound was
  shown, so the exit concedes nothing). Give up nothing now: `mode: 'escape'`,
  SDK option `concede: 'zero'`, `conceded = '0'`. Give up the bound: escape,
  `concede: 'bound'`, `conceded = bound`.
- **After the settlement time** (`exit.escapeAtMs`, or a held settlement
  wait's own) nothing is left to choose: the SDK's policy at or after that time
  makes every request, mutual or escape, an escape that concedes the whole
  bound. The dialog then draws the fine print and one sentence saying so. A
  page drawn before that time whose wait or "give up nothing now" was picked is
  stale at the click (nothing starts and the page is redrawn); a "bound" pick
  stands, since giving up the figure is what happens. The time is carried in the
  markup (`data-zkapi-settles-at`) because a held wait leaves the state when it
  runs out. One last look is taken right before the SDK is called, after
  settlement, the wallet connection and the recheck. What remains is the SDK's
  own network latency at exactly that time, bounded by the disclosed figure
  (the signer's exact-amount check fails the `zero` case closed).
- **A pick is `{choice, bound, noteId}`**, read from the drawn markup and never
  from the state, spent by the attempt that read it, and forgotten on leaving
  Withdraw or on another balance. A page drawn for the other kind of
  withdrawal, or before the figure moved (any change for the bound pick,
  growth for the others), is stale: nothing starts, and it is redrawn with a
  line saying why. A generic 4100 denial is deliberately not remapped to "the
  figure changed": the signer uses one code for many unrelated causes.
- A continued or set-aside withdrawal names no bound
  ([11.5](#115-known-limits-and-support-runbooks)).

### 7.8 The exit kit

An exit kit is an encrypted file that, with the zkAPI companion tool, lets a
person withdraw even if the service is unavailable. It can also move the
whole balance to any address, so this app treats it as a secret.

- **Source.** `client.exportExitKit(passphrase)`, behind a `typeof` guard (the
  legacy SDK has none; a static import of the SDK's `exit-kit` subpath would
  fail the name-parity gate). The facade hands the text back and keeps neither
  it nor the passphrase.
- **Passphrase.** Generated, never chosen: 20 symbols from a 32-symbol alphabet
  without `I`, `O`, `0` and `1`, shown as `XXXXX-XXXXX-XXXXX-XXXXX` (100 bits),
  retyped before anything is created. The SDK's 10-character minimum is a floor,
  not a design. There is no option for a person-chosen passphrase. The page
  never writes the passphrase to the clipboard and has no Copy button: a
  clipboard is read by managers, synced between devices and kept in a history,
  none of which the app can undo, and the person already writes the passphrase
  down to type it back. It stays selectable text.
- **Dialog** ([ExitKitDialog.js](../chat/zkapi/components/ExitKitDialog.js),
  `<dialog>` with `showModal()`). Step 1 creates the kit; deriving the key and
  waiting for the wallet lock can take seconds, which lapses a click's user
  activation, so nothing downloads there. Step 2 is a real "Save file" button
  whose click builds the Blob, the object URL and the anchor click
  synchronously, in that fresh gesture and from inside the modal. The result
  is "Download started" with "Save again" (the same kit text, never a second
  kit); the passphrase is dropped the moment the kit exists, the encrypted text
  only when the dialog closes. The file is named
  `oa-chat-exit-kit-YYYY-MM-DD.json` (local date, no identifier). A string that
  is not exactly the sealed envelope is refused. Nothing is placed in
  `chatDB`, storage, a URL, account sync, `networkLogger` or an activity record,
  and the passphrase field is not autosaved.
- **What the page can know.** The SDK sets its `exported_seq` BEFORE the file is
  delivered, and `state_seq` moves with every settled chat, so "exported"
  proves nothing about a file. The facade keeps an in-memory flag: closing the
  dialog before a download started is "created, not saved", and the `kit`
  notice keeps showing for that balance for this page session. A reload forgets
  it, so the status row then says only "Created for this balance" (never "up to
  date"). A persisted "saved" mark was declined: it would need a new storage key.
  A later dialog that did save is not overridden by a late report from an older
  one.
- **Status row** (`ui.balanceExtras`): never created, created but not saved,
  created for an earlier balance (with the same button), current. A stale kit
  is a row with a one-click re-export, not a nag.
- **The exit RPC.** The only line is "Keep a current exit kit so you can leave
  even if the service is unavailable". The SDK keeps an optional exit RPC
  address in its own `localStorage` key `zkapi-exit-rpc-url`; this app has no
  control for it, never reads or writes it and never logs it (it may embed a
  secret), and because the SDK fetches that address itself it does not pass
  through the app's network proxy. `exit_release_pending` copy never mentions
  an exit RPC.
- **Not done.** The dialog cannot verify that a saved file decrypts (it would
  need a WebCrypto port of a revision 3-only module), and there is no in-app
  restore.

### 7.9 Giving up a zero or dust balance

Offered only for a balance on an `exit-only` version that has a deposit target,
whose protocol family opted in and whose registry row has not switched it off,
and only while the facade's verdict says `available` (so only a price move, a
chat key issued or another tab's write can still refuse at click time). The
write is described in [5.5](#giving-up-a-balance-a-user-gesture); this section
is what the person sees.

- A banner notice `abandon` (info) with "Give up this balance" (or "Clear this
  balance" when it is empty) and "Withdraw instead", and a quiet link in the
  balance card. The `upgrade` notice is hidden while the action is available,
  and its reminders are suppressed for that note only: another version's
  set-aside note keeps its tiers.
- [AbandonDialog.js](../chat/zkapi/components/AbandonDialog.js), a `<dialog>`.
  Empty: one button and no checkbox, since nothing is forfeited. Dust: a
  checkbox "I understand I won't get this balance back" and a button that names
  the amount, "Give up $0.42 (0.00014 ETH)", off until the box is ticked; the
  ether amount is always beside any dollar figure. The confirmation is bound to
  the note number and exact balance of the preview; a changed note or balance
  refuses. The outcome is said in a status region and focus moves to Reload.
  No native `confirm()`, and no "safe" or "lost".
- The words say what is given up, that nothing moves on Ethereum, that the
  deposit stays in the payment contract until it expires and that the treasury
  can then claim it as it would have anyway, and that this app can't bring the
  balance back once it is given up. Refusals are plain: a chat key still
  settling (try again in a moment), a balance now worth more than can be given
  up, another tab working on it. Without Web Locks the dialog is final and only
  offers Close.
- Registry data: `transition.dustThresholdUsdMicros` and
  `transition.abandonEnabled` ([3](#3-registry)). With the switch off the
  action is not drawn, and the service refuses it as `disabled`.
- Never for a balance the page cannot read. When the version's SDK did not
  start, the snapshot has no note, no charge cap and no price quote, so the
  verdict has nothing to judge (it would say `no_note`, which would claim the
  balance is not there) and the service's own `init()` would fail on the same
  missing manifest. The state renames the refusal `service_unreachable`, also
  over a verdict that said `available`, `abandonPreview()` is null and
  `giveUpBalance` answers `unavailable` without calling the service. A zero or
  dust note of a version whose operator is down therefore cannot be cleared
  until the page can start it, which is the situation the retirement
  precondition describes ([Retire a version](#retire-a-version)).

## 8. Data and storage keys

Persisted chat data still flows through `chatDB`. The keys below are a
documented exception: they must be readable **synchronously before `chatDB`
opens** (the boot decides the build first), and the intent must survive a new
tab. They hold presentation facts and version ids only, never a note id,
deployment id, amount or address, and none is account-synced (none is in
`SYNCABLE_PREF_KEYS`; a test scans `chat/services` for the hint, log and intent
keys).

| Key | Store | Written by | Content | Lifetime |
| --- | --- | --- | --- | --- |
| `oa-zkapi-version-switch` | sessionStorage | `requestVersionSwitch` | one-shot hint `{v: 1, at, from, reason, view, prefer}` (enums and version ids) | deleted by the next boot; ignored after 5 minutes; per tab |
| `oa-zkapi-version-switch-log` | sessionStorage | `requestVersionSwitch`, `recordDiscard`, `noteDiscard` | loop-guard timestamps `{t, k: 'switch' or 'discard'}`, at most 16 | never cleared by consuming a hint; entries age out after 60 s; per tab |
| `oa-zkapi-upgrade-v1` | localStorage | the facade's upgrade steps | `{v: 1, network, from, to, stage, since}` | until `done`, Dismiss or 45 days; survives a new tab or day |
| `oa-zkapi-upgrade-reminder-v1` | localStorage | `acknowledgeReminder` | `{v: 1, tiers: {"<network>:<versionId>": tier}}` | no expiry; a per-viewer convenience, never rendered |
| `oa-zkapi-running-modal` | sessionStorage | `AccountModal` (existing); also rewritten by a switch | existing shape, plus `{network, versionId}` when the facade is multi-version | the tab; an entry with a mismatching stamp is ignored, an unstamped one stays valid for the same network |
| `oa-zkapi-welcome-modal` | sessionStorage | `WelcomePanel` (existing) | same stamp rule | the tab |

Everything is read inside try/catch and the page renders correctly without it;
`localStorage` and `sessionStorage` can be empty or throw in private windows or
with blocked site data.

Unchanged by this work:

| Store or key | Notes |
| --- | --- |
| `zkapi-browser-wallet-fresh-20260930-{network}-v1` (IndexedDB) | shared by all versions; never renamed, imported, deleted or bumped |
| `oa-zkapi-address-funding-v1` row `${chain}:${vault}:native-eth` | per vault; the target gets its own scope; `store.keys()` was added for local discovery |
| Web Lock `oa-zkapi-address:[action:]${scope}`, BroadcastChannel `oa-zkapi-address-funding` | per scope / global |
| `oa-zkapi-wallet-method`, `oa-payment-mode`, `zkapi-oa-welcome-dismissed` | unscoped; the welcome dismissal must not suppress version notices, and seeing only the closed-deposits notice does not persist it |
| `chatDB` `oa-eth-deposit:${chain}:${vault}:${address}` | per vault and address; orphans on retired scopes are left |
| SDK-owned `zkapi-browser-deployment`, `zkapi-withdrawal-v2`, lock and channel `zkapi-wallet:active-runtime` | identical in both SDKs |
| In-app payment history | each SDK lists only its own deployment's records; the host reads the other versions' rows itself and shows them read-only, in memory ([5.4](#54-the-shared-wallet-database)). On-chain records remain |
| `archives` store of the wallet database | the SDK's. A confirmed give-up adds one `abandoned` record through the SDK's own archive transaction ([5.5](#55-host-writes-to-the-wallet-slot)); the host writes nothing else there |
| SDK-owned `zkapi-exit-rpc-url` (`localStorage`) | the SDK's optional exit RPC address. This app has no control for it and never reads, writes or logs it ([7.8](#78-the-exit-kit)) |

The protocol behaviors of [11.1](#111-protocol-wiring-requiredwiring) added
**no key**. What they hold is memory only and gone on reload: held refusals and
the service latch, the "kit created, not saved" flag, the other versions'
history rows, a pick in the settlement choice and the signer's page-session
memory of a concession it accepted. The exit kit's passphrase and text, a given-up
balance's amount and a foreign payment's record are never placed in `chatDB`,
storage, a URL, `networkLogger`, an activity record or account sync. A
balance the page cannot read ([5.10](#510-a-balance-the-page-holds-and-cannot-read))
adds none either: its failed-start latch and the error objects it remembers
live in the facade's memory and are gone on reload.

Nothing about versions or upgrade intent enters chat sessions, messages,
exports, shares or account sync.

## 9. Privacy and security notes

**What a version split reveals.**

- To whoever runs the static host (and the org when same-origin): which asset
  set a browser fetches, `/zkapi/**` or `/zkapi/v2c/**`, which marks the cohort
  "holds or loaded an older version". Proving-key sizes also differ between
  SDKs. Version-specific same-origin proxy prefixes
  (`/zkapi-deployment-v2c/`) are visible to the host and the stacks, and the
  user's IP is visible to the frontend host and the zkAPI stack. This is
  accepted and documented ([12](#12-known-limitations-and-decisions-taken),
  decision 3).
- Asset fetches by the SDK workers use `credentials: 'same-origin'` for proving
  keys; protocol, manifest and config requests omit credentials. A signed-in
  account's cookie scope for `/zkapi/**` was not verified.
- To the inference provider: nothing version-specific. Headers are rebuilt from
  an allowlist (below) and request-visible parameters (`openrouter_inference_base`,
  `request_charge_cap`) are held identical across live versions by registry
  rule. Operators should keep key TTL and limit rounding identical across stacks
  (not host code).
- To each zkAPI operator: its own version, by construction.

**Selection is local.** The build is a pure function of the version table, the
local wallet holdings and one validated one-shot hint. No URL parameter, hash,
`localStorage` value or network answer can choose a build, so a link cannot steer
a user into one. There is no version beacon: no `?v=` and no `/version` request;
only the selected build's assets are fetched, plus the version's own
`browser-config.json` integrity check and the `/build.json` poll described in
[5.7](#57-the-watcher-and-stale_build).

**Header allowlist.** `normalizeProviderHeaders`
([chat/zkapi/api.js](../chat/zkapi/api.js)) rebuilds `access.headers` for the
provider: `authorization` (the access's bearer), `content-type`, `http-referer`
(`location.origin`) and the constant `x-title: oa-chat`. Every other key is
dropped (the legacy SDK sent `oa-chat`, the successor sends `zkAPI`; the host
used to forward headers verbatim). A daemon-mode access is untouched.

**The upgrade is linkable.** The public withdrawal and the public deposit are
linkable by address, amount and time, and early migrators sit in a thin
anonymity set. Copy never claims otherwise, an amount is never prefilled, and
the new funding address and "different address" paths exist so the user can
choose.

**No auto actions.** The facade never signs, broadcasts, deposits, withdraws,
gives up a balance, creates an exit kit or reloads. The one automatic write is
the boot-time discard of an unused draft or plan under the wallet lock, and it
never runs for the target version. Retired-scope balance reads are gestures,
each of which links that address to the RPC provider by IP and time; nothing
polls them.

**The exit kit, the history and the give-up.**

- An exit kit is a user-initiated encrypted file that can move the whole
  balance, created with a generated 100-bit passphrase. The key derivation is
  local: creating one makes no request. The passphrase and the text are never
  stored, logged, synced or copied to a clipboard ([7.8](#78-the-exit-kit)). The SDK can read an
  optional exit RPC address of the person's own from its `localStorage`; the
  app offers no way to set one, and a read made to it comes from the SDK
  itself, not through the app's network proxy, so that provider sees the IP
  and the time like any RPC provider.
- Reading the other versions' payment history is local: a read-only IndexedDB
  transaction over two stores whose results stay in memory
  ([5.4](#54-the-shared-wallet-database)). It makes no request, and it never
  loads note secrets, plans or proofs.
- Giving up a balance touches only local state under the wallet lock: no
  request, no transaction, nothing deleted ([5.5](#55-host-writes-to-the-wallet-slot)).
- Claiming a credited payout is one ordinary public Ethereum transaction that
  any account may send and whose sender pays the network fee. The vault pays the
  credited destination, so the transaction publicly ties the sending account to
  that destination.
- Paying a withdrawal's network fee from the withdrawal sends it through the
  operator's relay, which sees the operation, the holding address, the owner and
  the receiving address before the network does. The page reaches the relay only
  through the app's own route (`<proxyPath>_bundler`), only after the person
  chose that way of paying, and the form says the relay sees it. The app's host
  learns the IP and time, as for the operator's proxy path
  ([11.7](#117-sponsored-withdrawals-the-network-fee-paid-from-the-withdrawal)).

**Other security properties.**

- Holdings are memory-only and never logged; the intent holds ids and a stage.
- The SDK source is pinned by revision (package.json, lock and registry) and its
  store by SHA-256; an unreviewed store fails the build rather than opening the
  default database.
- A version 2 deployment may pin `setup_id` `mpc-1` or `dev`, by one rule on both
  networks. A vault on `dev` keys rests on a single party: whoever holds that
  setup's toxic waste can forge proofs, mint balance, defeat an honest exit and
  take deposits. The host reports it (build warning, `build.json`, registry
  check) and does not block it; the app itself says nothing about it. The SDK
  accepts `dev` at run time on any chain, and only its build refuses it for
  mainnet. See
  [the limitation](#single-party-development-proof-setup-known-limitation).
- Profiles must be credential-free HTTPS origins with `require_oa_key_source`;
  the build checks emitted proving-key bytes against the reviewed pins after
  emission.
- Operator-controlled strings are bounded, escaped and plain text; a notice
  relaxes a gate only for a matching record and only while unexpired.
- The legacy SDK's message for a start that failed names the manifest address it
  asked for. For a balance the page cannot read, that text reaches no surface:
  the error is reworded in place before a toast takes it, the state carries only
  a boolean, and the words name no address, status code or cause
  ([5.10](#510-a-balance-the-page-holds-and-cannot-read)). The fact is memory
  only; no key, log or sync entry records that a balance was unreadable.
- Never clear site data to get past a check.

## 10. Runbooks

Every command below is run by a person; nothing in this repository runs them
for you (there is no CI configuration). Run `npm test` and the registry check
before merging a registry change.

### Activate a new version

Activating version 2 is a reviewed data change plus an SDK pin and a recovery
patch. It is not a data edit alone, and some of its inputs come from outside
this repository and cannot be produced here. The ten host behaviors its
protocol needs are implemented, tested and listed in `WIRED`
([11.1](#111-protocol-wiring-requiredwiring) says what each is, where it
lives and which test marks it), so the validator's wiring gate is met by the
checked-in set. What still refuses the row today, each on its own, is in
[11.4](#114-what-still-keeps-version-2-pending); the gate that is easiest to
miss is the SDK half of the withdrawal recheck, which the registry CLI check
and the build both enforce as `recovery_patch_coverage`.

The rest of this runbook is the order of work. A later deployment of an
already wired family is [Add a future version](#add-a-future-version).

**Gates (all must hold before the PR can merge).**

1. **The operator has deployed the vault and finalized the manifest.** The
   browser profile is generated from the **finalized** manifest, never from a
   `.pending` one, by upstream `scripts/deployment-profile.mjs` (a hand-written
   profile has to follow that script's rules). The browser format needs a base
   file, the SDK's own `sdk/assets/config/<network>.json`; upstream
   `docs/migration-concession-vault.md` (B2 step 5) runs it as:

   ```sh
   node scripts/deployment-profile.mjs --finalized <finalized manifest> \
     --deployment-id <new deployment id> \
     --protocol-server-url https://<operator api host> \
     --indexer-url https://<operator api host> \
     --verifier-url https://<OA verifier host> \
     --format sdk --base sdk/assets/config/<network>.json --out <profile>
   ```

   `--rpc-url`, `--price-feed` and `--settlement-window-seconds` default to the
   base's values. The deployment id is new (never containing `note-bound`; the
   script refuses it) and its protocol base URL differs from every other version's: a new hostname, or the
   same hostname under a plain path prefix ([one hostname for several deployments](#one-hostname-for-several-deployments)).
   The script keeps the base's browser-level fields, so three need editing
   before the file is pasted in as the inline `config`: `deployment_manifest_url`
   and the one entry of `allowed_deployment_manifest_urls` (both
   `<protocol base URL>/config.json`; the base ships `null` and `[]`) and
   `deployment_api_proxy_path` (equal to the row's `proxyPath`; the base carries
   version 1's `/zkapi-deployment/`). The registry also requires the shape of
   `mainnet.json`: protocol and indexer on one origin, `proving_keys_base_url:
   "./proofs/"`, `require_oa_key_source: true`, `verifier_url` and the reviewed
   `openrouter_inference_base`. On mainnet the script's `--canary` adds the
   launch caps ([Mainnet canary](#sequencing-and-coordination)).
2. **Proof setup: choose it and record it.** The host accepts `mpc-1` and
   `dev` by one rule on both networks, Sepolia included ([3](#3-registry)). The
   SDK package ships one proof bundle with one setup id, and both networks'
   profiles in it must pin that id (its own build refuses a profile whose
   `setup_id` differs, `setup_mismatch`, and so does the host's check against the
   bundle's manifest), so one revision means one setup on both networks. The
   package's `assets/manifest.json` and both of its network profiles say `dev`
   (at `82c8504` and at `4b955d9` alike); a bundle for `mpc-1` comes from
   upstream's `scripts/build-browser-client.sh --setup mpc-1` and
   `scripts/sync-sdk-assets.mjs --setup mpc-1`, and upstream's ceremony has not
   produced keys yet
   ([the limitation](#single-party-development-proof-setup-known-limitation)).
   State the setup the activation uses in the activation change, with the
   limitation for `dev`; nothing in this repository checks that statement.
   - **Sepolia on `dev`:** no rule has to be relaxed. The SDK's build accepts
     it, the vault script deploys it with `ALLOW_DEV_SETUP=1` (a drill vault in
     upstream's words), and the operator runs it from images built with
     `ALLOW_DEV_SETUP=1`
     ([the limitation](#single-party-development-proof-setup-known-limitation)).
     The host's build warns once per live version and the registry check repeats
     it.
   - **Mainnet on `dev`:** the same steps. Since `4b955d9` the SDK's build no
     longer refuses it (a rehearsal build of that revision builds mainnet on
     `dev` through the host's pipeline, [11.6](#116-the-reference-revision-82c8504-to-4b955d9)),
     and the vault script, the operator images and the companion build take
     `ALLOW_DEV_SETUP=1` instead of refusing. A pin of `82c8504` or older still
     stops at `development_setup_on_mainnet`, and the registry check says so
     when that package is installed.
   - **A vault on `dev` keys is not later switched to `mpc-1`.** Moving is a
     new vault and a further version
     ([Add a future version](#add-a-future-version)), so decide before the vault
     is deployed.

   A real-SDK build of `4b955d9` through the host's build pipeline needs no
   change to the host for its `dev` bundle, on either network. What the package
   still lacks is a deployed profile (its `not_deployed` placeholders are
   refused by the SDK's build and by `verifyPlanOnDisk`) and a covering recovery
   patch, so a rehearsal that builds it supplies both in a scratch copy that is
   never committed or shipped ([11.6](#116-the-reference-revision-82c8504-to-4b955d9)
   says how it was done).
3. **The SDK commit.** It is on GitHub, has no install or prepare scripts (a
   git dependency whose commit cannot be fetched fails `npm install`) and ships
   a **deployed** profile for every network being activated. The SDK's own
   `./build` reads its package's `assets/config/<network>.json`, not the host's
   inline `config`, and throws `deployment_not_deployed` for a
   `not_deployed` placeholder; the `0.2.0` snapshot ships placeholders for both
   networks, so building it fails today. Upstream's order (B3) is to pin the
   deployed profile into that file, run `scripts/sync-sdk-assets.mjs --setup
   <id> --network <network>` and `npm run verify:assets` in the SDK repository,
   and pin the resulting commit here. `verifyPlanOnDisk` refuses a placeholder
   package profile before `dist/` is touched, and runs the SDK's own
   `assertDeployableProfile` on the host's reviewed profile against the bundle
   (circuit, setup, proving-key hashes, and for chain 1 the rule that the bundle
   is `mpc-1`).
4. **The recovery review** for that revision is done (a port, a reviewed patch,
   or an explicit `not_required`;
   [11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)) **and the SDK
   half of the withdrawal recheck is covered for that revision.** Whatever the
   verdict, `sdk.patches` must name a registered patch that `PATCH_COVERAGE`
   says covers `withdrawal-operation-recheck`, and that patch must be bound to
   the row's own `sdk.revision`: a patch bound to another revision does not
   count, and a `not_required` verdict on its own is not coverage. The rule
   (`recovery_patch_coverage`, no override) is enforced by `planFromRegistry`,
   so by the build and by the Vercel route generator that plans the shipped
   registry, and by the registry CLI check. There are two ways to meet it:
   the `wallet-recovery-v2c` hunks listed in 11.2 (an entry with files, hashed
   against that revision's bytes), or, when the revision provides the half
   itself (the rehearsal test passes against the unpatched revision), an entry
   with `files: []`, registered in `SDK_PATCHES` with one `PATCH_COVERAGE` line,
   which rewrites nothing and still refuses any other revision. Either way the
   module needs its `.vercelignore` line, and the tests of the table below
   change with it. On the first mainnet activation the review also requires
   the launch canary in the profile (`trusted_deployment.canary`, the profile
   script's `--canary`): the registry passes it through but does not verify
   it, so it is a reviewed item.
5. **The protocol wiring** is implemented, tested and listed in `WIRED`. For
   `concession-v1` it is
   ([11.1](#111-protocol-wiring-requiredwiring)). A new family must do it
   first: its adapter lists `requiredWiring`, and `zkapi-wiring.test.mjs`
   fails until each name has a runnable test titled `wiring:<name>` that
   imports a named production symbol, and `WIRED` follows in the same diff.
   **One known gap of `concession-v1` stays open and is not a gate:** the
   dialog's call sites that only continue an earlier withdrawal name no
   concession bound, so the signer refuses a conceding escape there and the
   person starts again ([11.1](#111-protocol-wiring-requiredwiring),
   [11.5](#115-known-limits-and-support-runbooks)). A test pins the exact set of
   those call sites; neither the validator, the registry check nor the build
   looks at it, so nothing stops a merge. Close it (a bound for a balance the
   withdraw form is not showing is a product decision) or record an explicit
   acceptance in the activation change.
6. **A Sepolia rehearsal has passed.** The operator's drills are upstream's
   (B2 step 8 acceptance and the 14-day soak of B4). On the host side check, on
   the rehearsal build:
   - a fresh profile lands on version 2; MetaMask and Send Ethereum deposits
     work; a chat works; each of the ten behaviors above is exercised (for
     example the service message by stopping the stack, an exit kit export, a
     credited payout claim);
   - a profile holding a version 1 note lands on version 1 with deposits closed;
     withdraw, reload, and deposit on version 2 (including the Sepolia
     password re-entry); the escape path when the service is unavailable;
   - a version 1 withdrawal still open with an empty slot offers "Open version
     1"; a tab left open on the previous bundle refuses a slot version 2 holds
     (the SDK's own foreign-wallet refusal). It does **not** close its deposits
     a few minutes after the deploy: the previous bundle of a first activation
     is today's dormant single-version build, which has no watcher and no
     `stale_build` latch, so that tab can still start a version 1 deposit until
     it reloads ([5.7](#57-the-watcher-and-stale_build), honest limit). Record
     that as the observed result; the operator's closure of the legacy routes
     is the only control for such tabs. `stale_build` is exercised only between
     two versioning-active bundles, for example when a later deployment (a
     rollback, a retirement) reaches a tab that runs the activation bundle;
   - with a version 1 note in the wallet and the version 1 stack stopped (its
     manifest route answering 503), the page says the balance is "Saved in this
     browser", offers Reload and nothing else, and shows no operator address
     anywhere (panel, dialog, welcome, a send); after the stack is back, a
     Reload shows the ordinary balance
     ([5.10](#510-a-balance-the-page-holds-and-cannot-read)). Nothing in this
     drill withdraws, gives up or archives: while the stack is down none of them
     is possible, which is why the stack must not be retired while holders
     remain;
   - the [Roll back](#roll-back) steps, built and verified;
   - the real-SDK rehearsal and the drift guards below, which run only with the
     real package present.

**Activation-time evidence.** These skip in an ordinary checkout and run when
the successor package is installed under its alias (the activation change does
that), or, for a plain module test, when `ZKAPI_V2_SDK_DIR` names an unpacked
copy of the SDK repository. Run them against the revision being pinned:

```sh
node --test test/zkapi/zkapi-v2-real-sdk-rehearsal.test.mjs
ZKAPI_V2_SDK_DIR=<unpacked zkapi repository> node scripts/run-unit-tests.mjs
```

- `zkapi-v2-real-sdk-rehearsal.test.mjs`: the SDK half of the recheck, a
  credited payout claimed through the Send Ethereum signer, a mutual close the
  SDK turns into an escape signed within the disclosed cap, and a real exit kit.
  Its first test **fails against a revision without the SDK half** (the `0.2.0`
  snapshot returns the replaced operation). That failure is the gate: the row
  stays pending until a covering patch makes it pass. An unpacked directory
  runs unpatched; the alias form is patched by `postinstall` once the row names
  the patch.
- The drift guards that discover the installed alias (each reads
  `deployments/zkapi/registry.json` and looks under `node_modules/<sdk.alias>`
  of every row, skipping a package that is not there): the slot keys
  (`zkapi-wallet-holdings.test.mjs`, [11.3](#113-wallet-slot-drift-check)), the
  stored-record schema of the history reader
  (`zkapi-other-version-history.test.mjs`), the price and unit math
  (`zkapi-abandon-verdict.test.mjs`), that the SDK's archive drops only what
  the give-up verdict refuses on (`zkapi-abandon-note.test.mjs`), and the real
  client, store and encoders in `zkapi-record-extras.test.mjs` and
  `address-funding-escape-concession.test.mjs`. Of these only the abandon-note,
  record-extras and escape-concession tests (and the rehearsal itself) also
  accept `ZKAPI_V2_SDK_DIR`.
- **`zkapi-deposit-guard-successor.test.mjs`** reads the real client and runtime
  of the successor (alias, or `ZKAPI_V2_SDK_DIR`) and checks that the adapter
  classifies every `/deposit/i` method and that, on a closed version, only the
  listed entry points are wrapped. It is the one that found
  `confirmedDepositFor` and `completeConfirmedDeposit` at `4b955d9`
  ([11.6](#116-the-reference-revision-82c8504-to-4b955d9)). It sits beside
  `zkapi-deposit-guard.test.mjs`, whose drift tests read the legacy SDK and the
  fixture and nothing else, so installing the alias does not put the real
  classes under that file.
- `node test/fixtures/zkapi-v2-real-shapes/regenerate.mjs <zkapi repository>
  --check` says whether the committed real-shape fixtures still match the SDK's
  bytes; run it without `--check` when the pin moves and review the diff.
- `node test/fixtures/zkapi-sdk-v2-fixture/verify-exports.mjs <SDK package
  root>` says whether the fixture SDK still exports exactly the real SDK's
  names and instance surface (`--update` re-records the digests after a
  deliberate change; `refresh-assets.mjs` beside it follows a moved proving
  key). The fixture stands in for the package in the build and deposit-guard
  tests. It was made from the `82c8504` snapshot and re-recorded for `4b955d9`
  (names, the `gasless: null` profile field and the build's own clause), so a
  pin that moves to the published commit leaves it silently stale until this is
  run.

**The code change.** None for the ten behaviors. The change is the recovery
patch module and its registrations, the package pin and the registry, the tests
that hard-code the dormant registry (below). Whatever
`zkapi-deposit-guard-successor.test.mjs` reports for the pinned revision (a
`/deposit/i` method no list names) is classified in the adapter first. A family
with behaviors of its own would add them first, as
[Add a future version](#add-a-future-version) says.

**The data change.**

```
registry.json   v1.networks.<n>   active -> exit-only  (+ depositsClosedSince)
registry.json   v2.networks.<n>   pending -> active    (+ activatedAt, config = the finalized profile)
registry.json   v2.sdk.{source, revision, storeSha256, patches}, v2.gate.*   filled
package.json    + "zkapi-sdk-v2c": "github:<owner>/<repo>#<40-hex>"   (and the lock)
patches/        + zkapi-browser-sdk-v2c-recovery.mjs   (wallet-recovery-v2c, bound to that revision)
patch-zkapi-sdk.mjs   + the SDK_PATCHES entry and its PATCH_COVERAGE line
.vercelignore   + the patch module's line
```

Steps:

1. `npm install zkapi-sdk-v2c@github:<owner>/<repo>#<40-hex>` (the alias form:
   npm installs it under `node_modules/zkapi-sdk-v2c` and the two SDKs coexist).
   Both packages report the same package name and version, so the registry's
   alias, revision and `circuitId` are what tell them apart. The key in
   `dependencies` must equal `sdk.alias` and the value `sdk.source`.
2. `node scripts/zkapi-registry-cli.mjs store-hash zkapi-sdk-v2c` and put the
   result in `sdk.storeSha256`.
3. Fill `sdk.source`, `sdk.revision` (equal to the lock's commit),
   `gate.recoveryReview` (`revision`, `verdict`, `patch`), `gate.protocolWiring:
   "done"` and `gate.manifestSha256`: the SHA-256 of the finalized manifest file
   the profile was generated from (`shasum -a 256 <finalized manifest>`). The
   registry checks only that it is 64 hex digits and present, so it is a
   recorded pin, not a verified value. Set `honorsDepositsFlag` as the SDK
   dictates.
4. Add the recovery patch for the revision: `patches/zkapi-browser-sdk-v2c-recovery.mjs`
   (hunks in [11.2](#112-the-withdrawal-recheck-and-the-recovery-patch), each
   `before` text matching exactly once and file hashes pinned), register it in
   `SDK_PATCHES` under `wallet-recovery-v2c` with its `PATCH_COVERAGE` line,
   list it in `sdk.patches`, and add its `.vercelignore` line. Add the test that
   exercises each hunk beside `sdk-recovery-patch.test.mjs`, and update
   `zkapi-recovery-coverage.test.mjs`, which pins the registered names. If the
   revision provides the SDK half itself (the rehearsal passes unpatched), the
   module is `export default { revision: '<40-hex>', files: [] }`, registered
   and listed in `sdk.patches` the same way: it rewrites nothing and still
   refuses another revision. The review then reads `verdict: "not_required"`
   with `patch: null` (the validator refuses a `not_required` review that
   names a patch), while `sdk.patches` keeps the entry: the verdict alone is
   not coverage.
5. Flip the entries for **one network first** (Sepolia): version 2 to `active`
   with `activatedAt` and the inline `config`; version 1 to `exit-only` with
   `depositsClosedSince`. The row-level fields are shared by both networks, so
   the other network's entry stays `pending` with its `not_deployed` config and
   keeps building without version 2.
6. Update the dormant-state tests (next subsection).
7. `node scripts/zkapi-registry-cli.mjs check --base origin/main`: it refuses
   the row here with `recovery_patch_coverage` if step 4 is missing. A version
   on the `dev` proof setup passes and prints its warnings (and, on mainnet,
   the SDK refusal when the package is installed); copy them into the
   activation change next to the recorded setup choice (gate 2).
8. `npm test` (its `pretest` applies the patches), then the activation-time
   evidence above, then build both networks and generate the Vercel config for
   each (run the generator by its real path, [4.5](#45-patches-per-version)):

   ```sh
   OA_ORG_SAME_ORIGIN=true OA_ZKAPI_NETWORK=<n> \
     OA_ZKAPI_DEPLOYMENT=fresh-20260930 npm run build
   OA_DEPLOYMENT_ORG_ORIGIN=<org origin> OA_ZKAPI_NETWORK=<n> \
     OA_ZKAPI_DEPLOYMENT=fresh-20260930 \
     node scripts/generate-zkapi-vercel-config.mjs vercel.generated.json
   ```
9. Inspect `dist/build.json`: `zkapi.versions` lists both versions with the
   expected status, `zkapi.depositTarget` is `v2` on the activated network, each
   `configSha256` equals the sha256 of the emitted `browser-config.json`, the
   version 2 entry's `setupId` and `proofSetup` are the setup recorded in gate 2
   (`mpc-1` and `ceremony`, or `dev` and `development`; a `dev` build also
   printed its `[build] WARNING` line), and the generated `rewrites` start with
   `/zkapi-deployment/:path*` then `/zkapi-deployment-v2c/:path*`.

**Tests that hard-code the dormant registry.** Several tests read the shipped
registry, the patch registrations or the patch module list and assert today's
state (version 1 `active`, version 2 `pending`, one patch). They fail the moment
the activation change of steps 1 to 5 is made, and each is to be updated to
assert the activated state, not deleted. The list below was produced by doing
exactly that in a scratch copy of this checkout: the repository's fixture SDK
installed as `zkapi-sdk-v2c`, version 2 activated on Sepolia first with a
covering patch of `files: []` registered in `SDK_PATCHES` and `PATCH_COVERAGE`,
its `.vercelignore` line added and `check --base` green, then both test groups
run. Flipping mainnet as well changed nothing in the list. The 52 further
failures that appear the moment any package sits under the alias are not in it:
those are the tests that discover the alias and are written for the real SDK;
the fixture is a stub, so they fail against it, and they pass against the real
`0.2.0` snapshot except the one gate that is meant to fail
([13](#13-test-map)). Find the rows below by their titles:

| File | Test title (stable part) | Asserts today, and what the activation changes |
| --- | --- | --- |
| `test/architecture/zkapiVersionedBuild.test.js` | `dormant registry: single mode emits exactly the legacy assets, bytes and rewrites` | `single` mode, version 1 only, one `/zkapi-deployment` rewrite, the legacy file list; an activated network is `multi` |
| same | `a dormant single-version build emits the legacy tree, byte for byte, except zkapi.css` | the registry build equals the legacy builder's tree; the activated network also emits `v2c/**` |
| same | `the bundled Vercel generator imports only node built-ins and routes every live version` | exactly one `/zkapi-deployment` source per network; the activated network gains `/zkapi-deployment-v2c/:path*` |
| same | `Vercel source uploads allow exactly the reviewed registry file besides the pins` | its `excluded` list names `patches/zkapi-browser-sdk-v2c-recovery.mjs`, the module step 4 adds a `.vercelignore` line for: move that name to `included`. Keep the line; without it Vercel does not upload the module and `postinstall` cannot import it |
| `test/zkapi/zkapi-registry-model.test.mjs` | `the shipped registry validates against the reviewed profiles and is dormant` | version 1 is the only live row and target; version 2 `pending` with the placeholder |
| same | `the shipped registry matches the fixture registry and v2 still cannot go live from it` | the shipped file equals `validRegistry()`; the successor's gates are all open |
| `test/zkapi/zkapi-recovery-coverage.test.mjs` | `a registry whose successor is pending, or whose live rows need nothing, has no gap` | the shipped registry's successor is `pending` on both networks |
| same | `the shipped registry cannot be planned for a build while a live row lacks the SDK half` | its mirror of the scripts copies only the legacy patch module (add the new one), and it expects the shipped registry to plan `single` |
| same | `PATCH_COVERAGE names registered patches and adapter wiring, and is not part of a patch entry` | the registered names are exactly `wallet-recovery-v1`; add the new name |
| same | `the reviewed patches are the map joined with the revision each patch is bound to` | the join has one entry; add the new entry with its revision |
| `test/zkapi/sdk-recovery-patch.test.mjs` | `install guard: a live legacy row patches the SDK and a repeat changes nothing`, `install guard: a live legacy row still fails loudly when its package, pin or bytes are wrong`, `install guard: runs when started through a symlink to the checkout` | `checkout()` copies one patch module into its throwaway tree, so the copied script cannot import the second: add it to the file list |
| same | `install guard: a retired legacy row needs neither its package nor its dependency`, `install guard: a retired legacy row that is still installed is left alone, not failed on`, `patchRegisteredSdks drives every row, legacy included, from its status` | the same file list, and then still "The zkAPI SDK revision changed": `retiredLegacyRegistry()` and the registry the last test drives derive the live successor from the shipped row, which now names a patch bound to another revision than the pin the test writes into `package.json`. Build those rows from the activated row |

Four of these are architecture tests and show first: `npm test` runs the
architecture group (every test file outside `test/zkapi`) and stops there if it
fails, and the `test/zkapi` group runs only after it passes, so the twelve
payment-group rows appear once the architecture rows are green. Run that group
directly with `node --test test/zkapi/zkapi-registry-model.test.mjs
test/zkapi/zkapi-recovery-coverage.test.mjs test/zkapi/sdk-recovery-patch.test.mjs`
to see them at once. Before step 1 is done (the package not installed), the
three build tests of `test/architecture/zkapiBuild.test.js`
(`fresh asset emission and Vercel rewrites use identical pins with complete
integrity metadata`, `clean-reset bundles isolate wallet writes and preserve
existing origin storage and SDK source`, `fresh selection checks emitted
proving bytes before writing replacement config`) also fail, with "is not
installed": they build the shipped registry and pass once the alias is there,
for one network flipped or both.

**Hosts that compose this repository.** `ZKAPI_PAYMENTS.md` and the
fresh-deployment records
([20260928](ZKAPI_FRESH_DEPLOYMENT_20260928.md),
[20260930](ZKAPI_FRESH_DEPLOYMENT_20260930.md)) describe the Commercial staging
composition (`OpenAnonymity-FPL/oa-commercial`): a separate repository that
pins this one by a submodule link and by its own
`scripts/oa-chat-revision.json` (updated together), runs its own release gates
and has its own Vercel project. This repository does not contain it, and
nothing here checks it. A composition that builds this tree carries the
following. Items marked **now** are needed as soon as this change is taken, with
version 2 still dormant (the registry, the boot module and the new build
scripts are already in the build); items marked **at activation** are what
turning version 2 on adds:

- **now:** bump the pinned core (the link and `scripts/oa-chat-revision.json`
  together). **At activation** the new SDK alias arrives through the core's
  `package.json` and lock, so the composition's install step must be able to
  resolve a GitHub commit dependency;
- **now:** the release or upload allowlist (this repository's `.vercelignore`
  is the model) must include `deployments/zkapi/registry.json` next to the two
  profile files (`postinstall`, the build and the route generator import it),
  `chat/zkapi/versioning/**`, `scripts/zkapi*.mjs` and
  `scripts/patch-zkapi-sdk.mjs`. **At activation** also every patch module an
  `sdk.patches` entry names (one explicit line each);
- **at activation:** a project with its own `vercel.json`, or one that applies a
  previously generated file, must apply the regenerated routing: it gains a
  second rewrite, `/zkapi-deployment-v2c/:path*` to version 2's protocol
  origin. Without it version 2's operator calls fall through to the
  single-page-app rewrite and receive HTML;
- re-baseline any artifact or asset-hash gate. **Now:** a changed
  `dist/zkapi/zkapi.css`, three new `build.json` fields, different JavaScript
  chunks and a larger payment chunk graph
  ([Dormant means identical](#dormant-means-identical)); every other file under
  `dist/zkapi/` is unchanged. **At activation:** new files under
  `dist/zkapi/v2c/**` and the activated network's changed `build.json`;
- keep `OA_ZKAPI_DEPLOYMENT=fresh-20260930`. It is the lineage and names the
  wallet database; changing it orphans wallets. No new environment variable is
  needed (`OA_ZKAPI_NETWORK`, `OA_ORG_SAME_ORIGIN` and
  `OA_DEPLOYMENT_ORG_ORIGIN` are unchanged);
- **now:** Vercel evaluates a relocated bundle of the route generator before
  the dependencies are installed ([APP_STATE.md](APP_STATE.md), 2026-09-28
  entry), so it must keep importing only `node:` built-ins; a test pins this.

#### Sequencing and coordination

Deploy Sepolia first. For mainnet, the operator's schedule drives the merge
(upstream, "The 30-day transition"):

- **Day 0** is the moment the legacy deposit routes close at the gateway, in the
  same change window as the new vault's go-live and the publication of the
  legacy re-cut with `"deposits": "closed"`.
- **`N_C`** is `nextNoteId()` of the legacy vault read right after day 0. A note
  with an id below it is a transition note; a note at or above it is a late
  note (a direct deposit that bypassed every official client). Nothing in the
  registry or the app uses `N_C`; the Retire runbook's "no late notes" test
  does.
- **`X`** is the moment legacy admission closes: the expiry of note `N_C - 1`,
  before day 31. The operator announces day 0, `X` and the sweep policy at
  least 14 days ahead.

Prepare the mainnet entry in advance and merge it at day 0. Merging earlier
closes deposits in the app while the operator's gateway still takes them;
merging later leaves the app offering legacy deposits after day 0. The gateway
cutoff does not stop browser deposits and the legacy SDK ignores the profile
flag, so this app's registry is the only control in the browser.

**Mainnet canary.** Upstream publishes the first mainnet build with a launch
canary: `trusted_deployment.canary` with `per_note_max_wei`,
`aggregate_max_wei` and `until` (the profile script's `--canary`), for 30 days.
The registry passes it through the inline `config` unchanged and the validator
does not look at it. The SDK enforces it: a deposit over a cap fails with
`canary_cap_exceeded`, a vault balance it cannot read with
`canary_cap_unverified`, and a deployment that does not match the pins with
`deployment_mismatch` or `deployment_unverifiable`. Each error carries the
SDK's own `shortMessage`, which the app shows as written; the host has no copy
or test of its own for them, so rehearse them. The caps stop applying by
themselves at `until`; removing the object afterwards is a data change that
changes `configSha256`. Direct depositors bypass the SDK caps.

**Relay announcements as data.** Set `depositsClosedSince` to day 0 and
`admissionClosesAt` to `X` (copy only). For an escape the operator announced as
stuck on a destination that rejects ETH, add a `stuck_escape` notice on the
exit-only row with the note id, destination, an `expiresAt` and the operator's
text (at most 280 characters). It relaxes the deposit gate only for that note's
pending escape while unexpired.

**Post-activation verification.**

- The served `/zkapi/v2c/browser-config.json` hashes to the embedded
  `configSha256` (boot reports `config_mismatch` otherwise, which blocks
  deposits only).
- The console shows no `[zkapi] Deposit methods not classified by the adapter`
  warning and no `[zkapi] Private payments could not start` line.
- A fresh profile lands on version 2 with deposits allowed; a profile holding a
  version 1 note lands on version 1 with deposits closed, the "About versions"
  pill and an upgrade banner; a tab left open on the previous bundle refuses a
  slot held by version 2 (and, having no watcher, can still start a version 1
  deposit until it reloads).
- The upgrade drill from [7.3](#73-guided-upgrade-stages) completes on Sepolia,
  including the Sepolia password re-entry.

### Add a future version

Same family (a new deployment of an existing protocol): add a row.

1. A new row with the next ordinal, a new `id`, `adapter` of the family, the
   family's `circuitId` and `vaultRevision`, a new npm alias, a new `publicPath`
   and `proxyPath` (no prefix relation between any public path and any proxy
   path, or between two proxy paths), the standard `transition`, and both
   network entries `pending` with `config: {"deployment_status":
   "not_deployed"}`.
2. When deployed: `npm install <alias>@github:...#<sha>`, `store-hash`, fill
   `sdk` and `gate`, set the activation entries and flip the previous target to
   `exit-only` in the **same** change. The loader, facade, guard, upgrade prompt
   and UI are N-version by construction, and a version 1 holder is offered the
   current target directly. What does not come for free is whatever the new
   deployment's gates demand (a recovery review of its SDK revision, the
   protocol wiring of a family that has any) and the host and test work in
   [Activate a new version](#activate-a-new-version): the dormant-state tests
   and, for a composing host, its allowlist and routing.
3. `check --base`, `npm test` and the builds, as in activation.

New family (a different protocol): additionally a module
`chat/zkapi/versioning/adapters/<family>.mjs` registered in `adapters/index.mjs`
with `id`, `circuitId`, `vaultRevision`, `validateProfile`, `fundingFromProfile`,
`callProfile`, `depositEntryPoints`, `recoveryEntryPoints`, `sweepablePhases`,
`normalizeSnapshot`, `closeBy`, `chatCutoffSeconds`, `requiredWiring`,
`requiresManifestSha256`, `billing` (the asset, unit and `perEth` of its
amounts, which the history rows are formatted by) and `abandon` (`supported`,
`smallestChatTierUsdMicros`, `dustCeilingUnits`; `supported: false` until the
family has had its own recovery review for giving up a balance). An adapter
may add `watchFacts(reading)`, which names the per-chat facts the holdings
watcher must not wake on (a fact is dropped only by being named, so a new field
costs one read and never a missed one). The snapshot-adapter tests (call
profile equals the real encoders) and the deposit-guard drift test must pass for
it; every name
`chat/zkapi` imports from the SDK must exist in every live SDK (the name-parity
gate), and `chat/zkapi/index.js` should need no change.

### Retire a version

Only after the last note of the version has expired or exited and the claim
window has passed, and only when the precondition below holds. Upstream's
reference points for the legacy vault: about day 32 with no late notes
(`nextNoteId()` still equals the `N_C` the operator published at day 0), and
before day 63 with late notes deposited before the admission cutoff; the
operator announces its own refund and sweep policy.

**Precondition: no browser may still hold a note of the version, expired or
not. Nothing checks it, and waiting for expiry does not meet it.** Neither the
registry nor the build can see a browser's wallet, and once a version's service
is gone the app cannot move such a holder on
([5.10](#510-a-balance-the-page-holds-and-cannot-read)):

- A retired version's build is no longer shipped, and the legacy SDK starts only
  when its operator's manifest answers, so the note can be neither withdrawn,
  given up nor archived. The successor's SDK refuses the wallet. The holder gets
  the retirement copy ("a balance from a version that has been retired and can't
  be opened here") with deposits paused and no action.
- Expiry does not release the slot by itself. It is cleared only by a started
  SDK, through "Start a new balance" after a verified expiry payment or a
  confirmed give-up.
- So such a person is stuck until the note has expired and, beyond that, until an
  in-app archive action exists that works without the version's service. That
  action does not exist. A retirement therefore strands every browser that
  still holds a note of the version, and the operator's "the last note has
  expired" (an on-chain fact) does not say which browsers have cleared theirs.
  Treat the precondition as a blocker, not as a warning.
- A version that is merely down, not retired, is the temporary case: the holder
  keeps the balance, is told it is saved and the service is not available, and
  gets the ordinary balance back on the first load after the service answers.

1. Check the other holders that may remain, because a retired version is
   ignored by the loader and the state: its open withdrawals and credits appear
   nowhere that can act on them (Payment history lists them as text that says
   the app can no longer open that version).
   - **No unclaimed credits.** A payout the payment contract only credited can
     be claimed only from that version's build (or directly on Ethereum).
     Retire a version only when no browser can still hold one: the app cannot
     show it afterwards and there is no in-app claim for it
     ([11.5](#115-known-limits-and-support-runbooks)).
   - An open withdrawal can still be finished directly on Ethereum; the
     retirement copy says so and says deposits are paused.
   - The give-up action ([7.9](#79-giving-up-a-zero-or-dust-balance)) covers
     only a zero or dust balance of a version that still has a deposit target
     and whose family opted in, and only while its service starts. A larger
     balance, a set-aside note and an open withdrawal have no in-app archive
     action.
2. Set the entries to `status: "retired"` with `retiredAt` and
   `tombstone: {deploymentId, chainId, vault}` (the chain id must be the
   network's). The tombstone must name the deployment the row had while live:
   the check refuses a different one (`tombstone_mismatch`). Remove
   `profile`/`config` and `admissionClosesAt`, and `notices` (only an
   `exit-only` row may carry them).
3. Once the version is retired **on every network**, remove its alias from
   `package.json` and the lock; `postinstall` then skips it. While it is still
   live on the other network, its alias must stay installed: that network's
   build verifies every live alias and fails with "The zkAPI SDK package ... is
   not installed" otherwise. If the retired version is the last one under the
   canonical alias, the surviving version is then built through the facade
   mechanism.
4. Prune `GUARDED_UNION_ONLY_NAMES` entries that named a name only the retired
   SDK exported (they fail the build as stale).
5. `check --base`, tests and builds as in activation. A holder of the retired
   deployment gets `retired_deployment` (deposits blocked, retirement copy, the
   gate ignores its open records, no "Nothing is lost", and no action: see the
   precondition above).

Upstream asks operators to keep the legacy SDK bytes, keys and client releases
available after retirement; that is the operator's artifact retention, separate
from what this app serves, and it does not make a browser's balance readable
here: the legacy SDK starts only against its operator's manifest
([5.10](#510-a-balance-the-page-holds-and-cannot-read)).

### Roll back

After any version 2 deposit the safe rollback is version 2 `exit-only` with
deposits closed plus version 1 `active`. The validator permits exactly this.

**Preconditions, which are the operator's and which nothing here checks.** The
registry check and the build accept this rollback in any circumstances; they
cannot see the operator's stacks. Upstream's `docs/migration-concession-vault.md`
(the Rollback table, Phase E steps 1, 2 and 6, and "Late notes") states what has
to hold:

- The version 1 stack must still run: its gateway admission (it answers new
  requests until `X`, after which the legacy gateway returns 410
  `deployment_retiring` on new leases) and its challenger (it runs until the
  legacy retirement conditions of Phase E, step 6 hold). Reopen version 1 only
  while that stack runs, before `X`. After `X`, or once the legacy stack is
  retired, reopening version 1 would offer deposits into a vault whose gateway
  refuses new chats and whose challenger may be gone.
- Every deposit made into version 1 after day 0 is a late note (id at or above
  `N_C`). Late notes are what stretch the legacy challenger's life from about
  day 32 to before day 63 (upstream, "Late notes"). Tell the operator before
  rolling back. If late notes already exist, or `X` has passed, roll back only
  with the operator's explicit commitment to keep the legacy challenger and
  admission running for the notes the rollback adds.
- Version 2's own gateway has to answer 410 on its two deposit-only tree routes
  (`/v1/tree/next-note-id` and `/v1/tree/notes/{id}/zero-path`) before
  deposits are considered closed: the profile flag reaches only the SDK, and
  `zkapi-clientd` takes every deposit path from those routes. Keep the version 2
  stack running until its vault drains; if the fault is in the vault or circuit,
  upstream's answer is a corrected vault with a new circuit id, which is a new
  version here.
- Agree the copy dates with the operator: `depositsClosedSince` for version 2
  and, if admission closes, `admissionClosesAt`.
- Do not let either stack go while a browser may still hold one of its notes.
  The app cannot withdraw, give up or archive a note whose service does not
  start: that holder is told the balance is saved in this browser and the
  service is not available, and nothing more
  ([5.10](#510-a-balance-the-page-holds-and-cannot-read)). For a stack that is
  gone for good this is the precondition of
  [Retire a version](#retire-a-version).

**Registry steps.**

1. On the network: version 2 `active -> exit-only` with `depositsClosedSince`
   (its SDK honors the flag, so the emitted config gains `deposits: "closed"`).
2. Version 1 `exit-only -> active`: delete its `depositsClosedSince` (and any
   `notices`), which `active` forbids. Keep `admissionClosesAt` only if the
   operator still intends to close admission.
3. `check --base` passes because the move is the allowed rollback (a live
   higher version, all `exit-only`); a plain `git revert` of the activation
   fails it (version 1 would move back to `active` and version 2 to `pending`).
   Never set an activated row back to `pending`.
4. Holders of version 2 keep chat, close and escape; the app offers them an
   upgrade to version 1 by the same rules.

The same check refuses to reopen version 1 while version 2 is still `pending`
(a close with no live successor); that state is undone by activating version 2,
not by a registry edit that passes the check.

## 11. Protocol wiring and what remains before activation

Version 2 is a dormant `pending` row. The ten host behaviors its protocol makes
mandatory are implemented and tested (11.1), the SDK half of one of them is a
recovery patch that does not exist yet (11.2), and the rest of what holds the
row back is outside this repository (11.4). The runbook that orders the work is
[Activate a new version](#activate-a-new-version).

### 11.1 Protocol wiring (`requiredWiring`)

The `concession-v1` adapter lists the host behaviors the successor SDK makes
mandatory (the upstream SDK README's exit-only service message, credited
payouts, payout alert, `device_not_newest`, near-expiry and settlement waits and
the other-deployment records, plus the exit kit and the withdrawal recheck this
host requires). The validator (code `gate_wiring`) refuses a live row of that
family until every name is in
[WIRED](../chat/zkapi/versioning/wiring.mjs) (frozen, so no other module can
mark a protocol wired) **and** `gate.protocolWiring` is `done`. All ten are
listed. `WIRED` is a declaration, and the validator cannot verify behavior, so
[zkapi-wiring.test.mjs](../test/zkapi/zkapi-wiring.test.mjs) holds the
evidence table and fails when:

- `WIRED` is not exactly the union of every adapter's `requiredWiring` (a new
  required name makes it fail until the behavior and the list follow in one
  reviewed diff), or can be changed at run time;
- a wired name has no runnable test whose title starts `wiring:<name>`, in a
  file that imports a named production symbol that exists (titles and imports
  are read with a real parser, so a rename or a removed import fails here), or
  its only evidence is a test that skips without a real successor SDK;
- a test names a behavior that is not wired (a typo is not silent evidence);
- a behavior with a half in the SDK is not bound to the real-SDK test of that
  half;
- an adapter supplies a `beforeWithdraw` seam (the recheck is the host's own).

| Name | What the host does | Where | Tests (`wiring:<name>`) |
| --- | --- | --- | --- |
| `service-message` | While the service is unavailable, plain words by code, "Check again", exits fully enabled. The SDK's message and detail (jargon, operator URL) are never printed. The deposit gate is not closed for a pause ([7.6](#76-exit-state-notices)) | [exitRefusal.mjs](../chat/zkapi/versioning/exitRefusal.mjs) `readServiceRefusal`; `versionState.mjs`; `copy.mjs`; `VersionNotices.js`; facade `recheckService`; `zkapiErrorCopy.mjs` | `zkapi-exit-refusal`, `zkapi-version-state-protocol`, `zkapi-protocol-notices`, `zkapi-facade-protocol` |
| `credited-payouts` | A closed escape whose payout the vault only credited is "Payout held", never "returned" or "sent". The Payment history row offers `claimEscapePayout(recordId)` with the amount (or "amount not shown" for `vault_credit` evidence), the destination, a transaction link and a pending outcome. Needs no operator and no service check; the sender pays the fee. The right panel says "N to claim" | [RecordExtras.js](../chat/zkapi/components/RecordExtras.js); `AccountModal.claimPayout`; the signer's `payout-claim` kind; `RightPanel.js` | `zkapi-record-extras`, `address-funding-escape-concession`, `zkapi-protocol-notices`, `zkapi-facade-protocol`; real SDK in `zkapi-v2-real-sdk-rehearsal` |
| `payout-alert` | `payoutAlert: "concession_exceeded_bound"` is a standing note and badge on the record and a dismissible notice, not a toast. The row says "paid out", not "all back" | `RecordExtras.js`; notice `payout` | `zkapi-record-extras`, `zkapi-protocol-notices`, `zkapi-facade-protocol` |
| `device-not-newest` | A balance another device used is explained and not offered for a withdrawal that would be rejected (no Withdraw, no upgrade nudge for that note). No in-app restore is promised: only the companion tool opens a kit | `versionState.mjs`; `RecordExtras.js` (`hideActions`); notice `device` | `zkapi-version-state-protocol`, `zkapi-record-extras`, `zkapi-protocol-notices`, `zkapi-facade-protocol` |
| `near-expiry` | New chats pause with a persistent notice and Withdraw; set-aside notes get their own notice bound to Payment history; never mentions upgrading | facade `sendGate`; `VersionNotices.js` (`near`, `setaside`); `exitRefusal.mjs` (`note_near_expiry`) | `zkapi-version-state-protocol`, `zkapi-protocol-notices`, `zkapi-facade-protocol` |
| `ownership-proof-wait` (with `request_settlement_pending`, `exit_release_pending`, `exit_locked`) | A refusal says when the withdrawal can be retried and what the choice costs; Withdraw and the emergency exit stay available. The settlement choice, the disclosed bound and the signer's cap ([7.7](#77-a-settling-chat-and-the-emergency-exit)) | `exitRefusal.mjs`; `ExitChoice.js`; `AccountModal.submitWithdrawal`; `addressFundingProvider.mjs` | `zkapi-exit-refusal`, `address-funding-escape-concession`, `zkapi-protocol-notices`, `zkapi-facade-protocol`, `zkapi-version-ui-render`, `zkapi-balance-extras-exit-choice`; open item below |
| `exit-kit` | Export after a deposit (never-created and created-but-unsaved notices), a quiet status row, a generated passphrase, a two-step dialog ([7.8](#78-the-exit-kit)) | [ExitKitDialog.js](../chat/zkapi/components/ExitKitDialog.js); `exitKit.mjs`; `BalanceExtras.js`; facade `exportExitKit` | `zkapi-exit-kit-dialog`, `zkapi-protocol-notices`, `zkapi-facade-protocol`; real SDK in the rehearsal |
| `withdrawal-operation-recheck` | The displayed balance and prepared withdrawal are re-verified under the wallet lock after settlement and the wallet connection, right before the SDK takes over; the signer binds the operation. **The SDK half is the recovery patch** ([11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)) | [withdrawalRecovery.mjs](../chat/zkapi/services/withdrawalRecovery.mjs); `AccountModal.submitWithdrawal`; the signer | `withdrawal-recovery`, `zkapi-version-ui-render`, `zkapi-facade-protocol`; SDK half in the rehearsal |
| `other-deployment-withdrawals` | Another deployment's unfinished withdrawal is unioned into the deposit gate (`previous_withdrawal_open`) and offers "Open version P". An operator `stuck_escape` notice that relaxed the gate also shows its reference number | `concessionV1.mjs`; `versionState.mjs`; `VersionNotices.js` (`previous`, operator notices with `operator.reference`) | `zkapi-concession-real-shapes`, `zkapi-protocol-notices`, `zkapi-facade-protocol` |
| `other-deployment-credits` | Another deployment's credits never block deposits and keep their amount (the SDK writes it as a JS number); the page of the version that holds them offers the claim. A credit of an exit-only version can arrive only through `config.other_deployment_credits` | `concessionV1.mjs`; `versionState.mjs` (phase `claim-previous-credit`); `VersionNotices.js` (`credit`, `claim`) | `zkapi-concession-real-shapes`, `zkapi-other-deployment-credits` |

The one **open item** of `ownership-proof-wait` is pinned by a test, not by a
gate, and the list above does not hide it. The dialog's own withdrawal form
discloses the bound and carries it to the signer, but the call sites that only
continue an earlier withdrawal (retrying an unknown or dropped one, replacing a
background one, withdrawing a set-aside balance) name none, so the signer
refuses a conceding escape there and the person starts again. That fails
closed. The test is titled `wiring:ownership-proof-wait the dialog's
continuing withdrawal call sites without a bound are exactly the documented set
(closing the gap is a product decision)`. It passes while the call sites of
`AccountModal.js` that name no bound are exactly four (the activity titles
`Retrying withdrawal`, `Replacing pending withdrawal`, `Replacing background
withdrawal` and `Withdrawing set-aside balance`), and fails when one is added
or when the gap is closed, so the documentation is changed in the same diff.
It is not a gate: the validator, the registry CLI check and the build do not
look at it, and `WIRED` lists the name. What a person does at those sites is in
[11.5](#115-known-limits-and-support-runbooks). Closing it needs a product
decision on which bound applies to a balance the form is not showing.

**Errors the SDK reports for these behaviors.** A deposit can fail with
`deployment_mismatch` or `deployment_unverifiable` (the pins do not match the
chain, or are missing) and, during a launch canary, `canary_cap_exceeded` or
`canary_cap_unverified` ([Mainnet canary](#sequencing-and-coordination)). A
credit claim whose destination still rejects ETH fails with
`native_transfer_failed` before the wallet is asked to sign (the claim also
reports `zero_amount` and, from the browser funding address,
`address_insufficient_eth`). Each carries a `shortMessage` that the app shows as
the SDK wrote it (`zkapiErrorMessage`); the host has no copy of its own for the
canary and deployment-pin codes, so each belongs in the rehearsal.

The seams that exist: the adapter's `requiredWiring`, `WIRED`, the validator
gate, the facade members of [5.9](#59-the-runtime-facade), `versionUi.protocolNotices()`
(host markup placed inside the banner block; `createVersionUi({protocolNotices})`;
it returns `''` and none of the ten behaviors uses it) and the adapter's
normalization of `config.service`, `config.other_deployment_*`, `config.exit`,
`config.unresolved_requests` and `config.deposits`.

### 11.2 The withdrawal recheck and the recovery patch

`wallet-recovery-v1` fixes deposit and withdrawal recovery defects of `3342c95`
(see [ZKAPI_RECOVERY_REVIEW.md](ZKAPI_RECOVERY_REVIEW.md)). It cannot apply to
`82c8504`: every file hash differs. Compared replacement by replacement, 9 of
its 25 `before` texts still occur exactly once in the `0.2.0` sources and 16
occur nowhere:

- the 9 that still match are the five deposit-side hunks of
  `browserWalletRuntime.js`, two of its withdrawal-side hunks (the guard on
  canceling a prepared withdrawal and the expected-record check of
  `claimPreparedWithdrawalSubmission`) and the two deposit-side hunks of
  `zkapiClient.js`;
- the 16 that do not are all withdrawal-side: ten in `browserWalletRuntime.js`
  (the expected-note and expected-operation checks, `validateExisting` and the
  recovery journal of `prepareWithdrawal`) and six in `zkapiClient.js`
  (`withdraw`, `performWithdrawal` and the call to claim the prepared
  withdrawal).

A text that still matches is not a verdict: whether the defect remains is the
review's question. Port or review an equivalent for the new revision and record
it in `gate.recoveryReview`; the validator checks that the review covers exactly
`sdk.revision` and, for `patched`, that the named patch is in `sdk.patches`.

**What `0.2.0` does.** `withdraw()` drops `expectedWithdrawalOperationId`
silently, and `prepareWithdrawal` has no expected-note or expected-operation
input. After any host check the SDK still runs `assertBalanceNotClaimed` (an
RPC read), `connectWallet()` (which can show an account or network prompt in
MetaMask), for an escape `checkEscapeDestination` (an RPC read), and only then
does `prepareWithdrawal` take its own lock. So the window in which a prepared
withdrawal can be replaced after it was displayed is the SDK's network latency
plus any wallet prompt, not milliseconds. The old patch's repository tests name
this window (`withdrawal-recovery.test.mjs`), and only the patched legacy SDK
closes it.

**Host half** (on only where `facade.operationRecheckRequired()`, so nothing
changes for version 1 or a dormant build). In `AccountModal.submitWithdrawal`,
in this order:

1. the existing strict check of a chosen escape intent (the unsubmitted-mutual
   identity, unchanged, before settlement);
2. `settlePrivateAccess`;
3. the existing client note-id guard;
4. `zkapiClient.connectWallet()`: it resolves the account and network prompts
   first (idempotent; the SDK asks again and is answered at once);
5. `assertWithdrawalEscapeAvailable({kind: 'note', noteId, operationId})`;
6. the last look at the settlement time and the disclosed figure
   ([7.7](#77-a-settling-chat-and-the-emergency-exit));
7. the SDK's `withdraw()`.

Step 5 awaits `runtime.init()` BEFORE the lock (it takes the lock itself and
Web Locks are not re-entrant), calls `runtime.preemptForExit({requests: true})`
where the runtime has it (the `0.2.0` runtime does, the legacy one does not; so
this tab's startup recovery and any key still being issued do not queue ahead of
the exit), then under `withBrowserWalletLock` and a fresh `reload()` requires
that the slot's note, the client's note and the chosen note are one note and,
when an operation is named, that the slot's prepared withdrawal (any mode and
phase) is that operation. The strict branch keeps its own identity rule and the
function gained no export name (the vm-source import pin is unchanged). The
Send Ethereum signer additionally requires `authorization.operationId` to equal
the recovery context's operation.

**SDK half** (an activation change, not authored here: the snapshot carries no
40-digit revision and its bytes are unpublished and may still move, which a
hash-pinned patch would refuse). The hunks of a `wallet-recovery-v2c` patch:
`prepareWithdrawal` options `expectedNoteId` and `expectedWithdrawalOperationId`,
compared inside the SDK's lock in `prepareExitLocked` before
`validateExistingWithdrawal`; `claimPreparedWithdrawalSubmission(expected)`
comparing `{operationId, noteId, destination}` and `mode` AFTER the
mutual-to-escape conversion (`mode = plan.mode`); and the client's
`withdraw`/`performWithdrawal` passing through the note the person saw. It is
registered in `SDK_PATCHES`, listed in the row's `sdk.patches`, has a line in
`.vercelignore` and a verdict `patched` in `gate.recoveryReview`.

**How the name is bound.** Listing it in `WIRED` proves the host half. The SDK
half is bound three ways, none of which a person has to remember:

- `PATCH_COVERAGE` and `SDK_HALF_WIRING` ([4.5](#45-patches-per-version)): the
  registry CLI check and `planFromRegistry` refuse a live row whose
  `sdk.patches` names no patch covering it for the row's own revision
  (`recovery_patch_coverage`);
- `zkapi-v2-real-sdk-rehearsal.test.mjs`
  (`wiring:withdrawal-operation-recheck the SDK refuses to prepare or claim a
  withdrawal replaced after it was displayed`) replaces the prepared plan between
  display and `withdraw()` against the real SDK and asserts a throw. Against the
  unpatched `0.2.0` snapshot it **fails**, which is what it is for;
- `zkapi-wiring.test.mjs` requires that test to exist and to be skipped without
  a real SDK (activation evidence), so a green ordinary run never claims it.

A `not_required` verdict is recorded only after that test passes against the
revision without any patch of ours, and the row still lists a registered patch
entry with no files that covers the name.

**Residual window.** With the SDK half in place the SDK compares inside its own
lock and no window remains for the note or the operation. Without it, what is
left after the host check is the SDK's own network latency and any wallet
prompt it still raises; the host cannot close it, which is why a row cannot go
live without the patch.

### 11.3 Wallet-slot drift check

The probe's field classification must cover every field the new store writes in
the runtime slot, or an empty slot carrying an unclassified field would read as
"holding something" and pin the user to that version (and a discard would refuse
it). `knownSlotKeys()` in walletHoldings.mjs lists the classified keys, and the
"drift guard" tests in
[zkapi-wallet-holdings.test.mjs](../test/zkapi/zkapi-wallet-holdings.test.mjs)
compare them with the store of every SDK alias installed under `node_modules`
(so installing the new alias brings its real store under the guard) and with a
pinned copy of the upstream snapshot's runtime keys, `UPSTREAM_V2C_SLOT_KEYS`.
Run them at every activation, and refresh `UPSTREAM_V2C_SLOT_KEYS` from the new
SDK's `sdk/test/fixtures/v2c-store-snapshot.json` whenever the pin moves.

### 11.4 What still keeps version 2 pending

Each of these refuses the row on its own today, and none is in this
repository's power:

1. **A published SDK revision.** The reference revision, `4b955d9` (branch
   `v0.2` of the local zkapi repository), is not on GitHub, and a git
   dependency whose commit cannot be fetched fails `npm install` for everyone,
   so `sdk.source`, `sdk.revision` and `sdk.storeSha256` stay `null` and
   `package.json` and the lockfile name nothing until the branch is pushed. Its
   wallet store hashes to
   `f42a9ff0f793ce6c509797f02afb6d268f496162f76b168919ef2cd092038cce`
   (`store-hash` prints it once the package is installed); re-check it against
   the commit that is actually pinned.
2. **A deployed profile for the chosen proof setup.** The package ships a
   `dev` proof bundle and `not_deployed` placeholder profiles for both
   networks (with a `gasless: null` field since `4b955d9`), and the SDK's own
   build refuses a placeholder. The host accepts `dev` and `mpc-1` on both
   networks ([3](#3-registry)), and since `4b955d9` the SDK's build refuses
   `dev` for neither, so the setup waits on upstream for neither network:
   activation needs a revision whose package profile for that network is
   deployed and pins the bundle's setup. For mainnet on `dev` the vault
   deployment script, the operator images and the companion build take
   `ALLOW_DEV_SETUP=1`
   ([the limitation](#single-party-development-proof-setup-known-limitation)).
   For `mpc-1` the ceremony has not produced keys, so there is no such bundle
   yet. A real-SDK build still has to supply a deployed profile and a covering
   patch in a scratch copy ([11.6](#116-the-reference-revision-82c8504-to-4b955d9)).
3. **The recovery patch with coverage** for that revision
   ([11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)) and its
   rehearsal passing.
4. **The operator's finalized manifest hash** (`gate.manifestSha256`) and the
   operator's schedule: day 0, admission closing and the sweep policy
   ([Sequencing and coordination](#sequencing-and-coordination)).
5. **The open item of `ownership-proof-wait`** ([11.1](#111-protocol-wiring-requiredwiring)),
   which should be closed or consciously accepted: it fails closed. It is the
   only item here that no check enforces (a test pins it, nothing refuses the
   row), so an activation change records it explicitly.
6. **A recovery review of the successor's give-up** if its holders are to get
   the action ([5.5](#giving-up-a-balance-a-user-gesture)): it is off for the
   family until then.

Activation cannot be published against the real SDK today: `4b955d9` (SDK
`0.2.0`), the legacy re-cut that honors the deposits flag and `zkapi-clientd`
`0.1.7` were not on GitHub when this was written. The host's registry check and
build have been rehearsed against a real `4b955d9` package in a scratch copy
([11.6](#116-the-reference-revision-82c8504-to-4b955d9)); what stands in for the
rest: the [fixture SDK](../test/fixtures/zkapi-sdk-v2-fixture/README.md)
(same layout, export names and build contract) for build tests, and the
[real-shape fixtures](../test/fixtures/zkapi-v2-real-shapes/README.md) (data
produced by the real `0.2.0` modules over a frozen clock: thirteen whole
snapshots and the SDK's own error objects, oracle vectors for the expiry and
price functions, and a wallet database dump written by the real store) for the
host's normalizers, state, notices and history. Protocol behavior beyond what
the rehearsal drives is verified only at activation.

### 11.4a Activation record: version 2 on Sepolia

Version 2 is `active` on Sepolia and version 1 `exit-only` there; mainnet is
unchanged (version 1 `active`, version 2 `pending`).

- **SDK pin.** `zkapi-sdk-v2c` is the commit `67e505c` of the zkapi repository:
  `4b955d9` plus the deployed Sepolia profile (setup `dev`), the re-synced asset
  manifest and the SDK half of the withdrawal recheck (`prepareWithdrawal` takes
  `expectedNoteId` and `expectedWithdrawalOperationId` and compares them inside
  the wallet lock; `claimPreparedWithdrawalSubmission` compares the plan it is
  about to claim). The recovery patch `wallet-recovery-v2c` therefore rewrites no
  file: it binds the name to that revision and `PATCH_COVERAGE` covers
  `withdrawal-operation-recheck` for it. The review verdict is `not_required`,
  and the real-SDK rehearsal test passes unpatched.
- **Hostname.** The deployment shares the hostname of version 1 under the plain
  prefix `/v0.2` ([One hostname for several deployments](#one-hostname-for-several-deployments)).
- **Proof setup.** `dev`, by the owner's decision; the build warns once per
  build and `check` repeats it. A vault on these keys is never switched to
  `mpc-1` (that is a new vault and a user migration).
- **Sponsored withdrawals are off.** The reviewed profile pins `gasless: null`:
  the operator's bundler release gates have not run, so no bundler route is
  generated and the "paid from this withdrawal" choice is never drawn.
- **Open items.** The `ownership-proof-wait` residue of
  [11.1](#111-protocol-wiring-requiredwiring) and the dialogs' continuing-call
  sites named in [11.5](#115-known-limits-and-support-runbooks) are accepted
  as they were documented, not closed by this change.

### 11.5 Known limits and support runbooks

- **Set-aside and continuing paths name no cap.** Retrying an unknown or dropped
  withdrawal, replacing a background one and withdrawing a set-aside record
  pass no concession cap, so a mutual close the SDK converts to an escape that
  concedes, or a conceding escape the signer has not itself accepted, is
  refused there (code 4100, nothing sent; Send Ethereum only, and only where
  the family has a concession word, so MetaMask and every version 1 balance
  are unaffected). It fails closed. The recovery is to start the withdrawal
  again from the Withdraw form, which discloses the bound and passes it. For a
  balance that is set aside that form is reached through "Use this balance",
  which is disabled while another balance or a started deposit holds the
  wallet; the person first withdraws or finishes that one (giving it up is not
  an option while a set-aside record exists). So the way out is not always one
  click away, and while the wallet slot stays occupied the refused action
  stays refused. This is the open item of 11.1: pinned by a test of the exact
  call sites, not by a gate.
- **A prepared emergency exit continued after a reload** has no cap once the
  state's bound has dropped to 0 and nothing is shown; the signer refuses a plan
  that concedes more. Recovery: cancel the plan and start again.
- **Confirmation is not persisted.** There is no key to hold it; after a reload
  an unsigned conceding escape needs its bound named again.
- **A payout of a version the app cannot open has no in-app claim.** A credited
  payout of a retired or unknown deployment, or of one this build cannot load
  (a new signer scope would be needed), is shown as text. Support runbook: the
  vault's `claimEscapePayout(destination)` call (selector `88c10aee`, one
  address word) may be sent to that vault by any account; the vault pays the
  credited destination and the sender pays the fee.
- **A give-up has no in-app undo.** Support restores it under the wallet lock
  ([ZKAPI_RECOVERY_REVIEW.md](ZKAPI_RECOVERY_REVIEW.md#confirmed-give-up-of-a-zero-or-dust-balance-2026-10-13)).
- **A balance another device used** cannot be restored here; the person uses
  their newest exit kit with the companion tool. The holdings-based "finish it
  in version N" banner has no notion of the device flag, so it can still read
  that way for a flagged record; the history row and the record's own row are
  honest. A flagged row loses its own buttons, including "Check status".
- **Exit kit.** The app cannot verify that a saved file decrypts and cannot
  open one. A reload forgets that a kit was created and not saved. A zero
  balance on an active version is still asked for a kit (dismissible). The
  alphabet of a generated passphrase is fixed at 32 symbols, so a few letters
  and digits (S and 5, Z and 2, B and 8) can still be misread by hand.
- **Service latch.** A refusal that said the service is paused is believed for
  up to 5 minutes unless "Check again" succeeds.
- **History.** Foreign dollar figures use the loaded SDK's current price;
  deposit back-fill is not ported; the deadline crossing is drawn by the
  dialog's own clock tick.
- A set-aside record's concession and a conversion the SDK performs are shown
  only as far as the SDK reports them.

### 11.6 The reference revision: 82c8504 to 4b955d9

The first implementation of version 2 was written against the `82c8504`
snapshot (`security-fixes-concession-exit`, delivered as an archive). The
reference is now `4b955d9`, the head of the `v0.2` branch of the local zkapi
repository (fourteen commits later, 2026-10-14, not published). The package
version is still `0.2.0`, the circuit is still `zkapi-v2-concession-v1`, the
vault revision is still 3, and the proof bundle is byte for byte the same
(the same `dev` setup, the same WebAssembly and key hashes; only the two
network profiles differ, by the new `gasless: null` field).

**Reading it without switching a checkout.** The tests and the maintenance
scripts only read plain modules from an unpacked copy, and `git archive` reads
the branch from the object store without touching the working tree of a
checkout that may be on another branch:

```sh
mkdir -p "$TMPDIR/zkapi-v0.2"
git -C <zkapi checkout> archive v0.2 | tar -x -C "$TMPDIR/zkapi-v0.2"
ZKAPI_V2_SDK_DIR="$TMPDIR/zkapi-v0.2" node scripts/run-unit-tests.mjs
```

**What changed in the package and what the host did about it.**

| Change at `4b955d9` | Effect on this host | Handled in |
| --- | --- | --- |
| A single-party (`dev`) bundle builds for chain 1: `sdk/build.mjs` no longer throws `development_setup_on_mainnet`. Upstream's deploy script, operator images and companion build take `ALLOW_DEV_SETUP=1` instead of refusing ([the limitation](#single-party-development-proof-setup-known-limitation)) | Mainnet on `dev` builds through the host's pipeline. The host's handling of the old refusal stays, for a pin of an older revision | the words of `sdkRefusalError`, the fixture's `build.mjs`, `zkapiVersionedBuild.test.js` (the old clause is re-inserted by a variant) |
| Two new deposit-named runtime methods: `confirmedDepositFor` (a read of the active note's confirmed record) and `completeConfirmedDeposit` (finishes a confirmation that the background reconcile already committed) | They finish a deposit that was already sent, so they are recovery names. Left unclassified, deny by default would have wrapped them, and a closed version would have refused the second path of `confirmDeposit` | `recoveryEntryPoints.runtime` of the concession adapter; `zkapi-deposit-guard-successor.test.mjs` |
| Gasless withdrawals over ERC-4337: a `./gasless` subpath, `fees: 'payout'` on `withdraw` and `finalizeEscape`, a `gasless` object in the profile, `sweepTransit`, `claimGaslessCredit`, and new journal fields | The host offers it, dormant until a deployed profile pins a paymaster: a fee choice, a signer that judges each operation, a same-origin relay route and the recovery rows ([11.7](#117-sponsored-withdrawals-the-network-fee-paid-from-the-withdrawal)) | the fixture's surface and the real-shape fixtures, and the four sponsored test files of [13](#13-test-map) |
| A deposit that the background reconcile already confirmed no longer fails the foreground `deposit()` (`confirmBrowserDepositReceipt` is idempotent for the same note, amount, secret and operation id) | None. It removes a race the host could only report | none needed |
| The wallet store: the database name and version, the object stores, the lock and the channel are unchanged. It gained exports (`GASLESS_WITHDRAWAL_FIELDS`, `isGaslessWithdrawal`, `gaslessRecordFields`, `FINALIZATION_CLAIM_LIVE_MESSAGE`) and two deleted fields on a detached record | The `storeSha256` to pin is `f42a9ff0…` (it was `b41f50b7…` at `82c8504`); always re-run `store-hash` on the commit that is pinned. The slot's top-level keys are the same: `UPSTREAM_V2C_SLOT_KEYS` equals `sdk/test/fixtures/v2c-store-snapshot.json`, which is byte-identical at both revisions | the drift guards of [11.3](#113-wallet-slot-drift-check), passing against the real store |
| Snapshot and record shapes are additive: a `gasless` object on every snapshot (`supported: false` while the profile pins none) and `fee_payer`, `payout`, `transit`, `user_op_hash`, `user_op_phase` on a withdrawal record (`fee_payer: "wallet"` and nulls for a wallet-paid exit) | The normalizers read named fields, so the new keys are ignored | `test/fixtures/zkapi-v2-real-shapes/` regenerated; `zkapi-snapshot-adapters` and `zkapi-other-version-history` pass on it |
| The withdrawal recheck: unchanged. `prepareWithdrawal` still has no expected-note or expected-operation input | The SDK half of `withdrawal-operation-recheck` is still missing, so the row's activation gate holds ([11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)). The same 9 of 25 hunks of `wallet-recovery-v1` still match once, the same 16 match nowhere | the rehearsal's first test fails by design |

**Evidence recorded on 2026-10-14.**

- With the package unpacked at `ZKAPI_V2_SDK_DIR` or installed under
  `node_modules/zkapi-sdk-v2c`: the real-SDK tests all pass except
  `wiring:withdrawal-operation-recheck the SDK refuses to prepare or claim a
  withdrawal replaced after it was displayed`. Whole suite with the package
  unpacked at `ZKAPI_V2_SDK_DIR` (after the sponsored withdrawals of
  [11.7](#117-sponsored-withdrawals-the-network-fee-paid-from-the-withdrawal)
  were added): 1163 of 1163 core tests, and 2440 of 2443 payment tests (the
  expected failure and two skips that need Anvil). Without a successor SDK:
  2373 pass, none fail and 18 skip.
- `verify-exports.mjs <package root>`: 26 name lists match the real package,
  name by name. The fixture gained the `./gasless` subpath (91 names, primitive
  constants real, the rest throwing), the new store, wallet and contract-error
  exports, 60 client members, 21 runtime members and two client getters.
- `regenerate.mjs <package root> --check` was run first and listed exactly the
  additive differences above before the fixtures were adopted.
- **A real build in a scratch copy.** The tree without `.git`, `node_modules` as
  links to the real one except the alias directory (a real copy of the
  package's `package.json` and `sdk/`). In the copy only: both package profiles
  made deployed-looking (`deployment_status: "deployed"`, synthetic addresses,
  the real key hashes, the canary on mainnet) and `assets/manifest.json`
  re-hashed as `sync-sdk-assets.mjs` does; the registry with version 2 `active`
  on both networks (that profile as the inline `config`, `sdk.revision` and
  `source` naming `4b955d9`, the store hash above, an empty covering patch bound
  to that revision registered in `SDK_PATCHES` and `PATCH_COVERAGE`, a lock entry
  resolving to the commit) and version 1 `exit-only`. Results:
  - `zkapi-registry-cli.mjs check` passes: two setup warnings (mainnet and
    Sepolia on `dev`) and no refusal line, which an `82c8504` package adds on
    mainnet.
  - `scripts/build.mjs` succeeds for both networks:
    `Built zkAPI versions: v1 (exit-only), v2 (active); deposits go to v2`,
    one `[build] WARNING` for version 2, and in `build.json` version 2 has
    `setupId: "dev"` and `proofSetup: "development"`. The emitted
    `dist/zkapi/v2c/browser-config.json` of the mainnet build has `chain_id` 1,
    `setup_id` `dev`, `vault_revision` 3 and `exit_concession` 1.
  - `generate-zkapi-vercel-config.mjs` emits the rewrites
    `/zkapi-deployment/:path*` then `/zkapi-deployment-v2c/:path*`.
  - With a `gasless` object in the reviewed profile the registry check and the
    build still pass and the object reaches the shipped `browser-config.json`
    unchanged. The generator adds one rewrite for its bundler, the exact path
    `/zkapi-deployment-v2c/_bundler` to the pinned `bundler_url`, listed before
    the version's own `:path*` rewrite (and no origin: the route is
    same-origin). With a profile that is `gasless: null` it adds nothing.

  That rehearsal proves the host's pipeline and the SDK package's own build
  against a package that is really `4b955d9`. It proves nothing about a live
  deployment, the operator's stack or the SDK half of the recheck, and its
  profile, patch and lock entry are synthetic and were never committed.

#### Gasless withdrawals

At `4b955d9` the SDK can pay a withdrawal's network fee out of the withdrawal
(`fees: 'payout'`, an ERC-4337 path, a `gasless` object in the profile). It is
opt-in per call; the SDK's default is `fees: 'wallet'`, and a profile that pins
none reports `gasless.supported: false` and refuses a sponsored call before any
prompt. This host first left it unused and has since built it: the privacy
decision, the signer's judgment of an operation, the interface, the network
route and the recovery review are in
[11.7](#117-sponsored-withdrawals-the-network-fee-paid-from-the-withdrawal).
Nothing changes for a person until an operator pins a deployed profile with a
paymaster.

**Still open, unchanged by this move.** A published revision (push the branch,
then pin `source`, `revision` and `storeSha256` and add the dependency and its
lock entry); a deployed profile for each network; the SDK half of the recheck
as a patch bound to the commit that is actually published (writing one against
a branch that is still moving is wasted work); the recovery review of the
successor redone against that commit; the operator's finalized manifest hash.


### 11.7 Sponsored withdrawals (the network fee paid from the withdrawal)

*Added 2026-10-14. Implemented and tested against the real `4b955d9` package;
dormant in every shipped build, because no reviewed profile pins a `gasless`
object yet.*

**What the person sees.** In the withdrawal form, under "Network fee", a choice
between "Paid by your wallet" (what every withdrawal always did, and the
default) and "Paid from this withdrawal". Choosing the second is the click that
asks the relay service for a quote; the form then says what the person will
receive at least (a close) or about what they would receive (an emergency exit,
whose fee is charged when it finishes), what the fee is at most, and that the
withdrawal goes through this app to the service's relay. No ETH is needed. If
the quote is unavailable the line says why in plain words and the wallet choice
stays. The protocol's own names (paymaster, bundler, user operation, transit
account) are never shown; the words are "network fee", "relay service",
"receiving address" and "holding address".

**What happens underneath.** The SDK's `fees: 'payout'` path. The vault exit
runs inside an ERC-4337 user operation (EntryPoint v0.7) sent from a transit
account S that is `CREATE2(factory, creationCode ‖ abi(entryPoint, vault,
paymaster, owner, payee))`; the proof's destination is S, the owner is the
connected account (the MetaMask account, or the browser-held Send Ethereum
address), the payee is the receiving address. The owner signs the 32-byte
operation hash with `personal_sign`; the paymaster pays the network gas and
takes the measured charge plus a flat fee (capped by 12 bytes of
`paymasterData`) out of the payout; the rest is forwarded to the payee.
Operation kinds: close, escape (start), finalize (after the safety wait) and
forward (collect what is left in S).

#### When it is offered

`createSponsoredFees(...).supported()` ([sponsoredFees.mjs](../chat/zkapi/versioning/sponsoredFees.mjs))
is true only when all of these hold, and the dialog draws nothing otherwise:

1. The loaded adapter's `callProfile` has a `sponsored` key
   (`concession-v1` only; `note-bound-v1` has none).
2. The loaded client has `gaslessWithdrawalQuote`.
3. The reviewed profile pins the gasless contracts completely
   (`profilePinsSponsored`: EntryPoint, sender creator, paymaster, factory and
   their codehashes, the creation code and its keccak256, a credential-free
   HTTPS `bundler_url`, `policy`, `fee_ceilings`, `gas_policy`). A `gasless`
   object that is pinned and incomplete is a profile error found at the
   registry check and the build (`sponsoredProfileProblem`), not at run time.
   `gasless: null`, absent or `deployment_status: "not_deployed"` offers
   nothing.
4. The page has an origin to route through (`bundlerRouteUrl`).

Today the `0.2.0` package's profiles pin `gasless: null`, so the form is
byte-for-byte the form it was. Nothing changes for a person until an operator
publishes a deployed profile with a paymaster, and activation of version 2 is
still the gate before that.

#### The privacy decision

The bundler is a third party the person did not choose. What was decided:

- **The page never contacts it directly.** It is reached only through a route
  of the app's own host, `<proxyPath>_bundler` (for version 2,
  `/zkapi-deployment-v2c/_bundler`), which the generated Vercel configuration
  forwards to the `bundler_url` the reviewed profile pins. The route is an
  exact-path rewrite listed *before* the version's own `:path*` rewrite
  (`zkapiProxyRewrites` in `scripts/generate-zkapi-vercel-config.mjs`), which
  would otherwise carry it to the operator's service. No new origin and no
  content-security entry are needed, and the SDK's `setBundlerUrl` (a
  person-chosen bundler) is not exposed: it would route a request around the
  app's proxy.
- **It is contacted only on an explicit choice.** Opening the form sends
  nothing. Choosing "Paid from this withdrawal" asks for the quote (and, with
  MetaMask, prompts to connect: the account that signs must own the holding
  address); starting the withdrawal sends the operation. Switching the way the
  balance leaves (close or emergency exit) while the choice is on asks again,
  because a quote is only valid for one balance, mode and receiving address
  (`sponsoredKeyFor`).
- **What each party learns.** The app's host: the person's IP and the time of
  requests to the route, as for the operator's proxy path. The operator's
  relay: the operation (the note's proof, the holding address, the owner, the
  receiving address, the fee fields and the timing) before the network sees
  it. The chain: the same as a wallet-paid withdrawal, plus that the receiving
  address is the payee of a holding account whose owner is the signing
  account; that account is tied to the receiving address publicly, exactly as
  the sender of a wallet-paid exit transaction is. The form says the relay
  sees it ("To pay this way, the withdrawal goes through this app to the
  service's relay, which sees it and the receiving address before it reaches
  the network") and nothing about it is hidden behind the choice.
- **A contract receiving address** may refuse a plain ETH payment. The payout
  is then held for it as a credit at the paymaster and claimed from Payment
  history; the form says so when the quote reports that the address has code.

#### The signer: judging an operation the key signs blind

The Send Ethereum method's key signs without a prompt, and `personal_sign`
carries only a 32-byte hash, which cannot be judged when it is asked for. So
the provider ([addressFundingProvider.mjs](../chat/zkapi/services/addressFundingProvider.mjs))
signs the hash, and judges the operation at the one place the signature can
leave the browser, `eth_sendUserOperation`. A signature that is never sent is
inert. The provider adds:

- `personal_sign`: only inside a running authorized action whose
  authorization carries `sponsored`, only the 32 raw bytes of a hash, only for
  this address, at most 12 signatures per action (the first, the fee raises,
  a proof made again).
- `zkapiBundler`, a frozen transport the SDK uses in place of its own fetch
  (`request` and `sendUserOperation`). It forwards only eight JSON-RPC methods
  (`eth_chainId`, `eth_supportedEntryPoints`, `eth_estimateUserOperationGas`,
  `eth_sendUserOperation`, `eth_getUserOperationByHash`,
  `eth_getUserOperationReceipt` and the two fee-price helpers) to the
  same-origin route, with `credentials: 'omit'`, `redirect: 'error'`, no
  cache, a 20 s timeout, and returns only the bundler's numbers and text, never
  an object it controls. It exists only when the family has `sponsored`, the
  profile pins the contracts and the route is known.
- The gate. `judgeSponsoredOperation`
  ([sponsoredOperation.mjs](../chat/zkapi/services/sponsoredOperation.mjs), pure,
  no SDK import, every encoding computed again with ethers) must accept the
  operation against the running action, or `eth_sendUserOperation` is refused
  and nothing leaves. A send with no running action is refused as well: the
  SDK re-sends journaled operations from its background checks, and that is
  not something the person confirmed. Continuing the same withdrawal from the
  dialog is.

An operation is accepted only when all of these hold (each failure has its own
code in `SponsoredOperationError`):

| Check | Rule |
| --- | --- |
| Pins | The creation code hashes to its pinned keccak256 (`pins`); EntryPoint and paymaster are the pinned ones and the paymaster's data is exactly the 12-byte fee cap (`entry_point`, `paymaster`, `paymaster_data`) |
| Fee cap | At most the cap the person was shown (`authorization.sponsored.feeCapWei`), else the pinned flat fee (`fee_cap`) |
| Sender | Equals the transit account derived from the pinned factory and code, the pinned vault, paymaster and EntryPoint, **this** browser address as owner and the receiving address the person confirmed as payee (`sender`) |
| Init code | Empty, or exactly `factory.createAccount(owner, payee)` (`init_code`) |
| Call | `account.withdraw(bytes)` canonical encoding (`call`), whose inner bytes are, by kind: a close or escape vault exit whose chain, vault, kind, offsets, proof length and constant words are the profile's `exits`, whose destination word is the transit account, whose note is the confirmed one, whose mode is the confirmed one (a mutual-to-escape conversion only where the family has a concession word) and whose concession is within what was confirmed (`note`, `mode`, `concession`); a finalization of the confirmed note (`profile.finalize`); or, for a collection, nothing (optionally the `transitAccount` the record names) |
| Cost | The prefund (every gas limit times `maxFeePerGas`) is within the pinned policy and within `authorization.sponsored.maxCostWei`; both fee fields are within the pinned ceilings (`max_cost`, `fee_ceiling`) |
| Signature | Recovers, over the EIP-191 digest of the hash computed here, to this browser address (`signature`) |

`maxCostWei` is the quote's reservation with 50% headroom (fees move between a
quote and a send); the SDK is also handed `feeCapWei` and `allowExpensiveGas:
false`, so it refuses above the shown figures itself. The authorization is made
by `runAddressAction` ([addressFunding.js](../chat/zkapi/services/addressFunding.js)):
`withdrawal` kinds carry `destination` = the receiving address, `mode`, and
`sponsored`; `finalization` carries the same for a sponsored escape; and a new
authorization kind, `collection`, authorizes a forward of what a transit
account holds (the record must name its transit account and its payee).

**The MetaMask method.** The connected wallet exposes no `zkapiBundler`, so the
SDK uses its own transport against the app's route (`bundlerUrl` is the route,
never the operator's URL), and the wallet shows a signature request for an
opaque 32-byte hash, as upstream does. The host cannot verify what is signed
before it is signed in this method; the guards are the wallet's own
confirmation and the SDK's recomputation against the pinned profile (the host
passes the shown fee cap and `allowExpensiveGas: false`). This asymmetry is
recorded, not hidden: the proposal below would close it for both.

**Upstream proposal (not implemented).** A host hook next to `personal_sign`
(for example `provider.zkapiOperation(operation)`) that hands the decoded
operation to a signer before the hash is signed would let a signer verify
before it signs, in both methods. The host would then no longer need to judge
at send time, only to answer the hook.

#### Interface and money words

| Piece | Where | Note |
| --- | --- | --- |
| The fee choice | [SponsoredFee.js](../chat/zkapi/components/SponsoredFee.js), reached as `ui.sponsoredFee(...)`; the dialog reads `input[name="zkapi-sponsored-fee"]`, `[data-zkapi-sponsored-retry]` | Not drawn for a guided upgrade, a running submission, the journey view, or a plan that is already bound to how its fee is paid (a prepared plan with `fee_payer: "payout"` continues that way, with the route and no new quote) |
| Quote, plan and refusal words | [sponsoredFees.mjs](../chat/zkapi/versioning/sponsoredFees.mjs) | `quote()` never rejects and returns a normalized object (decimal wei strings; nothing of the SDK's object); every refusal code of the SDK has a line in `SPONSORED_REASON_COPY`, ending in "You can pay the network fee from your wallet instead" unless that would be wrong (a withdrawal already started, a wrong account) |
| Start | `AccountModal.submitWithdrawal` | A choice of "from the withdrawal" without a quote for exactly this balance and mode is refused ("The network fee has to be checked for this withdrawal first") and the quote is requested again; the options are `{fees: 'payout', bundlerUrl, feeCapWei, allowExpensiveGas: false}`. The choice is spent by the attempt |
| Error words | [zkapiErrorCopy.mjs](../chat/zkapi/services/zkapiErrorCopy.mjs) `sponsoredRefusalMessage` | The signer's own sentences are recognized inside the SDK's "The bundler refused ..." wrapper and shown alone; the SDK's gasless error codes read through the same table |

#### Records, recovery and holdings

A sponsored withdrawal's record names `feePayer: 'payout'`, `payout` (the
person's address; the record's `destination` is the holding address the proof
is bound to), `transit` and the money fields `chargedWei`, `paidOutWei`,
`fundsWaitingInTransit`, `paymasterCredited`, `paymasterCreditedWei` and
`transitBalanceWei`. What the host does with them:

- **Payment history** ([RecordExtras.js](../chat/zkapi/components/RecordExtras.js)):
  a closed sponsored row says what the fee was and what was received; an
  unfinished escape says its fee is paid when it finishes; a payout that is
  *waiting* at the holding address shows "Collect payout" (the service pays for
  it: the SDK's `collectTransitBalance` through the route) and, for a
  MetaMask wallet, "Collect with my wallet" (`sweepTransit`, one transaction);
  a payout that the receiving address would not take is "Payout held" with
  "Claim payout" (`claimGaslessCredit`, one wallet transaction). An unfinished
  sponsored escape finishes with `finalizeEscape(recordId, report, {bundlerUrl})`
  and the app's route.
- **Holdings and the version that owns them**
  ([walletHoldings.mjs](../chat/zkapi/versioning/walletHoldings.mjs)): a
  closed sponsored record with `fundsWaitingInTransit` or `paymasterCredited`
  is a *credit* (money owed to the person that only that deployment's
  contracts can deliver), so it keeps its version loaded and is told about like
  a payout the vault holds. Its `destination` in the holdings is `payout`.
- **Other versions' history**
  ([otherVersionHistory.mjs](../chat/zkapi/versioning/otherVersionHistory.mjs)):
  the reader's allowlist gained `feePayer`, `payout`, `fundsWaitingInTransit`,
  `paymasterCredited`, `paymasterCreditedWei` and `transitBalanceWei`; a
  sponsored row's `destination` is read as `payout`, and a pending payout
  reads as credited with the amount the wei fields carry. The signed
  operation bodies and the transit identity are never read (the records stay in
  memory only, as before).
- **The exit kit and the give-up** are note-based and unaffected: neither
  reads a withdrawal record.
- `WIRED` is unchanged. Sponsored withdrawals are optional in the protocol,
  so no family `requiredWiring` demands them, and a new wiring name would
  hold version 2's row for something it does not require.

#### Known limits

- **Address method (Send Ethereum): no wallet-paid transit recovery.** The
  collection of a waiting payout is offered (the service pays: the signer
  has the `collection` authorization kind for it) but "Collect with my wallet"
  and "Claim payout" are not, because the signer has no authorization kind
  for a wallet-paid recovery of a holding account and the rows do not draw the
  buttons for this method. A held credit of an address-method withdrawal needs
  the MetaMask method to claim.
- **A forced emergency exit** (the person chose to leave before a chat
  settles) with the sponsored choice needs a fresh escape quote, since the
  quote is bound to the mode: the form asks again when the mode changes, and
  starting without one is refused.
- **The MetaMask method is not host-verified before signing** (above).
- **A saved sponsored operation is sent only when the person continues the
  withdrawal**: the signer refuses a re-send from a background check ("A saved
  sponsored operation is sent only when you continue the withdrawal"). The
  record stays in Payment history, and the withdrawal is continued from the
  dialog like any unfinished one.
- **The SDK half of `withdrawal-operation-recheck` is still missing**
  ([11.2](#112-the-withdrawal-recheck-and-the-recovery-patch)); the sponsored
  path does not change that gate, and version 2 stays `pending`.
- Nothing about a live deployment is proven: the paymaster, the factory and the
  relay of a real operator have not been exercised. The tests drive the SDK's
  own scripted chain and bundler.

#### What would change with a deployed profile

An operator's reviewed profile gains a complete `gasless` object. The registry
check validates it (`sponsoredProfileProblem`); the build copies it into the
shipped `browser-config.json` unchanged and the generated configuration gains
the bundler route; the form appears for that version; nothing else is edited.
A profile that changes `bundler_url` is a reviewed data change, because the
route's destination is the pinned URL and no other.

#### Tests

[sponsored-operation.test.mjs](../test/zkapi/sponsored-operation.test.mjs)
(the verifier against Foundry's operation, transit account and init code, and
every way an operation can be wrong),
[address-funding-sponsored.test.mjs](../test/zkapi/address-funding-sponsored.test.mjs)
(the signer's `personal_sign`, transport and gate),
[sponsored-fees.test.mjs](../test/zkapi/sponsored-fees.test.mjs) (offer rules,
route, quote, plan, words, generated rewrites) and
[sponsored-withdrawal-real-sdk.test.mjs](../test/zkapi/sponsored-withdrawal-real-sdk.test.mjs)
(close, escape, finalization and collection through the real SDK over its own
scripted chain, and refusals with nothing reaching the bundler); the row, error,
holdings and history tests are in [13](#13-test-map).


## 12. Known limitations and decisions taken

| # | Decision (default taken) | How to change it |
| --- | --- | --- |
| 1 | **Legacy pin.** Keep `3342c95` plus `wallet-recovery-v1`. | Move version 1 to the unpublished legacy re-cut by updating `package.json` and the lock, the row's `sdk.source`, `revision` and `storeSha256`, its `patches` and `gate.recoveryReview`, and `honorsDepositsFlag: true`; the host guard stays installed. It needs its own recovery review. |
| 2 | **Version 2 topology.** A new hostname, or the first version's hostname under a plain path prefix ([one hostname for several deployments](#one-hostname-for-several-deployments)); `proxyPath /zkapi-deployment-v2c/`, `publicPath /zkapi/v2c/`. Blocked on the operator supplying the finalized profile, SDK remote and commit. | Edit the pending row's paths before activation (path rules apply). After activation a path change would alias force-cached proving keys; use a new row instead. |
| 3 | **Cookies and cohort on `/zkapi/**` asset fetches.** Accepted and documented ([9](#9-privacy-and-security-notes)). | A byte-hash-guarded patch of both SDK workers to `credentials: 'omit'`, registered like `wallet-recovery-v1` and listed in each row's `sdk.patches`; it changes emitted asset bytes and provenance. |
| 4 | **In-app history of other versions' payments** is shown, read-only and text only, from the shared wallet database ([5.4](#54-the-shared-wallet-database)). A foreign row carries no action; the only control is "Open version P" through the existing switch. A payout of a version the app cannot open has no in-app claim. | Drop `readHistory` from the boot seam to hide it. A claim path for an unopenable version would need a new signer scope and its own review. |
| 5 | **Version 2's browser-held funding address** is offered as the legacy withdrawal destination, on explicit click, with a browser-only-custody warning. | The "new funding address" choice and the leftover-ETH section both depend on `versionUi.rescue` (`createVersionUi` in `versioning/ui.js`); without it neither is shown and a typed destination still works. |
| 6 | **Transition numbers.** 72 h close-by, reminders 7/3/1, a 14-day prompt window and the 6 h 35 m legacy chat cutoff. | The first four are registry data (`transition`, validator bounds apply); the cutoff is `LEGACY_CHAT_CUTOFF_SECONDS` in `adapters/noteBoundV1.mjs`. |
| 7 | **Dust or zero-balance notes on an exit-only version with a deposit target** can be given up by an explicit, confirmed action ([7.9](#79-giving-up-a-zero-or-dust-balance)), for families reviewed for it (`note-bound-v1` today; `concession-v1` is not) and unless the row's `abandonEnabled` is `false`. Dust is below the smaller of 0.005 ETH (an absolute ceiling, whatever the quote) and the larger of the request charge cap and the smallest chat key at the current quote ([the money rule](#the-money-rule)): at most 0.005 ETH and, while one dollar is worth more than the cap (ETH under about $20,000), at most one dollar. There is no in-app undo. The active version's own pinned dust note is not covered. | `transition.dustThresholdUsdMicros` (0 to the smallest chat key; 0 turns the dust leg off), `transition.abandonEnabled`, `adapter.abandon`. Reviewing `concession-v1` for it is its own change. |
| 8 | **One proof-setup rule on both networks, accepting the single-party `dev` setup.** The host accepts `mpc-1` and `dev` identically on Sepolia and mainnet, by owner decision; the limitation is noted and reported, not blocked ([below](#single-party-development-proof-setup-known-limitation)). | Narrow `ACCEPTED_SETUP_IDS` in `adapters/concessionV1.mjs` (and the tests that name both ids). A row live on `dev` then fails the `profile` rule, so replace or retire it first; a vault on `dev` keys cannot be re-pinned to `mpc-1` ([10](#10-runbooks)). |
| 9 | **The service pause is not a deposit gate.** The SDK clears its own manifest problem only inside an attempt, so a host pre-block could strand a person; the host words the pause and offers "Check again". | None; the SDK's refusal at the call is the enforcement. |
| 10 | **Near expiry and settlement waits are the SDK's.** The host reads `config.exit.near_expiry` and the refusal errors and keeps no settlement-window table; `adapter.chatCutoffSeconds` stays `null` for `concession-v1`. | None. |
| 11 | **The exit kit is export-only** with a generated passphrase, a two-step dialog and an in-memory "not saved" flag; no in-app restore, no persisted "saved" mark, no exit RPC setter. | A persisted mark would need a new storage key whose content cannot be non-identifying; an RPC setter would route a person-chosen address around the app's proxy. |
| 12 | **A balance whose version's SDK did not start is "saved in this browser", never empty, and its one action is Reload** ([5.10](#510-a-balance-the-page-holds-and-cannot-read)). The words name no cause, nothing that needs the SDK (an upgrade, a withdrawal, a give-up, a deposit) is offered, and on the deposit target deposits are closed with `holdings_unreadable`. | `held` in `versionState.mjs` and the `held.*` keys of `copy.mjs`. Offering anything more needs a way to act without the service, which the legacy SDK does not have (it is an in-app archive action that works without the service, the precondition of [Retire a version](#retire-a-version)). A "checking your balance" reading for a start that has not answered needs a new `held` variant and its words on every surface. |
| 13 | **Sponsored withdrawals are offered, through the app's route, on an explicit choice.** The relay is the operator's (the profile's pinned `bundler_url`, never a person-chosen one), the page never contacts it directly or on its own, and the Send Ethereum signer judges each operation where it would leave the browser ([11.7](#117-sponsored-withdrawals-the-network-fee-paid-from-the-withdrawal)). The MetaMask method is not host-verified before signing, and the address method has no wallet-paid recovery of a holding account. | Leave `gasless` out of (or `null` in) the reviewed profile and the choice is never drawn, the route never generated. To remove the feature from the code, drop `callProfile.sponsored` from the adapter (the facade, signer and rows all key on it). A user-chosen relay would need its own privacy decision: it routes a request around the app's proxy. |

Other limits:

- Nothing enforces the registry rules that live outside the build. The
  forward-only check (including identity continuity) is a command a person runs
  before merging, and this repository has no CI configuration. The rollback
  preconditions are the operator's and no code can see them
  ([Roll back](#roll-back)).
- A tab on pre-rollout JavaScript can still start a legacy deposit until it
  reloads; `browser-config.json` loads once per tab.
- `3342c95` cannot self-enforce a closed version, and its init hard-fails when
  its manifest or server is unreachable; a legacy escape finalization after the
  legacy stack retires needs manual on-chain finalization. It also sends
  proof-less clearance, which the operator may switch off after day 14 or 21;
  ask for a written operator commitment. The hard-fail is what makes a version 1
  balance unreadable, and so unwithdrawable and impossible to give up, while its
  operator is down: the page says it is saved in this browser and offers Reload
  ([5.10](#510-a-balance-the-page-holds-and-cannot-read)).
- A browser that holds a note of a retired version, or of one whose operator
  never returns, has no way out in the app: expiry does not release the slot,
  and the in-app archive action that would work without the service does not
  exist. Retiring a version while such holders may exist is therefore a
  blocker ([Retire a version](#retire-a-version)), not a warning.
- A lone exit-only version has no host evidence of a held balance (its boot
  opens no database), and a start that never answers reads as a start in
  progress; both are in [5.10](#510-a-balance-the-page-holds-and-cannot-read).
- Shared-slot exclusion rests on the lock, `reload()` discipline and distinct
  deployment ids; Web Locks are load-bearing.
- Real-browser behavior of Web Locks, BroadcastChannel and the version-less open
  is covered only over spec-faithful fakes and bundled Node runs.
- Unknown deployments block deposits but cannot be named or opened; the copy says
  "another version".
- The first `/build.json` check is at 5 minutes or the first visibility event.
- The boot-path discard accounting and the watcher's differ by design (per
  discard versus per pin).
- Funds at the version 1 funding scope can be stranded if the user typed that
  address as a destination; the denylist and the rescue reduce this, not
  eliminate it.
- A change that arrives while a person types a deposit amount in the Welcome is
  not drawn until the next event; the click re-checks the gate, so no deposit can
  start from a stale view.
- `AccountModal` and `WelcomePanel` have no teardown (page-lifetime singletons).
- A tab on pre-rollout JavaScript has no give-up verdict and can re-pin the slot
  after a balance was given up, as it always could after a discard.
- The limits that belong to the protocol behaviors (continuing call sites that
  name no cap, a payout of a version the app cannot open, the exit kit, the
  service latch) are in [11.5](#115-known-limits-and-support-runbooks).
- Tailwind regeneration is not required by this work: the version UI uses only
  utilities already in `chat/tailwind.generated.css`.
- A version 2 vault on the single-party `dev` setup is accepted and reported,
  not prevented ([the section below](#single-party-development-proof-setup-known-limitation)).

### Single-party development proof setup: known limitation

**Decision.** The host accepts the single-party development proof setup `dev`
for a `concession-v1` deployment on both Sepolia and mainnet, by exactly the
same rule as the ceremony setup `mpc-1`. The owner chose this; the limitation is
noted here and reported by the tooling, and nothing in this repository blocks it.
Sepolia and mainnet differ only in the network's own values (chain id, vault,
RPC, the funds at stake: test ETH on Sepolia, real ETH on mainnet).

**What a single-party setup means.** Groth16 proofs are sound only if nobody
knows the setup's toxic waste, the secret randomness the proving and verifying
keys were derived from. A multi-party ceremony such as `mpc-1` is sound if at
least one participant of each phase was honest and discarded theirs: it needs
a single honest participant, not all of them. A single-party setup is the
degenerate case, where the one party that ran the generator is the whole
assumption. Upstream describes the `dev` keys as generated by one party with OS
randomness, for tests, CI and the Sepolia drill vault (`docs-site/content/docs/cryptography.mdx`
lines 217 to 219; `protocol/setup/v2-concession-dev/README.md` lines 3 to 6), and
its migration runbook treats the drill vault's toxic waste as public (`docs/migration-concession-vault.md`
lines 489 and 490). Version 1 is not different in kind: its repaired setup was also
generated by a single party and is described that way in
[ZKAPI_PAYMENTS.md](ZKAPI_PAYMENTS.md) (the native ETH deployment notes) and
[APP_STATE.md](APP_STATE.md#2026-09-30-clarify-groth16-setup-terminology).
What differs is that the concession family names its setup in the profile, so
the host can tell the two apart and report it. The same reasoning covers any
setup that rests on one honest participant: if that participant was not honest,
or kept their secret, proofs can be forged. A ceremony makes that less likely;
it does not remove the assumption.

**Who can forge what.** Anyone who holds the toxic waste of the keys a vault
verifies against can write a proof that the vault's verifier and the operator's
server accept for a statement that is false. For this protocol upstream states
what that breaks: both the user's guarantee to get their balance back without
the operator (funds safety) and the operator's guarantee to be paid for what it
served (`docs/design/concession-exit.md` lines 110 to 114 and 917). In terms of
this app:

- **Mint balance.** A forged request proof is served as if a note with that
  balance existed, so its holder gets service that no deposit paid for. This is
  the operator-payment guarantee failing.
- **Defeat an honest exit.** A forged proof can stand as defeat evidence against
  a user's honest escape, so the exit that protects a user from a vanishing or
  hostile operator can be made to fail (the same upstream passage: "including
  defeat evidence").
- **Take deposits.** A forged withdrawal proof pays out of the vault funds that
  belong to other depositors, up to everything in it. This is the user-funds
  guarantee failing.

The holder is whoever generated the keys and anyone the waste reached; for
`dev`, upstream treats it as public. A vault's operator and its users need not
be that party. Nothing in the browser can check for it: the profile pins hashes
of keys, not how they were made.

**What this host does.**

- **Accepts it by one rule.** `ACCEPTED_SETUP_IDS` (`mpc-1`, `dev`) and
  `proofSetupKind` in
  [adapters/concessionV1.mjs](../chat/zkapi/versioning/adapters/concessionV1.mjs).
  The profile's `setup_id` must be one of them, and the bundle's manifest
  `setupId` must be one of them and equal it ([3](#3-registry)). The profile's
  `allow_dev_setup` field is ignored: it is a deploy-time record upstream's
  scripts write (`scripts/v2-acceptance.mjs` line 227, `demo/contracts/script/Deploy.s.sol`
  line 311) that no SDK file reads, so a `dev` profile with `allow_dev_setup`
  `false` is accepted like one with it `true`. The binding that matters is
  `setup_id`, which has to equal the bundle's, and the pinned key hashes, which
  the build checks against the emitted key bytes.
- **Warns in the build.** One `[build] WARNING:` line per live version (active
  or exit-only) whose profile pins `dev`, once per build, after the on-disk
  verification and before anything is emitted
  (`developmentSetupWarning` in [scripts/zkapiRegistry.mjs](../scripts/zkapiRegistry.mjs),
  printed by `buildZkapiAssets`). It names the version and network, says whoever
  generated the keys can forge proofs and take every deposit in the vault, that
  a vault on those keys cannot be switched to `mpc-1` later (a new vault and a
  user migration), and that it is accepted by owner decision. Nothing is printed
  for `mpc-1`, for version 1 or for a build that is not versioned.
- **Records it.** `zkapi.versions[].setupId` and `proofSetup` in `dist/build.json`
  ([4.6](#46-provenance-vercel-rewrites-and-the-dev-server)).
- **Repeats it in the registry check**, on stderr, per live row and network,
  without changing the exit code, and adds a second line when the installed SDK
  package's own build would refuse the row for mainnet (only a revision before
  `4b955d9` does, [4.7](#47-the-registry-cli)).
- **Passes an older SDK's mainnet refusal on in its own words.** An SDK
  revision before `4b955d9` refuses a `dev` bundle for chain 1
  (`development_setup_on_mainnet`); a pin of one of those fails the build with
  the host's explanation: the host accepts `dev` on every network, this
  revision's own build refuses it for mainnet, the host does not bypass or patch
  that check, upstream dropped the rule in `4b955d9` so the way forward is to pin
  a revision that includes it, and pinning an `mpc-1` bundle instead means a new
  vault and a user migration. The error keeps the code
  `development_setup_on_mainnet` and the SDK's error as its `cause`
  (`sdkRefusalError`). The refusal is met in the on-disk verification, before
  `dist/` or any other output is touched, when the package exports
  `assertDeployableProfile`; a package that exports none is refused only by its
  own build at emission, after the versions before it were emitted and before
  this one is. The check is the SDK's and is never reimplemented here. The
  tests keep this path covered through a variant of the fixture that puts the
  old clause back (`insertPreRelaxationMainnetRefusal` in
  `test/architecture/zkapiVersionedBuild.test.js`).
- **Holds the keys of a live version fixed.** A live row cannot change its
  `setup_id` or key pins in place; that is `identity_changed`
  ([The forward-only check](#the-forward-only-check)).
- **Says nothing in the app.** No panel, dialog, notice or copy table mentions
  the proof setup, and a version on `dev` looks like a version on `mpc-1` to a
  person using it. Disclosure is this document, the build output
  and the activation change. Showing it in the app would be a product change
  with its own copy on every surface that names a version.

**Gates outside this repository.** What upstream asks of a mainnet vault on
`dev` keys, as of `4b955d9` (the `v0.2` branch). At `82c8504` the SDK build and
the vault script refused outright; now each gate is an explicit opt-in on the
side of whoever builds or deploys, and the `release_policy_check` rule that keeps
single-party code out of production builds stays on. Paths are those of
`4b955d9`; line numbers are left out because they move with the source.

| Gate | Where | What it does now | What it means for a mainnet vault on `dev` |
| --- | --- | --- | --- |
| SDK package build | `sdk/build.mjs`, `assertDeployableProfile` | The chain 1 clause is gone. It still refuses a profile whose `setup_id` differs from the bundle's (`setup_mismatch`), another circuit, a vault without the concession exit and keys other than the shipped ones. `BUNDLE_SETUP_IDS` stays `dev` and `mpc-1` | Nothing to relax. A pin of `82c8504` or older still throws `development_setup_on_mainnet` |
| Vault deployment script | `demo/contracts/script/SetupPolicy.sol` (`_checkSetupPolicy`), called from `Deploy.s.sol` | `dev` and `rehearsal` deploy on any chain. Off local chains, mainnet included, they need `ALLOW_DEV_SETUP=1` and `SETUP_MANIFEST=protocol/setup/v2-concession-dev/manifest.json`; the script logs a warning and the manifest records `allowDevSetup: true`. An `mpc-1` setup off a local chain is refused until the ceremony manifest is committed | The deployer opts in on the command line |
| Proof library release policy | `protocol/rust/crates/zkapi-proof` (`compact.rs`, feature `dev-setup` in `Cargo.toml`) | Unchanged in kind: a build without `dev-setup` loads only `mpc-1` keys whose verifying keys equal the pinned ceremony keys, and `dev` loads only with the feature on | The operator's binaries need `--features zkapi-proof/dev-setup` |
| Release policy check | `protocol/rust/crates/zkapi-proof/src/bin/release_policy_check.rs` | Still fails a production build that gets `dev-setup` without asking for it (through a dependency or feature unification). Asking is `ALLOW_DEV_SETUP=1` on the build command | Single-party builds are deliberate, not accidental |
| Operator images | `docker/Dockerfile`, `docker/aws/Dockerfile.gateway`, `docker/aws/compose.yml` | Take `ALLOW_DEV_SETUP=1`: the daemons are built with `dev-setup` and the daemon and gateway images carry `protocol/setup/v2-concession-dev` | The operator builds its own images with the flag; the released image stays `mpc-1` only |
| Exit-kit companion | `zkapi-clientd/scripts/build-native.sh` (companion in `crates/zkapi-companion`) | Takes `ALLOW_DEV_SETUP=1` and then bundles the development setup | The tool that opens an exit kit ([7.8](#78-the-exit-kit)) opens a kit of a `dev` vault only from a build made with the flag; the released companion still loads only the pinned `mpc-1` keys |

What a mainnet vault on `dev` keys therefore needs is a list of opt-ins, none of
them in this repository and none of them done by accepting `dev` in the
registry: `ALLOW_DEV_SETUP=1` with the dev `SETUP_MANIFEST` for the deployment,
the same flag for the operator images and the companion, and a browser bundle
built with `scripts/build-browser-client.sh --setup dev` and synced with
`scripts/sync-sdk-assets.mjs --setup dev --network mainnet` (the SDK package
already ships one, which is the bundle this repository was rehearsed with).

**Moving to `mpc-1` later is a new vault.** The vault's `proofAdapter` is
`immutable` (`protocol/contracts/src/ZkApiVault.sol` lines 73 and 168) and the
adapter's `REQUEST_VK_HASH` and `WITHDRAWAL_VK_HASH` are constants
(`protocol/contracts/src/adapters/Groth16ProofAdapter.sol` lines 17 and 19);
upstream says never to regenerate a setup after a public deployment because the
adapter, the clients' profiles and every deployment manifest pin its keys
(`protocol/setup/v2-concession/README.md` lines 10 to 13). A vault deployed on
`dev` keys therefore cannot be switched to `mpc-1`, and a profile cannot be
re-pinned to `mpc-1` under the same vault (the forward-only check refuses it).
The way out is a further version of this registry
([Add a future version](#add-a-future-version)): a new vault with an `mpc-1`
adapter, a new row (next ordinal, its own SDK alias and paths, because a bundle
carries one setup), the `dev` row moved to `exit-only` and later retired, and a
user migration by the upgrade flow of [7](#7-upgrade-ux), which is two public
transactions and is linkable ([9](#9-privacy-and-security-notes)). Until each
holder has moved, their balance in the `dev` vault rests on the single party.

**Activation checklist, as changed.** [Activate a new version](#activate-a-new-version)
gate 2 no longer requires `mpc-1`. It asks that the activation choose a setup
(`mpc-1` or `dev`, one for both networks), record it and the limitation in the
change, expect the build warning and the registry check's warnings, read
`proofSetup` in `dist/build.json`, and, for mainnet on `dev`, record the
opt-ins above (`ALLOW_DEV_SETUP=1` for the vault, the operator images and the
companion) in the change. Decide before the vault is deployed, because the
choice cannot be reversed in place.

## 13. Test map

Run all with `npm test` (the runner bundles `test/**` outside `test/zkapi` and
runs that group first; only if it passes does it run `test/zkapi/*.test.mjs` and
`.cjs` in plain Node, so a failure in the first group hides the second). One
file: `node --test test/zkapi/<file>`. Hard-coded test counts are deliberately
not recorded in the docs; run the suite for the current numbers (in an
ordinary checkout the tests that need a real successor SDK skip, and a clean
run prints no failing-test block). Four tests parse sources with `acorn`
(`zkapi-wiring`, `zkapiVmSources`, `zkapiVmSourceCopies` and
`zkapiVersioningUiGraph`): it is a pinned `devDependency` of `package.json`,
not a transitive one of `terser`.

Some tests need the real successor SDK and skip without it. They find it under
its registry alias, or in the directory `ZKAPI_V2_SDK_DIR` names (an unpacked
copy of the SDK repository; only its plain modules are imported and none of its
scripts is run). They are activation evidence
([Activate a new version](#activate-a-new-version)); with the `0.2.0` snapshot
all pass except the one that is meant to fail on a revision without the SDK
half of the withdrawal recheck.

| File | Pins |
| --- | --- |
| [zkapi-registry-model.test.mjs](../test/zkapi/zkapi-registry-model.test.mjs) | every rule and error code above; derive-do-not-duplicate; runtime table excludes pending; activation yields one target; the add-v3 scenario; `deposits: "closed"` only for `honorsDepositsFlag` rows; both networks accept `mpc-1` and `dev` alike (the profile's `allow_dev_setup` is ignored) and refuse any other setup, none and `not_deployed` with identical messages, and `allowDevSetup` is an unknown field; activation gates (review revision, `WIRED`, manifest hash), each refusing on its own with the host wiring in place; the `dustThresholdUsdMicros` and `abandonEnabled` rules; a revert fixture fails and a rollback fixture passes; identity continuity (`tombstone_mismatch`, `identity_changed`, `identity_unverified`, the override), including that a live row keeps its proof setup and each key pin in both directions between `dev` and `mpc-1`, through every move and for profile files edited in place, and that a further row on the other setup is a legitimate move; tombstone and per-network uniqueness; `no_live_version`; tombstone chain. Several of its tests pin today's dormant registry ([Activate](#activate-a-new-version)) |
| [service-base.test.mjs](../test/zkapi/service-base.test.mjs) | one hostname for several deployments ([3](#one-hostname-for-several-deployments)): the shape of a service base and its prefix (exact, no trailing slash, reserved first segments), which pairs overlap, the scoped proxy rewrite and the generated configuration (bundler route first, no broad rewrite for a prefixed version), and that the installed legacy SDK and a successor SDK (when present) map a URL under a prefix to the proxy URL the rewrite forwards |
| [zkapi-snapshot-adapters.test.mjs](../test/zkapi/zkapi-snapshot-adapters.test.mjs) | profile validation accepts a plain path prefix on the protocol and indexer base for both families and nothing else of the former origin rule changes; normalization of both SDK snapshot shapes; deadline fuzz (a unit change or garbage never overrides a deposit-row expiry); call-profile table equals the real encoders; deposit-entry-point classification; `getActiveAdapter()` returns the installed adapter; the proof-setup rule on both networks (`mpc-1` and `dev` accepted alike, anything else refused) with and without a bundle `setupId`, and `proofSetupKind`; adapter `billing`, `abandon` and `watchFacts` data |
| [zkapi-wallet-holdings.test.mjs](../test/zkapi/zkapi-wallet-holdings.test.mjs) | classifier parity with upstream cases; fail-closed unknown keys; the probe writes and creates nothing; schema parity with a database made by the real legacy store; `draft_only` and `unsent_prepared` detection; discard preconditions, `ifAvailable`, no-locks refusal, channel post; the drift guard (11.3) |
| [zkapi-version-loader.test.mjs](../test/zkapi/zkapi-version-loader.test.mjs) | rows 1 to 7; three-version generalization; `prefer` rules; unreadable and timeout; unknown and retired owners; credit holders; purity; the lost-race re-read with three concurrent tabs; guard charged only for discards that happened |
| [zkapi-switch-protocol.test.mjs](../test/zkapi/zkapi-switch-protocol.test.mjs) | round trip; enum and id validation; view and `prefer` normalization; busy refusal; the loop guard across simulated reloads; URL never read; storage failures; intent expiry; `canDiscard` and `noteDiscard`; no key reaches account sync |
| [zkapi-deposit-guard-successor.test.mjs](../test/zkapi/zkapi-deposit-guard-successor.test.mjs) | the real client and runtime of a successor SDK (alias or `ZKAPI_V2_SDK_DIR`; skipped without one): the adapter classifies every `/deposit/i` method, and on a closed version only the listed entry points are wrapped, recovery names such as `completeConfirmedDeposit` and `confirmedDepositFor` reach the SDK |
| [zkapi-deposit-guard.test.mjs](../test/zkapi/zkapi-deposit-guard.test.mjs) | real legacy client and runtime over a fake IndexedDB: refusal before any RPC, write or prompt; a started deposit stays completable; amount or operation change refused; an unsent plan refused; the drift tests; deny-by-default for a `/deposit/i` method no list names |
| [zkapi-version-state.test.mjs](../test/zkapi/zkapi-version-state.test.mjs) | phase precedence; tiers and window boundaries; close-by arithmetic; set-aside-only holders; short-lived notes; the reload reasons and their evidence; `reload_required` closes the gate; operator `notices` with their `noteId`; the state's key list (`held` is null on every ordinary state) |
| [zkapi-upgrade-flow.test.mjs](../test/zkapi/zkapi-upgrade-flow.test.mjs) | the stage table; a bare `withdrawing` intent proves nothing; storage-failure tolerance |
| [zkapi-version-copy.test.mjs](../test/zkapi/zkapi-version-copy.test.mjs) | tokens N, F, P, R, V and the exit tokens; forbidden vocabulary and the unit-word sweep; sentence case; escaping and truncation; a sweep of every key under every token combination; an instant that passed is left out; a reference number 0 renders; the held-balance words (exact text, which versions they name, no cause, no promise of a return, no address, nothing to press) |
| [zkapi-version-ui-render.test.mjs](../test/zkapi/zkapi-version-ui-render.test.mjs) | the dialog: pill, banner, upgrade view, closed views; fail-open without context; the settle window; evidence-based words; the real facade composed with the real UI; the gated submit order and what it asks of the SDK, a dormant withdrawal's call list, the settlement choice and its stale cases, the balance extras, per-record extras and attribution of each button, other versions' history rows and their one control |
| [zkapi-version-panel-render.test.mjs](../test/zkapi/zkapi-version-panel-render.test.mjs) | panel pill and banner placement and order; the ticket slot; all seven UX proposals unaffected; operator notices (patched in place; a new one asks for a render); reminders; the service notice's words by code |
| [zkapi-boot.test.mjs](../test/zkapi/zkapi-boot.test.mjs) | ordering through injected seams; the sdk-default path; single path without probe; a dormant build waits for its code without a limit and its imports overlap; failure isolation (every rejection and a never-resolving open still yield ticket-only); budgets of a versioning-active build, including the selection budget; late notices; the give-up and history seams (passed only when versioned, loaded on use, never in the static graph, a failed chunk leaves the page working); startup forwards no seams |
| [zkapi-version-watcher.test.mjs](../test/zkapi/zkapi-version-watcher.test.mjs) | focus, visibility and channel re-probe; `stale_build` only from restrict-only diffs; discard retry; per-pin charging |
| [zkapi-versioning-facade.test.mjs](../test/zkapi/zkapi-versioning-facade.test.mjs) | gate truth tables including `isVersioningActive`; fail-closed branches; the intent follows what the tab observes; session flags in the signature; reminders in memory; notices carry `noteId` |
| [zkapi-config-integrity.test.mjs](../test/zkapi/zkapi-config-integrity.test.mjs) | served-config hash, re-encoding tolerance, identity assertion |
| [zkapi-discard-unsent.test.mjs](../test/zkapi/zkapi-discard-unsent.test.mjs) | the SDK-side "Cancel unfinished deposit" |
| [zkapi-chat-runtime-versioning.test.mjs](../test/zkapi/zkapi-chat-runtime-versioning.test.mjs) | `near_expiry` cutoff only for a send that opens a new key, larger-key copy, busy provider |
| [zkapi-header-normalization.test.mjs](../test/zkapi/zkapi-header-normalization.test.mjs) | allowlist rebuild across both header shapes and an extra-header fixture |
| [address-funding-call-profiles.test.mjs](../test/zkapi/address-funding-call-profiles.test.mjs) | `validateCall` accept and deny matrix per profile; signing default; strict gate shape; destination denylist; the concession rules ([7.5](#concession-and-operation-rules-of-the-signer)): exact amount, cap, conversion only for a family with a concession word and never the reverse, operation binding, the repeat hold as a cap, journal shape readable by an older build |
| [address-funding-escape-concession.test.mjs](../test/zkapi/address-funding-escape-concession.test.mjs) | the same rules through the real concession encoders (and the real `0.2.0` encoders when a successor SDK is present); the refusal words; the SDK clearing the plan before the words are restored |
| [sponsored-operation.test.mjs](../test/zkapi/sponsored-operation.test.mjs) | the sponsored-operation verifier ([11.7](#117-sponsored-withdrawals-the-network-fee-paid-from-the-withdrawal)): the operation hash, transit account and init code equal Foundry's vectors ([zkapi-sponsored-vectors.json](../test/fixtures/zkapi-sponsored-vectors.json), computed independently of every SDK encoder); upstream's signed close is accepted for the withdrawal it belongs to and every other payee, owner, note, mode, paymaster, EntryPoint, fee cap, call, gas, signature and concession is refused with its own code; finalization and collection rules |
| [address-funding-sponsored.test.mjs](../test/zkapi/address-funding-sponsored.test.mjs) | the provider's sponsored half: `personal_sign` only inside an authorized action with a `sponsored` confirmation, only a 32-byte hash, only this address, a bounded count; the bundler transport's method allowlist, request shape and refusals; the gate before `eth_sendUserOperation` (nothing reaches the route unless the verifier accepts); no transport without a pinned profile or a route; the `collection` authorization kind |
| [sponsored-fees.test.mjs](../test/zkapi/sponsored-fees.test.mjs) | when the choice is offered (family, client, complete pins, origin); the route and its derivation; the generated rewrites and their order; a normalized quote and a plan whose options equal what was shown with bounded headroom; the product's words (no protocol names) |
| [sponsored-withdrawal-real-sdk.test.mjs](../test/zkapi/sponsored-withdrawal-real-sdk.test.mjs) | the real successor client and runtime over the SDK's own scripted chain and bundler, through the host's signer: close, escape, finalization and collection are accepted when they are the confirmed withdrawal, and a wrong payee, note or fee is refused with nothing reaching the bundler; skipped without a successor SDK |
| [address-deposit-flow-closed.test.mjs](../test/zkapi/address-deposit-flow-closed.test.mjs) | a closed flow stops polling; `verifyReady` error shape; `reopenIfAllowed` |
| [retired-funding-scope.test.mjs](../test/zkapi/retired-funding-scope.test.mjs) | scope isolation, sweep, no cross-scope resume, no automatic balance read; the release rule and its outcomes |
| [token-amount.test.mjs](../test/zkapi/token-amount.test.mjs) | the host amount parser equals the SDK's |
| [zkapi-sdk-v2-fixture.test.mjs](../test/zkapi/zkapi-sdk-v2-fixture.test.mjs), [zkapi-fake-indexeddb.test.mjs](../test/zkapi/zkapi-fake-indexeddb.test.mjs) | the fixture SDK and the fake IndexedDB, locks and channel other tests rely on. The fixture test pins the SDK's own behavior at `4b955d9`, which accepts a `dev` setup on both networks (the `82c8504` snapshot refused it for chain 1 with `development_setup_on_mainnet`; `zkapiVersionedBuild.test.js` keeps that older behavior covered through an explicit variant); the host accepts it on both networks ([3](#3-registry)) |
| [zkapiVersionedBuild.test.js](../test/architecture/zkapiVersionedBuild.test.js) | sdk-default, dormant single and multi builds; facades; the parity gate and its allowlist; the default-name trace; verification receipts; per-version patches; the bundled Vercel generator; `.vercelignore`; the CLI; the proof-setup rules on both networks (accepted ids, pairing with the bundle's manifest, the emission step passing the SDK build's reported setup), the build warning (once per live version, exit-only included, none for `mpc-1` or a dormant build), the provenance fields, the SDK's mainnet refusal passed on with the host's words and its `cause`, and the registry check's warnings, the `--package-root` probe, the first-activation case and the in-place `dev` to `mpc-1` refusal |
| [zkapiVmSources.test.js](../test/architecture/zkapiVmSources.test.js) | the import lists and free identifiers of the four vm-evaluated sources (below) |
| [zkapiVmSourceCopies.test.js](../test/architecture/zkapiVmSourceCopies.test.js) | the five facade helpers (`versionFacade`, `depositGate`, `depositsClosedLine`, `versionStamp`, `stampMatches`) that `AccountModal.js` and `WelcomePanel.js` each write out, because neither may import, are the same syntax tree in both |
| [zkapiBuild.test.js](../test/architecture/zkapiBuild.test.js) | the pre-existing build invariants, adapted for the boot stub and registry allowlist |
| [sdk-recovery-patch.test.mjs](../test/zkapi/sdk-recovery-patch.test.mjs) | the patch driven by the registry, symlinked checkouts, bundled copies not running |
| [zkapi-recovery-coverage.test.mjs](../test/zkapi/zkapi-recovery-coverage.test.mjs) | `PATCH_COVERAGE` and `SDK_HALF_WIRING`; a patch counts only for its own revision; `recoveryCoverageGaps` over fixture registries; the registry CLI refuses and accepts as documented; the build refuses a copy of the shipped scripts with an activated registry and plans a covered one |
| [zkapi-wiring.test.mjs](../test/zkapi/zkapi-wiring.test.mjs) | `WIRED` equals the adapters' `requiredWiring` and is immutable; the evidence table ([11.1](#111-protocol-wiring-requiredwiring)); each SDK-half behavior bound to its real-SDK test; the exact set of continuing call sites that name no bound (the open item of 11.1) |
| [zkapi-concession-real-shapes.test.mjs](../test/zkapi/zkapi-concession-real-shapes.test.mjs) | exact normalized objects of the thirteen real-shape scenarios at an injected clock; numeric `credited_amount`; the unit-slip guard; the watcher's per-chat facts; the fixtures ([real shapes](../test/fixtures/zkapi-v2-real-shapes/README.md)) |
| [zkapi-exit-refusal.test.mjs](../test/zkapi/zkapi-exit-refusal.test.mjs) | each refusal code; seconds versus milliseconds; the 90-day clamp and the 60-second skew; the chat shape of `request_settlement_pending` ignored; the AND rule for the service codes; the legacy shape never a pause |
| [zkapi-version-state-protocol.test.mjs](../test/zkapi/zkapi-version-state-protocol.test.mjs) | the exit, payout, set-aside and abandon facts of the state over the real-shape scenarios; flagged records and phases; a held settlement refusal merged with the standing time and bound |
| [zkapi-protocol-notices.test.mjs](../test/zkapi/zkapi-protocol-notices.test.mjs) | the exit-state notices ([7.6](#76-exit-state-notices)): placement, ticket exclusion, interactions, actions, clock marker, escaping |
| [zkapi-exit-kit-dialog.test.mjs](../test/zkapi/zkapi-exit-kit-dialog.test.mjs) | the two-step dialog, the generated passphrase and retype, the fresh-gesture download, "Save again", the unsaved result, nothing stored or logged, and that the passphrase reaches no clipboard (no Copy action, no clipboard call of any kind, none in the source) |
| [zkapi-balance-extras-exit-choice.test.mjs](../test/zkapi/zkapi-balance-extras-exit-choice.test.mjs) | the kit row and give-up link; the settlement choice for each kind of withdrawal, the bound read from the drawn markup, the state after the settlement time |
| [zkapi-abandon-verdict.test.mjs](../test/zkapi/zkapi-abandon-verdict.test.mjs) | every `blockedBy`, zero, dust and the limit, quotes (valid, expired, future, extreme), the ceiling, fail-closed switches, `isBareNote` against the store's own classification, BigInt parity with the installed SDK and the real `0.2.0` vectors |
| [zkapi-abandon-note.test.mjs](../test/zkapi/zkapi-abandon-note.test.mjs) | the give-up service over the real store (and the real `0.2.0` store when present): no locks, a busy lock, `init` outside the lock, the re-check inside it, one commit, the note-id guard, late attempts, the drift guard over the keys the archive drops, **the support restore procedure** |
| [zkapi-abandon-dialog.test.mjs](../test/zkapi/zkapi-abandon-dialog.test.mjs) | the checkbox gating the button, ETH beside USD, escaping, focus, final and retryable refusals |
| [zkapi-other-version-history.test.mjs](../test/zkapi/zkapi-other-version-history.test.mjs) | the reader is read-only (dump equality, one transaction, nothing created) and holds one raw record at a time (a cursor per store, each record projected as it arrives, never `getAll`); parity with the real legacy store and the real v2 dump; the allowlist and drift guard; expiry parity (fuzzed and replayed vectors); labels and units; caps; the renderers (no actions, escaping, vocabulary) |
| [zkapi-record-extras.test.mjs](../test/zkapi/zkapi-record-extras.test.mjs) | the held-payout card, alert note and device note of one record; the claim button's hooks; nothing for a legacy row; the real client and store when a successor SDK is present |
| [zkapi-held-balance.test.mjs](../test/zkapi/zkapi-held-balance.test.mjs) | a balance the page holds and cannot read ([5.10](#510-a-balance-the-page-holds-and-cannot-read)): the state over each of the three facts (every slot kind, another owner, a fresher preview that moved or could not read, a started SDK that reads a note or nothing), the phase's place, the gate on the exit-only version and on the deposit target and that it only restricts, no stage narrated, the notice and views and their words, what is withheld (the give-up answers `unavailable` without calling the service); the facade end to end over a wallet database written by the real legacy store and read by the real boot probe, with a client that holds exactly what the real legacy client class held when its manifest answered 503 ([client.json](../test/fixtures/zkapi-legacy-start-failed/client.json)): a failed start, a refresh that replaced the error, a refresh a host answered with its own page, the balance returning when the SDK starts, a previous version that failed to start; the error words (`isStartFailure`, `explainZkapiError`, a send, closing a chat key, the settlement); and that an empty slot, one version and a lone exit-only version are not told about a held balance |
| [zkapi-held-balance-render.test.mjs](../test/zkapi/zkapi-held-balance-render.test.mjs) | the real System Panel, balance dialog and welcome for a held balance: label, pill, notice and button, no SDK text with or without an error on the client, the chat bar and balance control, the balance, Withdraw and closed-deposits views saying the same words, the deposit target, the stand-in line before the helpers load, no wallet-method or funding controls, no SDK message in the funding line, and the panel unchanged without a facade or for a started SDK that found nothing; the page's own facade driving them from a failed start |
| [zkapi-other-deployment-credits.test.mjs](../test/zkapi/zkapi-other-deployment-credits.test.mjs) | a credit arrives only through `config.other_deployment_credits`: phase, `previous`, gate, notices, dedupe against the holdings read |
| [zkapi-facade-protocol.test.mjs](../test/zkapi/zkapi-facade-protocol.test.mjs) | `sendGate` near expiry, `recheckService`, held refusals and their attribution and expiry, the three producers, `formatAmount`, history coalescing, `operationRecheckRequired`, `resetForTests`, and every real-shape scenario through the real facade to its notices |
| [zkapi-api-refusal-seam.test.mjs](../test/zkapi/zkapi-api-refusal-seam.test.mjs) | the one seam of `chat/zkapi/api.js`: it notes the refusal as the slot's and rethrows the same error object |
| [zkapi-v2-real-sdk-rehearsal.test.mjs](../test/zkapi/zkapi-v2-real-sdk-rehearsal.test.mjs) | activation evidence against the real successor SDK; skipped without one; its first test fails on a revision without the SDK half |
| [zkapiVersioningUiGraph.test.js](../test/architecture/zkapiVersioningUiGraph.test.js) | every static import of `versioning/ui.js` and `boot.js` resolves and exports the names used; both closures are SDK-free; the on-demand modules stay out of the static graph |
| [wallet-modal-restore.test.mjs](../test/zkapi/wallet-modal-restore.test.mjs), [private-balance-help.test.mjs](../test/zkapi/private-balance-help.test.mjs), [zkapi-error-copy.test.mjs](../test/zkapi/zkapi-error-copy.test.mjs), [withdrawal-recovery.test.mjs](../test/zkapi/withdrawal-recovery.test.mjs), [address-funding-provider.test.mjs](../test/zkapi/address-funding-provider.test.mjs), [zkapi-ux.test.mjs](../test/zkapi/zkapi-ux.test.mjs), [zkapi-ux-render.test.mjs](../test/zkapi/zkapi-ux-render.test.mjs) (existing files, extended) | the `upgrade` view and its saved-view stamp; the third help kind; the protocol-version error rewrites (service, exit and the settling-chat words, the pinned proof countdown), the sponsored refusals (the signer's own sentences inside the SDK's wrapper, every reason code with its line), and that a dormant page rewrites no error; the sponsored fee choice, quote and plan in the dialog, the payout rows (waiting, held, fee paid), the holdings that keep a version loaded for a pending sponsored payout and the other-versions reader's allowlist and reading of a sponsored row; the note-only recheck branch and the unchanged strict branch; the mint branch gone on every network; the frozen and device words of the panel, composer and chip |

**The vm-evaluated sources.** Four files are evaluated by tests in a `vm` with
their import lines stripped and a hand-built context:
`AccountModal.js`, `WelcomePanel.js`, `WalletMethodControls.js` and
`services/walletMethod.mjs`. A new import or free identifier there is a
`ReferenceError` in a test, or worse in a path no test reaches, so they reach
version context only through `zkapiClient.oaVersioning?.<member>` (and
`oaVersioning.ui`, which is where `act`, `attach` and `rescue` live) and gain no
import. Absent in those tests, everything fails open to "deposits allowed, no
version UI". Their free identifiers are pinned too (`AccountModal.js` may read
only `clearTimeout`, `document`, `queueMicrotask`, `setTimeout` and `window`
beside the ES built-ins), which is why anything that needs `Blob`, `URL`,
`navigator` or `crypto` (the exit kit's download) lives in a component module
reached through `ui`. Adding an import means updating every test that evaluates
the file and the pin in `zkapiVmSources.test.js` in the same change. The five
facade helpers that the account dialog and the welcome panel each carry (they
cannot share a module) are compared as syntax trees by
`zkapiVmSourceCopies.test.js`, so a change to one copy must be made to both.
Components that are not vm-evaluated (`RightPanel.js`,
`PaymentModeRightPanel.js`, `ZkapiStateExperience.js`,
`zkapiChatRuntimeCore.mjs`) import the facade directly.
