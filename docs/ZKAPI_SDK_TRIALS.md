# Native zkAPI SDK trial deployments — 2026-09-09

The application is now built by OA Chat, using the immutable public browser SDK.
OA Commercial and existing trial aliases were not changed.

| Network | New trial URL | App build |
| --- | --- | --- |
| Sepolia | https://oa-chat-sdk-sepolia.vercel.app/ | `YFMSCGYG` |
| Mainnet | https://oa-chat-sdk-mainnet.vercel.app/ | `GGSDG5UF` |

Both builds use OA Chat `63bed2b1d72e08293cd51c0e9c94b67eb9bb5f47` on
`codex/zkapi-browser-sdk` and SDK
`b188ab337d5a4888f19f7edbc296f94c320fff64` on
`codex/unified-chat-payment-modes`. The protocol pin remains
`b542b1bb0e18329bb3e646c5a51d67d4af9c60e2`. No main branch was merged or
pushed, and no force push was needed.

Immutable deployments:

- https://oa-chat-sdk-sepolia-oo33nuian-mingyech1.vercel.app/
- https://oa-chat-sdk-mainnet-48lcifsfl-mingyech1.vercel.app/

## Deployment checks

Each trial passed all 466 published artifact digests plus the build manifest,
including all five nested SDK asset hashes. Immutable manifests matched the
local committed-source builds. Root `/`, security headers, network/vault/token
pins, proof pins, protocol health, the public model catalog, and the staging
station/tier/ticket-issuer endpoints passed. Both Vercel error scans were empty.
Deployment environment handoff files were removed.

Same-origin OA routes target `https://org-staging.openanonymity.ai`; verifier
checks remain enabled, and the passkey relay is
`https://staging.openanonymity.ai/passkey-relay.html`. The two new stable trial
origins were appended to staging's `WEBAUTHN_ORIGIN` and
`GOOGLE_OAUTH_RETURN_ORIGINS`, preserving existing entries and the staging RP
ID. Immutable deployment origins were not added. No OAuth login or passkey
creation was performed.

## Automated and browser verification

- 744 OA tests and 164 native payment tests passed. The independent SDK passed
  185 tests; daemon/frontend validation passed 30 tests.
- A fresh install of the exact OA dependency and lockfile succeeded without
  Git/npm credentials, local Git configuration, an SSH agent, or usable SSH.
  All installed SDK files matched the pinned source.
- Tickets-only, Sepolia, and mainnet builds succeeded. Tickets-only emitted no
  SDK wallet/proof assets or wallet module inputs. Independent adversarial
  review approved the final code, including credential omission, scoped chat
  deletion, delete-all recovery protection, and deployment provenance.
- Desktop Chrome redeemed task-created staging invites on both new origins
  (eight Sepolia tickets and two mainnet-app tickets). The staging ledger
  confirmed redemption; temporary raw invite handoffs were removed.
- Both apps acquired ticket-redeemed ephemeral keys, verified station integrity,
  and completed live chat responses. Sepolia's Auto Router displayed the
  returned DeepSeek model. After switching to zkAPI and back to Tickets, a
  follow-up correctly recalled the marker from the earlier transcript.
- An unfunded switch to zkAPI opened funding on both apps. Mainnet showed real
  USDC/network disclosure; no mainnet wallet connection or transaction was
  initiated. The model list showed token prices and compact minimum-balance
  badges. Drafts, transcripts, and ticket composer controls survived switching;
  mainnet history also survived reload. Billing help opened successfully.
- The prior trial tabs, drafts, balances, and histories were preserved. A new
  origin has independent local storage; these trials do not import old notes
  or browser data automatically.

## Remaining live checks

MetaMask was locked at its password screen. The Sepolia funding attempt is
waiting for the user to unlock it; no deposit, new private key, or live
settlement/withdrawal was completed on these new origins. Those workflows have
SDK/runtime regression coverage, but the new deployment's complete funded
browser flow is not yet verified. Keep the Sepolia tab for continuation.

Live Tinfoil testing remains skipped as requested. The initial mainnet ticket
response triggered the default background Memory attempt and encountered the
known staging `Confidential key service not available` condition. The primary
chat succeeded; Memory was disabled for subsequent Sepolia testing, whose
browser error scan was empty. No Tinfoil credential was added.

Desktop layout was inspected. A requested temporary browser viewport override
did not change the extension's actual viewport, and was reset; this run does
not claim a completed mobile breakpoint check.
