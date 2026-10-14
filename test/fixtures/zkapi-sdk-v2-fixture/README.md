# zkAPI SDK 0.2.0 test fixture

**Test only. This is not the zkAPI SDK and must never be installed, bundled into the
app, or published.** It is a tiny, deterministic stand-in for the successor SDK
(`@openanonymity/zkapi-browser-sdk` 0.2.0, circuit `zkapi-v2-concession-v1`, upstream
revision 82c8504, which is not published) so that build and plugin tests can exercise a
second SDK package without the real 18 MB one. The real SDK was only read to make it.

What matches the real SDK: the package name, version and `exports` map; the export names
of every subpath; the instance surface of the client and runtime singletons; the store's
declaration lines; the `./build` contract (result shape, file layout, error codes).
What does not: all protocol behavior. See "Fidelity".

## Use in a test

Copy `package.json` and `sdk/` (what `npm install` of the real package yields, given its
`files: ["sdk/"]`) to `<temp>/node_modules/<alias>/`, for example `zkapi-sdk-v2c`. Never
`npm install` it and never edit it in place.

```js
const { buildBrowserSdkAssets, assertDeployableProfile } = await import('<alias>/build');
const result = await buildBrowserSdkAssets({ outDir, network: 'sepolia', publicPath: '/zkapi/v2c/', build });
// result: { directory, config, manifest, files, configUrl, workerUrl }
```

`build` is esbuild's `build`; the fixture passes it the worker entry only. Emitted files:
`browser-config.json`, `assets/zkapiWasmWorker.js`, `wasm/zkapi_browser_bg.wasm`,
`proofs/{request.pk,withdrawal.pk,request.vk}`, `sdk-assets.json` (schema 2). Everything
but the worker is byte-for-byte reproducible; the worker's hash depends on the esbuild
version, so do not pin it.

`assertDeployableProfile(config, manifest, network, hashes)` is the real function: `config`
is a whole browser config (it reads `config.trusted_deployment`), `manifest` carries
`circuitId` and `setupId`, and `hashes` is keyed `assets/proofs/request.pk`,
`assets/proofs/withdrawal.pk`, `assets/proofs/request.vk` (the package manifest's keys), not
the `proofs/...` keys of the emitted `sdk-assets.json`. Codes: `deployment_not_deployed`,
`incompatible_proof_circuit`, `setup_mismatch`, `development_setup_on_mainnet`,
`exit_concession_required`.

To test a refusal that comes from the package's own profile (placeholder, other circuit or
setup), edit `sdk/assets/config/<network>.json` in the temp copy, then run
`node refresh-assets.mjs` from a copy of that script placed beside `sdk/`. Without it the
build stops earlier, at the manifest integrity check. See
`test/zkapi/zkapi-sdk-v2-fixture.test.mjs` for worked examples.

## Pinned values

Checked by `test/zkapi/zkapi-sdk-v2-fixture.test.mjs`; change them only through the
maintenance steps below.

```text
store-sha256: 21f749c721760b48b642a57aa0b61e266b8a31dc69561cc3ecccf3c8fa673d0b
request-pk-sha256: 655991d7f899c80def98790cb05a7aab53abb9607e2b0f7ebf73f5cedcc4602a
withdrawal-pk-sha256: 61414e8b62b9a092c1fb50dd01609f32d9e4854b87e4be9c2f8750e067408d1a
request-vk-sha256: dd678eed0029ab83e88bb84bf13c93a161a61fbc8c650875595cc8bcdaeada62
browser-config-mainnet-sha256: 5f460322ac318485aae6ed2059c128ef77bb460c79b1405dc30cdfa365347073
browser-config-sepolia-sha256: f4d6f7eb63b0145ec6413d378b8bedcc0ef52d712ed8ea7cfd5a14c895ecd7a4
```

`store-sha256` is the SHA-256 of `sdk/services/browserWalletStore.js`, the value a wallet
database rename plugin pins. The file has, once each and exactly as the real store:
`const DB_NAME = 'zkapi-browser-wallet-v1';`, `const DB_VERSION = 3;`,
`const lockName = 'zkapi-wallet:active-runtime';` and
`new BroadcastChannel('zkapi-wallet:active-runtime')`. The DB name literal appears nowhere
else under `sdk/`, so after a correct rename none remains in a bundle.

The `browser-config-*` values are the SHA-256 of the file, which is also the bytes the
build emits as `browser-config.json`.

