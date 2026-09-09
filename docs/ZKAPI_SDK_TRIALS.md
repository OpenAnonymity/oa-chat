# Native zkAPI SDK trial deployments — 2026-09-09

## Current funding-onboarding update

The stable trial URLs now serve OA Chat
`f6423dd0424417685efaf6ea7441f4c3e9779e14`, with the same immutable SDK pin
`b188ab337d5a4888f19f7edbc296f94c320fff64` and unchanged payment contracts.

| Network | Current build | Immutable deployment |
| --- | --- | --- |
| Sepolia | `JM4LULVQ` | https://oa-chat-sdk-sepolia-7k54uwls7-mingyech1.vercel.app/ |
| Mainnet | `OS2TOXQL` | https://oa-chat-sdk-mainnet-d2aiui0ia-mingyech1.vercel.app/ |

The mainnet warning banner was removed and funding now includes a shared
MetaMask prerequisites/setup guide. Mainnet explains ETH, USDC and the Buy
flow; Sepolia explains free test ETH and automatic demo tokens. All 165 native
payment tests passed, including a regression check for pasted quotes in the
saved deposit amount. A fresh adversarial review approved the final source.

Each deployed trial passed all 466 public asset digests, the five SDK asset
digests, build/network/vault/verifier provenance, and staging org endpoint
checks. Both Vercel runtime error scans returned no logs. Desktop Chrome
verified the new prerequisites, expanded network-specific instructions,
official external links, removed warning, scrollable layout without horizontal
overflow, and preservation of the amount while collapsing the guide. Existing
chat history remained intact. No wallet connection or transaction was started
for this copy/UI verification.

The funded end-to-end results below describe the previous extraction builds;
the current update changes onboarding UI, not wallet or settlement behavior.

## Initial SDK extraction deployments

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

## Funded Sepolia browser verification

After the user unlocked MetaMask and completed the wallet deposit prompts, the
new Sepolia origin confirmed a $5 deposit. Browser checks then verified:

- A zkAPI response in an existing Tickets conversation retained the shared
  transcript and its earlier marker. Auto Router resolved to DeepSeek V4 Flash
  0731 after the response; the private estimate showed $0.007184, 1,539 input
  tokens, and 119 output tokens. Settlement confirmed the same $0.007184 usage.
  The estimator prefers a valid provider-reported cost over catalog token
  rates. The raw final SSE cost field was not separately inspected.
- Switching from zkAPI to Tickets settled the private key in the background.
  The ticket response completed at 22:31:26, before private settlement completed
  at 22:31:41 (browser-observed local times). The conversation continued from
  the same history. Returning to zkAPI retained the same private estimate;
  the intervening ticket response did not enter the private usage ledger.
- With $4.99 displayed as the remaining balance, selecting a model requiring
  `≥ $6` prevented key issuance and sending while preserving the draft.
- A new Luna zkAPI conversation acquired a key with a $1 cap and completed a
  response. Reload preserved the transcript and estimate, settled the prior
  key, and allowed another response with a fresh private key.
- Withdrawal automatically settled the current key before wallet confirmation,
  bringing total used balance to $0.00746. After the user confirmed MetaMask,
  the UI reported `$4.99 returned to MetaMask`. Payment history showed
  `Withdrawal · Mutual close` as `Returned` and the original `Deposit +$5.00`
  as `Added`.
- After withdrawal, reload showed `$0.00` and `not funded`, preserved both
  payment-history entries, and retained the two Luna responses and their
  $0.000274 chat estimate. Switching back to Tickets continued the same
  conversation and correctly recalled its marker. After the relay was
  explicitly re-enabled, that ticket response completed with `Connected`
  status and TLS-over-WSS transport; no new OA errors appeared.
- With the balance fully withdrawn, switching from Tickets to zkAPI
  automatically opened `Fund once, chat privately` with the deposit amount
  and `Continue with MetaMask` controls. The zkAPI switch was selected
  (`aria-pressed="true"`). No further deposit was started. The popup was
  closed and the app returned to Tickets; both trial tabs were preserved.

The public Sepolia RPC from the deployment manifest,
`https://ethereum-sepolia-rpc.publicnode.com`, confirmed both transaction
receipts with status `0x1`:

- Deposit: `0x009ffd6f2535789e2c699e54910b5183e8eabb0aa81981ac7982c769c58c6d1c`,
  block 11,665,917; 5,000,000 token base units transferred from the depositor to
  the pinned vault.
- Withdrawal: `0xbed167a542ddebf83e846e232c7e6d67f2066824c6e51fd6803ea76ddd494457`,
  block 11,665,989; 4,992,540 token base units returned to the same depositor,
  and 7,460 transferred to the server.

At six decimal places, the receipts reconcile the deposit exactly:
`$5.000000 = $4.992540 returned + $0.007460 usage`, excluding network gas.
The funded Sepolia flow is verified through deposit, private inference,
payment-mode switching, reload recovery, automatic settlement, mutual
withdrawal, and durable payment history, subject to the relay limitation below.

## Relay limitation and remaining live checks

During funded Sepolia testing, a relay connection to the OA verifier's
`/submit_key` endpoint failed with libcurl error 7. The existing OA transport
retried directly, and the System Panel's error listener automatically saved the
relay as disabled. Subsequent chat succeeded while the panel showed
`Proxy Unavailable — try again or use your own VPN` and `Enable relay`. No
fallback-consent prompt is required by this code path, so that state does not
establish that the user disabled the relay.

This behavior predates the SDK extraction: OA and the SDK share one
`networkProxy` instance, whose default `fallbackToDirect` is true. In
`chat/services/networkProxy.js`, a failed proxied request can immediately retry
directly; `chat/components/RightPanel.js` then disables the relay on a new error.
The disabled setting persists across reloads. The SDK's verifier submission
attempts this transport, whereas Tickets verification explicitly bypasses the
proxy. These browser checks establish functional recovery, not uninterrupted
relay protection. A follow-up should keep relay selection enabled after a
failure and require explicit consent before using direct transport.

Live Tinfoil testing remains skipped as requested. The initial mainnet ticket
response triggered the default background Memory attempt and encountered the
known staging `Confidential key service not available` condition. The primary
chat succeeded; Memory was disabled for subsequent Sepolia testing. Its initial
browser error scan was empty, before the funded flow exposed the relay failure
above. No Tinfoil credential was added. No mainnet wallet connection or
transaction was initiated.

Balance expiry and the escape-hatch withdrawal path were not exercised live;
the successful withdrawal above used mutual close before expiry.

Desktop layout was inspected. A requested temporary browser viewport override
did not change the extension's actual viewport, and was reset; this run does
not claim a completed mobile breakpoint check.
