# Optional zkAPI payments

OA Chat owns the payment-mode toolbar, balance/funding/history UI, model
pricing, and chat runtime adapter. It consumes the independently installable
`@openanonymity/zkapi-browser-sdk` at the exact Git revision recorded by
`package.json` and `package-lock.json`. The SDK owns wallet storage, proofs,
key issuance/settlement, and withdrawals. The dependency direction is OA Chat
to zkAPI; the SDK has no OA Chat submodule or UI dependency.

## Build

The default `npm run build` retains Tickets only. To enable both methods:

```sh
OA_ZKAPI_NETWORK=sepolia npm run build
OA_ZKAPI_NETWORK=mainnet npm run build
```

The network is an explicit build setting, independent of the OA organization.
Unknown settings fail the build. SDK assets are emitted under `dist/zkapi/`;
the app remains at `/`. Disabled builds do not import the SDK or emit its
wallet/proof assets. WASM/proving keys and trusted network configuration are
provided by the pinned SDK, checked during build and proof loading, and do
not require a setup ceremony or Rust installation on the host.

For the staging OA organization through same-origin Vercel rewrites:

```sh
OA_ORG_SAME_ORIGIN=true OA_ZKAPI_NETWORK=sepolia npm run build
OA_DEPLOYMENT_ORG_ORIGIN=https://org-staging.openanonymity.ai \
  OA_ZKAPI_NETWORK=sepolia node scripts/generate-zkapi-vercel-config.mjs vercel.generated.json
```

Select `mainnet` in both commands for the existing mainnet vault. The generator
keeps real verifier checks enabled. Supply the appropriate
`OA_WEBAUTHN_RELAY_URL` for an account-enabled deployment. Deployment operators
must keep frontend/auth return origins allowed by the chosen OA organization.
The generated config routes anonymous zkAPI protocol traffic separately from
the OA account/ticket endpoints. Mainnet funding uses real USDC and ETH.

`build.json` records the OA revision, SDK version and immutable revision,
network, protocol/artifact provenance, and emitted file hashes. Hidden files and
source maps are removed before hashing so the manifest describes files that
static hosts actually serve. Pin updates
must change the package dependency and lock together; floating SDK branch
references and local workspace dependencies are rejected by enabled builds.

## Application integration

The standalone entry uses `startChatApp()` from `chat/publicApi.js`, which
loads the native payment adapter only in a zkAPI-enabled build. It returns a
promise for the app. Existing synchronous `createChatApp()` retains its
original contract. A downstream app can use `startChatApp({ extensions, ... })`
without importing the SDK or implementing payment UI. `payments: false` or
`payments: { zkapi: false }` disables the native payment adapter; an explicitly
supplied custom runtime also retains ownership of its own payment policy.

The adapter preserves one OA proxy instance and one SDK wallet. Configuration
is supplied before initialization, using fixed host asset URLs. URL query
parameters cannot silently select a daemon or change the pinned network.
Anonymous protocol/configuration/manifest/daemon requests omit account cookies,
including calls through a same-origin reverse proxy and fallback transport.
The SDK never receives account identity, ticket contents, or chat messages.
Model inference stays in OA's provider adapter with the ephemeral credential.

## Persistence and behavior

Both payment methods use OA's existing chat database and model catalog. Mode
changes affect how the next key is acquired. A historical chat can change
methods without moving or replacing its transcript. Ticket access stays usable
while the prior private key settles in the background. The model list shows
ticket counts or compact minimum-balance badges and per-token prices.

Deleting a plain Tickets chat does not initialize or query the private wallet.
Private chat deletion checks its own pending key, including recovery markers
retained after a switch to Tickets. Delete-all explicitly checks the whole
wallet, including private owners that are not in the loaded sidebar page.

Private notes retain the SDK's original browser database, journal, Web Locks,
and BroadcastChannel names. Wallet secrets are separate from chat storage and
account synchronization. A new origin has separate browser storage: trial
history, tickets, and private balances do not automatically transfer there.
This source reorganization changes neither contract expiry nor withdrawal
behavior. Private balance expiry does not automatically refund unused funds;
the balance help/history continue to explain the deployed contract behavior.

## Funding setup

Funding onboarding shows MetaMask, USDC, and ETH prerequisites on mainnet,
with an expandable beginner guide to installation and MetaMask's Buy flow.
Both tokens must be on Ethereum Mainnet in the same account. The guide links
to official MetaMask help, explains provider/region-dependent purchase options,
and distinguishes chat funding from gas. Sepolia instead explains free test
ETH and automatic demo-token minting. The former mainnet warning banner has
been removed from the funding and welcome dialogs. The shared guide preserves
its expansion, focus, and scroll position across wallet refreshes; the funding
amount remains editable without refresh stealing focus in the `fund` view.

Sources for the onboarding copy:

- [Install MetaMask](https://support.metamask.io/start/getting-started-with-metamask)
- [Buy crypto in MetaMask](https://support.metamask.io/manage-crypto/move-crypto/buy/how-to-buy-crypto-in-metamask)
- [Sepolia faucets](https://ethereum.org/en/developers/docs/networks/#sepolia)

## Verification

Run `npm test` for the existing OA suite and the native payment adapter tests.
The SDK integration passed 744 OA tests and 164 native payment tests. The exact
dependency and lockfile also passed a fresh `npm ci` without Git/npm credentials
and with SSH disabled; the public GitHub package requires no private checkout.
The SDK repository tests its own wallet, recovery, transport, and proof-asset
boundaries independently, including installation without an OA checkout.
Live browser checks should cover both payment methods, new and historical
chats, model tier changes, settlement during a switch to Tickets, funding,
withdrawal navigation, and layout. Mainnet UI checks require no transaction.