Package identity: circuit `zkapi-v2-concession-v1`, setup `mpc-1` (so one bundle is valid
on both networks; the real development bundle names `dev`, which the host accepts on every
network but the SDK build's own `assertDeployableProfile` refuses for chain 1 with
`development_setup_on_mainnet`, a refusal this fixture reproduces), manifest
schema 2, `sourceRevision` `0123456789abcdef0123456789abcdef01234567`, default public path
`/zkapi/v2c/`.

The two profiles in `sdk/assets/config/` are deployed-looking and pin the fixture's own
key hashes: network chain id 1 or 11155111, deployment id
`zkapi-native-eth-<network>-concession-v1-fixture-v2c`, vault `0x2222...2222`, origin
`https://zkapi-v2c-<network>.example.test`, proxy path `/zkapi-deployment-v2c/`, vault
revision 3, `exit_concession` 1, `deployment_status` `deployed`. They equal
`concessionProfile(network, { slot: 2 })` in `test/zkapi/_registryFixtures.mjs` except for
the key hashes (and, on Sepolia, the real placeholder's `max_pause_duration` and
`settlement_window_seconds`), and pass that registry's `concession-v1` profile validation.

## Fidelity

| Fixture file (under `sdk/`) | Real counterpart | Kind |
|---|---|---|
| `configure.js`, `build.mjs`, `services/zkapiGas.mjs`, `zkapiWalletError.mjs`, `zkapiWithdrawalRoot.mjs`, `zkapiRequestCompat.mjs` | same path | verbatim copy (small, pure) |
| `index.js` | `index.js` | verbatim |
| `services/browserWalletStore.js` | same | declarations, lock, channel, `readBrowserWallet`, `writeBrowserWallet`, `withBrowserWalletLock`, `createWalletChannel`, `requestPersistentStorage` are real or simplified; everything else throws |
| `services/zkapiClient.js`, `browserWalletRuntime.js` | same | full instance surface by name; stubs record calls |
| `wallet.js` | same | real constants plus the real `abiWord`, `addressWord`, `callData`; `ABI` lists only the five selectors the host's call profiles pin; codecs throw |
| `services/zkapiRequestArchive.mjs`, `zkapiExitKit.mjs`, `zkapiExpiryHistory.mjs`, `zkapiWithdrawalRecovery.mjs`, `zkapiContractError.mjs` | same | real constants, functions throw |
| `services/zkapiWasmWorker.js`, `wasm/*`, `assets/**` | same | tiny stand-ins at the real paths |
| `services/fixtureSupport.js` | none | fixture only |

Stubs throw an error with `code: 'fixture_not_implemented'` and record the call first.
`parseTokenAmount` and `formatTokenAmount` are not exported from `./wallet`, as in the real
0.2.0 SDK.

The singletons record every call in one ordered array, `zkapiClient.fixtureCalls` (the
same array as `browserWalletRuntime.fixtureCalls`): `{ seq, target, name, args }`.
`zkapiClient.fixtureAccessHeaders` adds headers to what `acquireInferenceAccess` returns
(the real four: `authorization`, `content-type`, `http-referer`, `x-title: zkAPI`), for
allowlist tests. Both are non-enumerable. Importing `./client` sets
`globalThis.zkapiClient`, as the real module does. `client.init()` calls
`configure.beginBrowserSdkInitialization()`, so a later `configureBrowserSdk` throws.

Known differences: no localStorage read in the client constructor; `activeWithdrawal` has
no late-attempt fallback; `nativePriceQuote` and `expiryHistory` are inert; the runtime's
`init` only reads the wallet slot.

## Maintenance

- **The real SDK's names changed or a snapshot moved.** Run
  `node test/fixtures/zkapi-sdk-v2-fixture/verify-exports.mjs <real SDK root>`; it prints
  every missing or extra name per list. Fix the export statements or member lists in the
  fixture modules, then re-record with `--update`. Without a root it checks the fixture
  against the recorded digests (`real-sdk-exports.json`) and skips the real comparison.
- **A pinned file changed** (`wasm/*`, `assets/proofs/*`, `assets/config/*`): run
  `node test/fixtures/zkapi-sdk-v2-fixture/refresh-assets.mjs`; it rewrites the key hashes
  in both profiles and `assets/manifest.json`. `--check` only verifies. Then update the
  values above.
- **The store changed**: update `store-sha256` above and every test that pins it.
