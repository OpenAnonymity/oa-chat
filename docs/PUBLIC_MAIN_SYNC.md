# Public main production sync — November 15, 2026

This source update brings the production OA Chat client into the public default
branch. It is not a deployment of the commercial website or its backend.

## Source and scope

- Public-main baseline: `afd3ddd3f7d84f65fa569eabea7b11fcba9e2928`.
- Production client: `a20f2e043a7f43758b0fbfc521b01f63a3b98cb9`, verified against
  the production website's build manifest and its host's pinned client revision.
- Both histories are preserved by a merge. Existing public protocol-version
  support and the separate `oa-clientd` source remain; the daemon module and its
  authorization fixture are unchanged.
- Subscription, Stripe checkout, and commercial account interfaces remain in
  the separate commercial repository. The standalone client still starts with
  no commercial extensions.

The production changes include retry/resend recovery after model selection,
provider failures, browser storage recovery, encrypted ticket synchronization,
zero-data-retention routing and local usage history, along with the production
UI and private-payment fixes. Existing error reporting is retained.

## Exclusions

No staging branch is merged. Request-timing instrumentation, recorder/uploader,
build switches, browser daemon authorization, and staging-only feature rollouts
are excluded. The existing second protocol version remains pending with null SDK
pins. No staging vault activation, successor SDK dependency, or deployment profile
is imported. Production deployment profiles remain unchanged.

## Integration decisions

The public branch already had protocol-version support absent from the production
branch, so a direct merge conflicted with production wallet improvements. The
relevant existing conflict resolutions from `02b4917d` were reused only after
checking that those selected files were unchanged by its staging activation and
by subsequent production edits. Public main's later version-pill changes were
reapplied. No deployment configuration from that earlier integration was copied.

The SDK patcher preserves registry-driven selection and applies production's
ordered recovery, proof-cache, provider-verification, and server-time patches.
Both named and SDK-default build provenance record the complete applied chain.
The legacy wallet-store hash is updated to the reviewed production patch result.

The send gate preserves version cutoff checks while using production's trusted
server time for note and key expiry. Private-payment builds retain their own
verifier pin both with and without a named deployment; missing, conflicting, or
malformed pins fail the build instead of falling back to the ticket verifier.

## Source publication does not release the website

Keep `[preserve-deployments]` in the merge commit message. The unchanged
`vercel.json` ignore command returns zero for that marker, which tells Vercel to
skip the build. The ordinary unmarked case still returns one. See
[Vercel's ignoreCommand reference](https://vercel.com/docs/project-configuration/vercel-json#ignorecommand).

The commercial production and staging branches and their client pins are not
changed. Neither backend services nor Vercel project settings are changed.
This records repository-level safeguards; it does not claim an audit of every
external webhook. No push or deployment is performed while preparing this merge.

## Validation

Validated with Node 24.4.1, a clean `npm ci`, and the pinned `nanomem` submodule:

- Full client suite: **4,565 passed, zero failed, 18 skipped** (1,985 core,
  28 server-clock, and 2,552 native payment/protocol tests passed).
- Five builds passed: ticket-only, mainnet SDK defaults, Sepolia SDK defaults,
  mainnet `fresh-20260930`, and Sepolia `fresh-20260930`.
- Emitted private-payment artifact hashes, the full ordered patch provenance,
  verifier settings, and the single active protocol version were checked.
- Source and emitted artifacts contain no staging timing/browser-authorization
  markers. The daemon module, production profiles, and Vercel configuration
  remain unchanged.
- Independent adversarial review found integration defects in the optional
  verifier selection, missing-lease handling, and patch-provenance export; all
  were fixed and the full suite rerun successfully.

Two tests require Anvil and sixteen require an uninstalled successor SDK; these
are skipped, not passes. The unchanged Go daemon was not retested. No live
account, paid inference, payment, wallet-signing, or device acceptance test was
performed. These results establish a reviewed source-publication candidate,
not a new hosted production release.
