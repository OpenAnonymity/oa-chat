# App State and Handoff

This is the living handoff doc for the web app's current state. Use it to capture UI
behavior, coupled state, implementation gotchas, and lessons that are easy to miss when
reading code alone.

## 2026-09-03: Welcome back unlock preserves username login

- The Google encryption-keyring unlock uses the centered **Welcome back** card,
  an outlined **Unlock** action, a disabled **Waiting…** spinner during the
  passkey prompt, and **Try again** with an alert on failure. Setup and legacy
  migration share the card with their own copy and existing action handlers.
- The presentation change is scoped to `renderOAuthUnlockUI()`. The neutral Google/Username login,
  immediate landing-to-username passkey handoff, first-account Membership signal,
  saved legacy-account recovery, and muted footer focus remain intact.
- Escape and the compact close button dismiss the unlock card without
  decrypting data or signing Google out. The secondary **Log out** action
  remains available after a failed/cancelled passkey so a locked account can
  switch identities; it is disabled during an active operation. Successful
  unlock closes the card through the existing account lifecycle.

## 2026-09-02: Authentication intent waits for account restoration

- Returning focus to the account footer after unlock uses a thin, inset muted
  outline and subtle surface tint in both themes, not the heavy menu-item ring.
  Keyboard focus restoration is unchanged; forced-colors mode retains a stronger
  system-color outline. Keep this scoped to the footer, not other controls.
- The commercial landing page now hands Google entry to `/chat/?auth=google`;
  this is distinct from `membership=1`, which remains an explicit billing UI
  request. Core chat owns the one-use auth intent and removes it with
  `history.replaceState` after the initial authentication bootstrap settles.
- Initial account restoration has an explicit `authBootstrapComplete` state
  and `waitForAuthBootstrap()` gate. A remembered verified/unlocked account
  proceeds directly into chat; a verified locked account opens the encryption-
  passkey UI; and a genuinely signed-out account opens the Google UI. The
  signed-in Account summary is never opened by this route.
- The footer keeps stable compact geometry but renders no visible provisional
  identity until verification settles. A visually hidden live region announces
  account restoration to assistive technology. Opening the footer during that
  interval still shows the neutral restoration dialog; verified actions and
  commercial slots remain unavailable. The account-bound identity appears only
  when bootstrap completes, without caching it in `localStorage`. Profile
  refresh and encrypted sync continue in the background.
- Encryption-passkey errors are classified at the failing stage. Only a
  `NotFoundError` from `navigator.credentials.get()` becomes “passkey not
  available in this browser profile or private window.” A successful WebAuthn
  unwrap followed by IndexedDB failure instead reports that the key could not
  be saved. Once the durable key is stored, a later synchronization failure
  keeps the account unlocked and schedules restoration again; it must never be
  relabeled as a missing passkey.
- The footer restores its previous 49px total height at the user's request:
  a 3rem full-width trigger plus its 1px top border, for mouse and touch alike.
  The 1.75rem avatar and zero outer padding remain. The square-cornered trigger
  paints hover/focus/pressed feedback edge-to-edge; horizontal spacing lives
  inside it, and pressing does not scale it into an inset highlight. The
  sidebar reserves 3.5rem below its content so the restored footer still clears
  the last chat. The settings menu stays
  anchored to the footer row with 0.5rem side insets and 2.625rem rows.
  The settings gear, flat open
  trigger, menu typography, hover states, focus restoration, and keyboard
  navigation remain part of the contract.
- The build versions copied `styles.css` from its own SHA-256 content digest,
  independently of the JavaScript bundle hash. CSS-only footer updates must
  produce a new stylesheet URL even when executable bundles are unchanged;
  deployed stylesheets may otherwise remain browser-cached for hours.

## 2026-09-03: Pseudonymous username accounts use one authentication passkey

- First-time username setup shows **Setting up your account…** rather than
  redisplaying the username behind the native passkey prompt. The same neutral
  body spans passkey creation and finalization. A generated username keeps
  creation rendering active until close, even after sync publishes the new
  account ID; otherwise sync notifications could briefly show Account before
  the Membership handoff. Retry/error actions and returning login are unchanged.
- Username login centers **Log in**, keeps the close button at the upper right,
  and places Google directly above a joined **Username →** control with no OR
  divider. The arrow retains the accessible **Continue** name and the existing
  click/Enter handler; while busy it becomes a disabled spinner. Scoped CSS uses
  Chat's light/dark theme tokens, neutral autofill, and a 16px input. Saved
  account-number login keeps its existing layout. Google encryption unlock uses
  the Welcome back card described above.
  Username is an input placeholder with an accessible name, not a
  visible label or example handle. Introductory/helper copy and the separate
  signup/account-number rows are removed. Continue checks for a username
  challenge before reserving a new account; successful lookups reuse the
  challenge. Only typed lookup/registration errors select another flow, never
  passkey cancellation, network failure, or rate limiting. The button is
  single-flight and a close/reopen invalidates its pending lookup.
- The commercial landing page renders Username directly below Google and above
  the OR/access-code row. Both text rows share the same visual control rules,
  while independent handlers preserve the existing Google and anonymous
  access-code routes. The username route is a one-use local UI intent; Chat
  removes the username from its URL after the normal authentication bootstrap
  settles, then immediately starts the existing Continue/passkey flow. A neutral
  **Opening passkey…** view replaces the redundant second username form. Errors
  or cancellation restore the editable form; new-account setup retains its own
  retry UI. Missing usernames (including no-JS entry), unsupported/busy states,
  and remembered legacy/Google unlock or recovery still use their normal UI.
  The native prompt does not block the rest of Chat initialization. Startup composer autofocus also respects
  an open Account dialog, including its forced first attempt, so focus stays
  on the authentication surface rather than moving behind it.
- Account entry now offers Google or a normalized, unique pseudonymous
  username. Username registration and returning login use one WebAuthn prompt:
  the assertion authenticates the opaque OA account while PRF unwraps its
  random master key locally.
- The server-generated 16-digit account ID remains the WebAuthn user handle and
  all account/sync cryptographic scoping remains ID-bound. The username is only
  the human-readable passkey label and login locator; it is stored in local
  account settings so restored UI can display it immediately.
- Username accounts do not generate, display, or upload recovery material. The
  first passkey prompt completes registration immediately and emits
  `registerFirstAccountReady`, matching the first-time Google-to-Membership
  handoff. Losing every synced copy of the passkey is intentionally permanent;
  remembering the public username alone cannot prove ownership or decrypt data.
- Existing account-number clients and users remain supported. `/auth/init`
  still accepts no body, old request/response fields and recovery derivation
  remain unchanged, and a saved legacy account automatically receives the
  account-number login UI. Manual account-number entry on a fresh device is
  intentionally removed per the product decision; saved legacy login/recovery
  remains available and the backend protocol is unchanged.
- Username challenge and login responses must resolve to the account already
  saved on the device. Creating or switching to a different username requires
  the existing explicit **Forget saved account** action, preserving the same
  account-scope boundary as Google sign-in.
- Each username login carries an opaque, single-use challenge transaction ID,
  so concurrent public lookups cannot replace an in-progress passkey prompt.
  OA limits every attempt by the trusted client IP and adds a hashed-username
  bucket only after a failed lookup or proof; a third party therefore cannot
  exhaust a public-name quota and lock out a valid owner.
- The Continue action passes an explicit username into account preparation. Blank
  or invalid input fails validation and cannot fall through to the retained
  no-body legacy account-number initializer.
- Conditional auto-unlock also uses the username route for a saved username
  account. Falling back to the legacy opaque-ID route would authenticate but
  clear the local username label when settings are persisted.
- Usernames are visible stable pseudonyms; the compact login no longer displays
  pseudonym guidance. They never accompany ticket
  redemption or inference. See [USERNAME_PASSKEYS.md](USERNAME_PASSKEYS.md) for
  the protocol, compatibility, and privacy boundaries.
- Username accounts mark encrypted sync as identity-backed, like SSO accounts,
  so consuming a ticket does not trigger an immediate authenticated sync.
  The consumed/archive state propagates during the next initial or periodic
  sync; deletion tombstones remain reserved for cash-style transfers.

## 2026-09-01: Commercial onboarding and ticket surfaces use core UI seams

- A newly created Google account closes Account after passkey setup and emits
  `registerFirstAccountReady`; the commercial extension opens Membership and
  focuses its heading. Returning accounts close the authentication dialog and
  remain in Chat; they do not emit this signal. The signed-in Account summary
  is opened only by an explicit Account action.
- Avatar, account label, and settings affordance are one accessible sidebar
  button. There is no separate gear. Long labels truncate within the shared hit
  target. The new account identity and menu actions match the existing sidebar
  type scale at 14px regular; only an open/selected state uses medium weight.
  Existing chat-history typography is unchanged. Log out is separated from account actions and remains fully legible
  in both themes, with destructive color reserved for hover/focus.
- The public extension ticket capabilities no longer expose ticket export.
  Membership and standalone ticket management retain Import, Share, and Redeem.
  Account-data/chat/memory export remains independent and never includes
  inference tickets.
- The System Panel uses its original compact styling: a 14px semibold title,
  12px medium ticket/key headings, and the original icons, help buttons, and
  spacing. The larger September 3 heading redesign was reverted at the user's
  request; only the full-width theme-aware divider remains. It is positioned
  midway through the commercial stack's original 16px gap without adding
  layout height. Its anchor follows expanded ticket help and preparation
  status, so the line stays below that content. Live counts, zero-balance,
  pending/live keys, expiry/renewal, and per-key Council attestation remain
  unchanged. The compact bottom-left footer and stylesheet cache versioning
  are separate changes and are not reverted. Commercial ticket
  preparation mounts directly below the ticket row; component rerenders must
  reattach that extension slot through `refreshExtensionSlot(...)`, never an
  internal registry. Paid preparation uses the same compact text and progress
  bar presentation as ordinary ticket issuance, without a separate spinner.
  A commercial zero balance labels its action **Get tickets** only while an
  account is verified and unlocked; signed-out zero balances remain the neutral
  **Inference Tickets: 0** state.
- Paid preparation stages finalized tickets durably in the account/purchase-
  scoped recovery store, outside the live wallet, until the commercial
  controller has removed its completed progress state. The narrow public
  completion method revalidates the active account, imports that staged batch,
  then publishes the scoped aggregate UI/broadcast update and starts encrypted
  sync without exposing ticket records to the extension. This keeps every live
  ticket consumer behind the loading UI without making preparation durability
  depend on presentation. A per-account Web Lock is held through the completion
  fade and publication. Other tabs wait, then observe the owner's single
  aggregate update without replaying a second success panel; account changes
  release an uncommitted owner while leaving staged recovery intact. Once the
  live-wallet commit begins, external cleanup cannot release its lock; scope is
  revalidated after the durable write, and ready/imported/published recovery
  checkpoints make interrupted publication and cleanup idempotent.
- Commercial Membership inherits the public `--font-sans` token and stays on a
  compact 12/14/20/24–28px interface scale. Negative space groups automatic
  reload beneath the two bordered offers; it is not presented as another card.
- The chat search placeholder is **Search chats...**; shortcut space remains
  reserved at narrow sidebar widths.
- The signed-in account menu is a floating popover that spans the sidebar edge
  and overlaps the account/thread divider slightly. **Log out** uses the same
  neutral hover surface as the other account actions; destructive color is not
  used for hover emphasis.
- Its trigger remains a flat, full-width footer row while open, with the
  account identity on the left and a settings glyph on the right. It does not
  turn into an inset selected pill or use a disclosure chevron.
- A restored signed-in account reuses its account-bound cached identity label
  immediately after session validation. Profile refresh and encrypted sync
  continue in the background, so the footer does not briefly fall back to the
  generic **Account** label on every reload.
- Long conversation history settles its initial paint at the top position, then
  leaves scrolling completely free without snapping or delayed row visibility
  changes. A short gradient blur softens a partially visible conversation only
  while more history exists below, and a real trailing spacer remains in both
  full and virtualized lists. The last title can therefore scroll fully above the
  account footer. The account identity
  row and menu keep the existing 14px typography but use a stronger full-row
  neutral hover/focus surface.
- Explicit logout preserves the current device theme while account-scoped
  preferences and encrypted wallet state are deactivated. A Google-authenticated
  session that still needs its encryption passkey is labeled **Unlock encrypted
  data** in the sidebar instead of looking fully logged in. Closing the unlock
  dialog keeps Google authentication but never marks encrypted data or tickets
  unlocked; the Welcome back card explains that a passkey protects the data.
- The viewport permits browser zoom. Do not restore `maximum-scale` or
  `user-scalable=no`; authentication, Membership, and ticket recovery must remain
  usable under magnification.
- The public entitlement preparer accepts an issuer response whose `key_id` is
  absent for rollout compatibility, while still deriving the key ID locally and
  rejecting any advertised value that does not match. Monthly rotation may
  therefore discard stale unsigned recovery without weakening issuer binding;
  the commercial extension immediately restarts the paid allowance.

## 2026-09-01: Browser Back cancels unpaid ticket-bundle Checkout

- Ticket-bundle Checkout now stores the exact Stripe Session and initiating
  billing scope in its tab marker, matching the subscription return boundary.
- A full navigation return or BFCache `pageshow` clears **Opening Checkout…**
  and asks oa-org to cancel that exact unpaid bundle automatically. A confirmed
  payment still wins the race and proceeds into private ticket preparation.
- A definitive unpaid return restores **Membership** with both purchase
  actions enabled and no cancellation notice. Subscription and ticket-bundle
  returns now share this behavior for browser Back and Stripe cancel URLs.
- The modal is made visible synchronously when the exact tab marker is detected,
  before account readiness and server cancellation. Purchase actions remain
  briefly disabled, so a cold ticket-bundle return cannot flash the chat shell
  or start a second Checkout while the payment race is unresolved.
- This temporary purchase lock is independent of ordinary modal `busy` state.
  It survives close/reopen and respects a modal the user leaves closed. An
  unresolved payment or transient cancellation error may hide Membership while
  presenting **Check status**, but it keeps the purchase lock until that exact
  Checkout resolves. An account/readiness change clears the lock and exact tab
  marker without sending the old Checkout Session under the new identity.
- `checkout_pending` no longer renders **Continue Checkout** or **Cancel
  Checkout**. An exact ticket-bundle return keeps the normal disabled purchase
  action in place and shows no transient cleanup copy. Marker-less durable
  recovery is also silent; cancellation and retry status remain owned by the
  navigation-return flow.
- Scope-less, mismatched-account, and mismatched durable records fail closed
  without sending the Checkout Session ID across account partitions.
- Paid-success reconciliation uses the same current/marker/durable scope
  validation before submitting the Session ID. Loopback demo cancellation and
  its **Check status** retry require the exact demo scope but not an Account ID.
- A stale marker-less top-up recovery no longer strands Membership without a
  button. Startup or Membership refresh schedules cleanup of only the exact
  durable Session stored under the current billing scope. The same tab and
  legacy records use a two-minute grace; new records bind a random local
  owner-tab ID, and a different or restored tab waits until 31 minutes, after
  oa-org's fixed 30-minute Checkout lifetime. Matching live tab markers remain
  owned by their return flow. Payment still wins a cancellation race, and
  loopback demo scopes participate without an Account ID.

## 2026-08-31: Browser Back cancels unpaid subscription Checkout

- The commercial subscription flow saves its exact Stripe Checkout session ID
  and initiating account scope in tab-scoped storage in addition to durable
  account-scoped recovery.
- Returning to chat in that tab without a Stripe outcome, including a BFCache
  `pageshow`, clears the transient **Opening Checkout…** state and asks oa-org
  to cancel that exact Session automatically. It never cancels from unload or
  guesses a Session from another tab/account.
- The tab marker scope must match the active account and any durable recovery
  scope before the Session ID is sent. Mismatched or legacy scope-less markers
  are cleared and fail closed without crossing account privacy partitions.
- oa-org remains authoritative for the payment race: confirmed payment proceeds
  to ticket preparation, a pending result keeps retry recovery, and only a
  confirmed cancellation restores Membership. No cancellation banner is shown.

## 2026-08-31: One-trip Desktop Google and encryption-passkey handoff

- Desktop-capable clients request flow version 2; oa-org explicitly negotiates
  it behind a disabled-by-default gate, so existing clients and deployments
  retain the custom-protocol plus separate-passkey flow.
- The stable HTTPS relay keeps its random loopback port and nonce in tab-scoped
  storage while the same tab travels through Google. oa-org returns opaque
  one-use OAuth and passkey-context tokens in a fragment, which the relay removes
  before consuming the context without cookies.
- Touch ID evaluates the WebAuthn PRF in that browser tab. The PRF output goes
  only to the local Desktop loopback listener; oa-chat validates the credential
  against the authenticated account keyring and wraps or unwraps the master key
  locally. oa-org never receives the PRF result or plaintext master key.
- Passkey failure falls back to the established Desktop unlock UI after OAuth;
  state, PKCE, exact-origin validation, and account continuity remain fail-closed.

## 2026-08-31: Staging Desktop encryption-passkey relay

- `/passkey-relay.html` is a static, same-origin WebAuthn bridge for OA
  Desktop. It receives the one-use nonce, random `127.0.0.1` callback port,
  operation, and serialized public-key options in the URL fragment, removes
  that fragment immediately, evaluates WebAuthn in the system browser, and
  form-posts the result only to the loopback listener.
- The legacy passkey-only route never calls oa-org. The combined route consumes
  only its one-use, sanitized context; neither route logs or transmits the
  WebAuthn assertion or PRF output. Desktop must still validate both the HTTPS
  relay origin and one-time nonce.
- `OA_WEBAUTHN_RELAY_URL` selects the exact relay page at build time and is
  recorded in `dist/build.json`. Staging Desktop packages must use the stable
  Vercel origin that also appears in oa-org's `WEBAUTHN_RP_ID` and
  `WEBAUTHN_ORIGIN`; the production relay remains the default.
- See [DESKTOP_PASSKEY_RELAY.md](DESKTOP_PASSKEY_RELAY.md) for the full handoff
  and packaging contract.

## 2026-08-30: Native desktop browser sign-in

- `accountService.authenticateWithOAuth(...)` uses the ordinary popup flow in
  browsers and the Electron preload handoff in OA Desktop. Both paths converge
  on the same Google session record and encryption-passkey setup/unlock logic.
- Desktop preserves a saved OA account ID while signed out and sends it as an
  OAuth account-binding check. The signed-out Account dialog exposes **Forget
  saved account** so switching Google identities requires an explicit local
  reset instead of silently replacing the account or weakening the check.
  Rendering that recovery action uses the privacy-safe
  `hasSavedAccountBinding` boolean (and the categorized mismatch failure as a
  fallback), so it does not disappear merely because no account identifier is
  visible in the signed-out UI.
- The renderer-facing `sessionService` API is unchanged. Electron owns PKCE,
  custom-protocol callback handling, rotating SuperTokens header credentials,
  refresh/retry, and encrypted persistence; oa-chat never receives a token.
- Desktop account traffic remains restricted to the configured org origin's
  `/auth/*` and `/api/billing/*` routes. Public ticket redemption/inference
  requests do not pass through the identity session bridge.

## 2026-08-24: Live ticket pricing and non-blocking relay fallback

- Key acquisition waits for the live model-ticket map before selecting tickets,
  including the synthetic `openrouter/auto` price. A failed refresh remains
  retryable and fails the send clearly instead of redeeming cached or heuristic
  ticket counts; stopping a send also cancels this wait promptly.
- If the encrypted relay fails, only that request retries directly. No
  account-scoped proxy preference is written, so an account sync lock cannot
  leave the UI stuck on `Requesting ephemeral key`, and later requests still
  retry the relay instead of remaining silently direct.

## 2026-08-14: Public core and private commercial composition

- Stripe presentation, Checkout orchestration, top-up state, and subscription
  UI now live in the private `oa-commercial` composition. Standalone `oa-chat`
  contains no billing modal, Stripe client, pricing copy, or upgrade CTA.
- `chat/publicApi.js` is the only supported downstream import. Extension API v2
  provides four isolated UI slots and narrow account, public-org, ticket, and
  UI capabilities; downstream code must not import oa-chat internals.
- Component rerenders refresh extension hosts through the narrow
  `refreshExtensionSlot(name)` UI-facade method. Do not reach through the
  component facade for `extensionSlots`: that registry is intentionally not
  exposed, and doing so silently drops mounted commercial controls when a
  modal replaces its contents.
- The public entitlement preparer retains the privacy-sensitive browser work:
  blinding, issuer-generation validation, strict response allowlisting,
  unblinding, crash-safe IndexedDB recovery, and durable ordinary-wallet
  import. This keeps the unlinkability boundary auditable in the public tree
  without placing commercial product logic there.
- The existing `oa-billing-local-v1` IndexedDB name is intentionally retained
  so a pending preparation survives the extraction. The record format is
  generic entitlement state and final wallet tickets contain no account,
  payment, subscription, or claim metadata.
- At the time of the public/private extraction, account registration was
  Google-only. The 2026-09-03 username-passkey entry above supersedes that
  sign-in limitation without changing the extension boundary.
  A commercial extension observes only the sanitized account snapshot and can
  resume an upgrade after the verified session becomes ready; Account itself
  has no Checkout-specific callback.
- A composition mounted below `/` passes `routeRoot` to `createChatApp`.
  Ticket-code path cleanup and generated shared-chat links use that root, so a
  refresh cannot fall back to the composition's separate landing document.
- Same-origin production builds replace the production-org fallback at compile
  time and remove the now-bundled raw `services/orgEndpoints.js` copy. The
  build scans every published JavaScript file for that hostname, so an inert
  source copy cannot silently weaken the disposable-demo isolation claim.
- `createChatApp({ welcomePanel: false })` lets the commercial composition
  suppress both legacy invite/free-access ticket panels: the first-run Welcome
  modal and the post-ticket Thanks/no-tickets modal. The standalone public
  default is unchanged. Guard both branches when changing ticket-startup logic;
  otherwise an authenticated commercial account that once held tickets can
  unexpectedly fall back into the old invite-code flow.
- A disposable same-origin verifier-bypass build may use a credential-free
  alternate Wisp endpoint through `OA_DEMO_PROXY_URL` when the ordinary relay
  is unavailable. Production builds retain the normal relay. Same-origin demo
  API requests have a ten-second hard timeout so an unresponsive WASM
  transport closes and enters the existing visible direct-fallback path
  instead of hanging forever. Provider inference streams remain unbounded.
- Vercel demo config repeats the non-secret compile flags in `build.env`, and
  the disposable project should store the same Production variables. A build
  can otherwise succeed under a project-level command override while silently
  retaining the production-org endpoint. Handoff must inspect the emitted app
  bundle for both absence of that endpoint and presence of the demo relay.
- The commercial composition now uses a three-panel, self-hosted-Newsreader
  landing page from `oa-commercial/feature/pre-chat-landing`, originally
  reconciled with the reviewed Google-only account handoff. The Account modal
  now adds a recovery-free username passkey path; Apple and access-code
  authentication alternatives remain absent. Its Premium modal keeps server-owned
  subscription/top-up prices and eligibility, exposes Customer Portal and
  ticket-pack actions when status authorizes them, and adds a collapsed ticket
  explanation without hard-coding model costs.

See [EXTENSIONS.md](EXTENSIONS.md) for the supported contract. The Premium
entries below describe the pre-extraction implementation history; the current
commercial behavior is documented and tested in `oa-commercial`.

## 2026-08-07: Disposable Demo Same-Origin Routing

- Normal production builds still target `https://org.openanonymity.ai`.
  Disposable Vercel builds must compile `OA_ORG_SAME_ORIGIN=true`; account,
  billing, ticket, and sync calls then use the exact frontend origin.
- `scripts/generate-demo-vercel-config.mjs` validates an HTTPS oa-org tunnel and
  creates deployment-only rewrites for `/auth/*`, `/api/*`, and `/chat/*`
  before the SPA fallback. Do not commit a rotating tunnel hostname or expose
  backend/provider secrets as frontend variables.
- Deploy the disposable Vercel project with `vercel deploy --prod` and use its
  stable production hostname for SuperTokens, WebAuthn, Google OAuth, and
  cookie origins. Preview hostnames rotate and cannot satisfy that fixed
  identity/callback contract.
- A disposable station that is absent from an isolated verifier may compile
  `OA_DEMO_VERIFIER_BYPASS=true` only with same-origin HTTPS routing. The build
  rejects production OA hostnames, points no request at the production
  verifier, labels the result as an unverified demo bypass, and prevents access
  sharing. This is an explicit test-only privacy/assurance deviation requiring
  user acceptance; omit it when an isolated verifier is available.
  The guard rejects `openanonymity.ai` and every subdomain, not only the known
  production frontend names, so a demo-bypass artifact cannot be hosted under
  any OA production namespace.
- Same-origin builds strip the production-org DNS prefetch from built HTML.
  The production build keeps that hint. `scripts/build.mjs` must preserve the
  tracked `chat/nanomem` symlink rather than copying over it and dirtying the
  source tree.

Packaged OA Desktop builds may instead set `OA_ORG_ORIGIN` to an exact HTTPS
oa-org origin. This is mutually exclusive with disposable same-origin mode and
is recorded in `dist/build.json`; the Electron main process independently
allowlists that origin before storing or attaching any account credentials.
- Immutable station archives still need an empty, secret-free `station/.env`
  marker (`root:root`, mode `0444`) before service start, even when systemd
  provides the real protected environment file. See the run record before a
  clean redeploy; omitting the marker causes a restart loop.

See [DEMO_DEPLOYMENT.md](DEMO_DEPLOYMENT.md) for the deployment contract and
[DEMO_ENVIRONMENT_2026-08-11.md](DEMO_ENVIRONMENT_2026-08-11.md) for the
secret-free record and teardown targets of the integrated disposable run.

## 2026-08-07: Monthly Premium Ticket-Key Epoch

- Premium renewal and the global Privacy Pass ticket generation share the
  first-of-month 00:00 UTC boundary in oa-org. This must remain a global epoch,
  not a per-account rotation: every subscription and invitation ticket uses the
  same unlinkable issuer public key, and rotating it invalidates all earlier
  generations immediately.
- The Redis epoch marker includes both the UTC billing month and Stripe mode.
  Changing a deployment from test to live rotates under the ordinary global
  fence even within the same month, preventing sandbox-issued tickets from
  crossing into live billing resources.
- `BillingClient.runPreparation(...)` verifies the current RFC 9578 public-key
  ID before generation, at the signed/finalization transition, and immediately
  before durable wallet import. The same expected key ID is sent with the blind
  claim so oa-org's generation fence can reject a rotation race before signing.
  `BILLING_ISSUER_ROTATED` deletes the obsolete account-scoped pending record
  and asks the user to retry the current allowance.
- Pending records without `issuerFingerprintVersion: 2` use the pre-integration
  hash-of-base64 convention. Accept one only when that legacy hash matches the
  currently fetched key, then persist the RFC key ID and version before any
  further recovery work; otherwise an already consumed signed allowance could
  be discarded during upgrade.
- An exact boundary race remains recoverable: oa-org rotates before reservation
  and signing, and the claim completion transition is also atomically fenced
  on the same key/month. Requests blinded to the old key fail without consuming
  the entitlement; an issuance counted immediately before rotation is rolled
  back, and the next browser attempt regenerates. Keep the issuer fingerprint
  local-only and never add billing or account metadata to finalized tickets.
- Invitation/ticket-code issuance and request-key, confidential-key, and split
  redemption use exact-batch server replay records. Client retries must reuse
  the identical serialized blind/ticket batch so a lost HTTP response cannot
  consume a one-use credential, tickets, or an ephemeral key irrecoverably.
  Ticket codes created by splitting are bound to their source key generation
  and billing month so they cannot carry an allowance across rotation. The
  split response carries that UTC month-end expiry and the right panel displays
  it beside the one-show code.
- oa-org keeps an owner-fenced, exact-request ticket-spend lease before any
  downstream one-show key/code side effect. A crashed worker can be resumed by
  the identical ticket batch; a completed request leaves a tombstone longer
  than the spent-nonce record. After the secret replay window expires, the UI
  must treat the request as completed/unrecoverable rather than trying to reuse
  or release those tickets.

The active lifecycle is documented in `oa-commercial/docs/BILLING.md`.

## 2026-08-05: Premium $7 / 50-Ticket Top-Ups

- The Premium modal renders the one-time pack only when both public
  `plan.ticket_pack` exists and authenticated `status.ticket_pack.eligible` is
  true. Price and count are server data; ineligible and signed-out users see no
  pack copy or action.
- Checkout recovery is now version 3:
  `sessions[accountScope].subscription` and
  `sessions[accountScope].topup` are independent. Version-2 and legacy records
  migrate into the subscription slot. Reconciliation, clearing, frozen auth,
  and account-switch abortion are scoped to both account and purchase kind.
- A top-up claim is an explicit 50-ticket operation. Local IndexedDB recovery
  adds `source: "topup"`, `claimRef`, and `targetCount: 50`; the claim request
  sends that reference, while finalized wallet records retain the same four
  ordinary ticket fields. The reference must never enter exports, shares,
  redemptions, tickets, or logs.
- If oa-org has committed a claim and reports the pack `ready` before staged
  ticket publication finishes, the pending local record projects browser state back
  to `claiming` and disables another purchase. That override is cleared only
  after durable wallet write/read-back and archive-precedence verification.
- Top-up and subscription work share the existing account-scoped Web Lock,
  frozen authentication context, ten-ticket chunks, strict response allowlist,
  and account-switch abort behavior. A claimable pack takes precedence over an
  older implicit subscription entitlement, because only it has the explicit
  `claim_ref`.
- Stripe return values are distinct (`topup_success` / `topup_cancelled`). A
  successful return prepares the pack automatically. A canceled return uses the
  session ID saved by that specific tab in `sessionStorage`; it never guesses
  from the durable account slot, so an old tab cannot cancel a newer Checkout.
- `checkout_pending` has no manual Continue or Cancel controls. Returning with
  browser Back in the opening tab cancels the matching unpaid Session
  automatically; tab close, crash, and connectivity loss preserve durable
  recovery. Stripe expiration and status reconciliation clear older unpaid
  records, while payment winning a cancellation race proceeds to normal
  50-ticket preparation.
- Checkout recovery and durable IndexedDB claim/import recovery remain separate.
  No unload/beacon/tab-close cancellation exists, and the tab-scoped session ID
  never enters sync, exports, wallet state, tickets, or logs. Purchase fills the
  ordinary wallet and does not redeem a ticket or alter issuer-key rotation.

The active contract and privacy boundary are documented in
`oa-commercial/docs/BILLING.md`.

## 2026-07-31: Stripe Premium and Genuine Ticket Issuance

- The sidebar has one adaptive entry: signed-out users see `Register and upgrade`; any local
  account changes it to `Account` without a reload. Free accounts get an
  `Upgrade to Premium` action in Account, and subscribed accounts get
  `Manage billing`. Logging out restores `Register and upgrade`.
- `Register and upgrade` opens the public Premium modal without requiring an account, while
  starting Checkout routes through account creation or sign-in and resumes
  exactly once afterward. The initial Welcome screen uses the same
  `Register and upgrade` entry. Explicitly
  cancelling the account step clears the session-scoped Checkout intent and
  returns to Premium. Public price and interval data come from oa-org's
  Stripe-validated `/api/billing/plan`; the UI does not hard-code the amount.
  A failed plan request shows `Price unavailable`, offers a retry, and removes
  the Checkout action until a validated price and allowance are loaded.
- Stripe success and saved-Checkout recovery wait for account initialization
  and SuperTokens verification before reconciliation. Components mount before
  `accountService.init()`, so billing must not interpret the initial
  `sessionVerified=false` state as an authenticated user having signed out.
  Explicit Checkout cancellation remains pending until the account scope is
  settled; it must not time out into generic saved-Checkout recovery.
- Signed-out registration currently exposes Google SSO only. Legacy direct
  passkey creation, account-number passkey login, and recovery-code entry points
  remain compatible in the service layer but are intentionally absent from the
  registration picker. Google-first accounts still create or use an encryption
  passkey after OAuth because that passkey protects synced ciphertext locally.
- Checkout, status, portal access, and paid claims use `BillingAuthProvider`.
  Local development may create a random identity only when both oa-chat and
  oa-org are loopback. Non-loopback deployments require the account adapter.
  Pending Checkout reconciliation is stored under that billing scope and resumes
  after reload only for the same identity.
- A full paid period creates a 300-ticket entitlement. The initial payment and
  allowance may be prorated to a smaller positive count. A claim sends exactly
  `next_claim_ticket_count` browser-blinded requests to the existing org issuer;
  no alternate RSA or demo issuer exists in oa-chat.
- Pending generation, signed responses, and finalization live in the separate
  local-only `oa-billing-local-v1` IndexedDB database. Work is persisted every
  ten tokens, survives reload, is scoped to the active billing identity, and is
  intentionally excluded from settings sync and export.
- Paid preparation freezes one authentication scope, holds a scope-specific Web
  Lock across the complete operation, and fails closed if Web Locks are
  unavailable in a browser. Account switches abort without deleting the old
  scope's recovery state.
- The ordinary ticket wallet receives only `blinded_request`,
  `signed_response`, `finalized_ticket`, and `created_at`. Redemption continues
  through the existing accountless endpoints and sends no billing metadata.
- Recovery state is cleared only after a strict IndexedDB write and read-back
  confirms every finalized ticket. Claim responses are field-allowlisted before
  finalization, so server-provided billing or finalized-ticket metadata fails
  closed.
- Checkout recovery is stored per account scope and uses frozen authentication;
  stale status responses are discarded after identity changes. Ticket recovery
  treats active and archived wallet records as imported, preserving archive
  precedence so a spent ticket is never resurrected.
- One available allowance is prepared automatically per billing activation and
  entitlement identity. Subscription auto-preparation is keyed by
  `current_period_end`, so a tab that survives into the next paid month can
  prepare the new period; top-ups remain keyed by `claim_ref`.
  Additional accumulated allowances require an explicit action labeled with
  the next server-provided count. The modal intentionally omits server allowance
  counters such as `Current paid allowance`; those are not browser wallet counts.
  See `oa-commercial/docs/BILLING.md` for the extracted implementation.

## How Agents Should Use This

1. Read this file before changing UI-heavy or stateful parts of the app.
2. Read any more specific doc in `docs/` that matches the feature area you are touching.
3. After meaningful work, update this file or the feature-specific doc with what changed,
   what was learned, and any non-obvious behavior the next agent should know.

If a lesson belongs in a dedicated feature doc, add it there and leave a short pointer in
this file so future agents can find it quickly.

## What To Record

- Subtle UI expectations or interaction rules that are not obvious from reading the code.
- State coupling across components, services, persistence keys, or responsive layouts.
- Known constraints, sharp edges, and regression risks discovered during implementation.
- Follow-up work or unresolved questions that the next agent should evaluate.

Keep entries concise and factual. Prefer short bullets over long narratives.

## Current Notes

- 2026-08-30: Math rendering accepts conservative single-dollar inline delimiters.
  - `chat/services/mathRendering.js` is the shared KaTeX entry point for chat,
    reasoning, Quick Ask, navigation, and share previews. Keep new message
    surfaces on this helper so delimiter behavior does not drift.
  - Gemini can return `$...$` despite the system prompt requesting `\(...\)`.
    Text normalization protects valid single-dollar pairs before Markdown
    parsing, while code/preformatted content, escaped dollars, ordinary prices,
    and price ranges such as `$5-$10` remain literal text.

- 2026-08-30: The user's explicit Chat/Parallel composer choice now persists in
  the versioned `parallelModePreferenceV2` setting alongside the remembered lane models. A fresh chat or
  newly opened tab/window starts in Parallel when Parallel was the last chosen
  mode, and starts in Chat after the user switches back. Opening the view alone
  never sends a request or spends tickets. Legacy mode flags are deliberately
  ignored, and changing a lane/review model does not overwrite a newer explicit
  mode choice from another tab.

- 2026-08-11: Each chat session's sidebar options menu has an `Export as Markdown`
  action. It reads that session directly from local IndexedDB without switching the
  active chat, preserves message Markdown, and replaces user/model images and other
  attachments with readable placeholder lines instead of embedding binary data URLs.
  Exported messages use explicit plain-text delimiters with shared conversation turn
  numbers (`--- User turn 1 ---`, `--- Assistant turn 1 ---`). These remain literal
  text under CommonMark, which keeps them visible and deterministic for text parsers.
  Delimiter-shaped lines inside message content are prefixed with a Markdown backslash
  escape so they cannot be mistaken for transcript boundaries in the source file.

- 2026-08-04: Plain `Cmd/Ctrl+F` uses an app-owned find-on-page toolbar instead
  of the browser's native find UI, so a forgotten find field cannot retain
  keyboard focus after the user returns to the app. The toolbar follows standard
  next/previous, `Enter` / `Shift+Enter`, `Cmd/Ctrl+G`, `Escape`, close-button,
  and click-away behavior. It auto-dismisses after 10 seconds without find
  activity and restores the previously focused input when dismissed by timeout,
  Escape, or its close button; clicking elsewhere preserves the user's new focus.
  If that return target becomes unavailable (for example, a modal opens), focus
  moves to an eligible text control in the active dialog and never remains in the
  hidden find toolbar. True modal dialogs take precedence over visible non-modal
  `role="dialog"` surfaces such as quick ask. Tabbing out also dismisses find
  without later focus theft.
  Matching can span adjacent inline Markdown nodes and uses original-string
  offsets so Unicode case folding cannot create invalid DOM ranges.
  The deadline is rechecked when the tab/app becomes visible or focused so
  background timer throttling cannot leave a stale find toolbar open.

- 2026-08-07: The public chat shell now has an optional versioned extension seam.
  - `chat/publicApi.js` exposes `createChatApp`, extension API version 2, and
    stable slots including `sidebar.accountActions`, `account.menuActions`,
    `account.commercial`, `welcome.actions`, and `modalLayer`.
  - The sidebar footer remains core-owned. Signed-out users see Account;
    verified sessions see the available account or SSO email identity (or Account fallback).
    The full identity row opens a menu containing Account & security, extension
    actions, and Log out; there is no separate gear. The menu restores focus on
    Escape and supports arrow/Home/End keys.
  - The Account dialog ignores backdrop clicks so an accidental click beside
    the card cannot dismiss it. Its close button remains the explicit pointer
    action, while Escape remains available for keyboard users.
  - `account.menuActions` is the preferred commercial membership entry. It
    exposes no billing state or credentials to the core; older sidebar and
    account-modal slots remain available for compatible integrations.
  - Standalone startup passes no extensions. Empty slots are invisible and the
    public Account UI remains fully functional.
  - Account modal rerenders recreate their slot host and ask the slot registry
    to reattach the existing extension-owned node. Extensions must never query
    or import internal component/service implementation details.
  - Client-side entitlement ticket blinding/finalization remains public through
    `application/entitlementTicketPreparer.js`; downstream integrations supply
    the authorized count and claim operation.
  - Paid integrations can attach only `subscription` or
    `topup:<64-hex-reference>` as local claim-recovery context. Reload recovery
    reuses that saved context when invoking the blinded-claim callback. It stays
    in the separate recovery record and never enters finalized tickets, wallet
    exports, shares, redemptions, logs, or progress snapshots; progress exposes
    only a redacted `subscription` or `topup` source.

- 2026-07-31: Ticket signing-key rotation is an immediate invalidation
  boundary.
  - Every newly redeemed ticket stores the global RFC 9578 `token_key_id` as
    `ticket_key_id`. Legacy/imported tickets are normalized by extracting the
    same 32-byte field from the finalized token in
    `chat/domain/ticketKeys.js`.
  - Org ticket errors are unwrapped from FastAPI's structured `detail`. On
    `TICKET_KEY_INVALIDATED`, `TicketStore.consumeTickets(...)` atomically
    deletes every active or archived local ticket with `invalidated_key_id`
    and leaves tickets from newer generations untouched. Deleted generations
    cannot reappear through export or sync: the local, union-merged
    `tickets-invalidated-key-ids` list filters local loads, imports, and
    incoming sync blobs. Sync publishes one encrypted append-only record per
    invalidated generation (plus the legacy aggregate migration record), so
    concurrent devices cannot lose distinct tombstones through the org's LWW
    blob store. Account-data transitions and sync merges share the outer
    `oa-sync` Web Lock; local ticket mutations take their narrower ticket lock
    inside that boundary. This nesting prevents local/remote unions and account
    switches from overwriting each other. Sync schema v2 performs one full pull after upgrade
    so records skipped by older clients are rediscovered. Tombstones contain
    only global public-key fingerprints, never tickets or identity metadata.
    Never infer a batch from invite metadata or timestamps; the embedded
    public-key fingerprint is the grouping authority.
  - `acquireSessionAccess(...)` automatically retries when enough tickets from
    another generation remain. Otherwise it tells the user that the org
    rotated its key and that a new invite must be redeemed. The
    `ticket-key-invalidated` window event drives the seven-second removal toast.
  - Invite issuance binds each blinded batch to the public `key_id` fetched by
    the client. If rotation wins before issuance is committed, the org restores
    the single-use credential reservation and returns `TICKET_KEY_CHANGED`;
    the client tells the user the invite was not consumed and can be retried
    against the newly fetched public key.
  - The key ID is a shared public-generation fingerprint, not identity
    metadata. It stays in the user's local ticket store and does not weaken the
  blind-signature unlinkability boundary.
- 2026-08-04: Account session refresh is owned by SuperTokens. See
  [Account Sessions](ACCOUNT_SESSIONS.md). Browser requests use HttpOnly cookie
  mode; Electron renderer requests use the same `sessionService` API but run the
  SDK in the isolated desktop preload with header-mode tokens encrypted by the
  main process. Keep access/refresh tokens out of OA response bodies,
  IndexedDB/localStorage, renderer APIs, and hand-written `Authorization`
  headers. `encryptedSyncService` retains only non-extractable client-side
  derivation keys and relies on
  the SDK's automatic refresh/retry. Keep both the SDK interception override and
  `sessionService.fetch(...)` restricted to the org `/auth` and `/api/billing`
  account paths. Premium claims belong inside this identity boundary because
  they authorize paid blinded issuance; accountless redemption, request-key,
  sharing, and model paths must remain outside it.

- 2026-08-04: Local oa-org inference can bypass the external verifier only when
  both the oa-chat page and configured oa-org URL use exact loopback hostnames.
  The access proof is stored as `local-loopback-bypass`, not `verified`; the
  same credential is discarded on non-loopback startup and cannot enter shared
  access payloads. Ordinary Chat and Parallel/Council use the same policy.

- 2026-07-31: OpenRouter catalog labels for Anthropic models are normalized to
  include the `Anthropic:` prefix when upstream omits it. Already-prefixed names
  remain unchanged.
- 2026-07-16: Parallel/Council share and provider-display rebase notes.
  - Shared chat payloads serialize `responseMode` and `councilConfig`, and both
    first import plus update-import paths restore those fields. Otherwise imported
    Parallel/Council transcripts render old aggregate messages but silently continue
    as single-model chats.
  - Parallel/Council composer and response labels should use catalog provider
    metadata or `resolveProviderFromModelReference(...)` for explicit provider
  prefixes/model IDs. Do not infer providers from bare model-family words such
  as Llama, Gemini, Claude, or Nemotron; bare names should fall back to neutral
  initials when catalog metadata is unavailable.

- 2026-08-17: Insufficient-ticket preflight exposes a redacted commercial hook.
  - After synchronized budget calculation blocks a send or regeneration,
    `context.tickets.registerShortageHandler()` receives only aggregate
    `availableTickets` and `requiredTickets` counts. Prompts, model identities,
    Memory context, sessions, and account data stay inside core.
  - The original inference request remains unsent. A commercial build may use
    this user-initiated event to start an already-consented refill or show an
    explicit purchase surface without risking a duplicate model request.
  - Signed-in preflight never treats the temporary pre-sync balance as a
    shortage. It asks the user to wait for ticket loading (or unlock) and does
    not notify the commercial handler until account scope and ticket sync are
    ready.

- 2026-08-17: Commercial Checkout recovery can render beside the public ticket count.
  - `rightPanel.ticketStatus` is a generic extension slot below the compact
    Inference Tickets launcher. Core owns its location and reattaches mounted
    nodes after each top-section rerender; it contains no billing copy or state.
  - The commercial extension sends only aggregate preparation progress and
    ticket counts into its own slot node. The slot never receives ticket
    records, billing identifiers, account credentials, or inference content.
  - Post-sign-in plan routing must wait for verified unlock, account-scope
    activation, the first encrypted ticket sync, and a billing-ready ticket
    snapshot. A transient startup zero must never open Membership.

- 2026-08-18: Submitted prompt bubbles keep the normal chat reading width.
  - Normal, manual-wide, and Parallel/Council layouts cap user prompts at the
    shared `44rem` reading width. Short prompts remain content-sized and
    right-aligned; only assistant lane responses use the expanded transcript
    width in Parallel/Council.

- 2026-08-16: Ticket-code share links stay within their issuing environment.
  - Ticket codes are one-time and environment-scoped, so the sender's current
    origin is retained instead of hard-coding the production chat host.
  - Commercial/preview chat links use `/chat/?tickets=<code>`; root-mounted
    public chat links use `/?tickets=<code>`. This keeps Sandbox codes on the
    Sandbox backend and preserves automatic recipient redemption.
  - A code that was already consumed is reported separately from a code that
    is expired, missing, or belongs to a different OA environment.

- 2026-08-16: The chat toolbar no longer draws a horizontal separator.
  - The toolbar still switches between opaque and floating presentation as
    side panels change the available width, but neither desktop nor mobile
    adds a rule above the conversation content.

- 2026-08-16: Extensions can subscribe to redacted ticket-count changes.
  - `context.tickets.subscribe()` waits for local ticket storage, then emits
    only the existing count/max-share/busy snapshot, never wallet records or
    ticket cryptographic material. A transient startup zero is not emitted.
  - Signed-in snapshots remain ineligible for automatic billing until the
    account's initial encrypted sync succeeds. Returning accounts therefore
    cannot be charged against a temporary empty wallet before remote tickets
    arrive.
  - This supports downstream opt-in zero-ticket refill UX without putting
    Stripe, billing identity, or charging logic into the public client.

- 2026-08-16: Parallel per-model regeneration uses the same combined ticket
  preflight as send and full regeneration.
  - The preflight counts a fresh Memory key when needed plus only the selected
    lane's fresh model access, and runs before later messages are deleted.

- 2026-08-21: Citation and inline-link rendering is network-silent.
  - URL display metadata is derived locally from the hostname. The client no
    longer sends response-derived URLs to CORS preview proxies or loads remote
    favicons automatically.
  - Keep source cards and inline links on local SVG/domain markers. The cited
    origin should see the browser only after the user explicitly opens a link.

- 2026-08-16: The full signed-in identity row opens the account action menu.
  - The email/avatar/settings affordance is one button with one hit target;
    signed-out clicks still open Account.
  - Focus returns to that control, and the identity row
    exposes menu semantics only while a verified, unlocked account is active.
- 2026-08-16: Commercial Membership can host the public ticket tools.
  - The extension context exposes count-only ticket-tool state plus the existing
    import, split/share, and access-code operations. It never exposes
    wallet records, account credentials, billing identifiers, or inference data.
  - Ticket counts remain billing-unready until account startup finishes. For an
    anonymous session, startup first archives any stale account-bound wallet and
    restores the anonymous scope; for a signed-in session, readiness additionally
    requires verified unlock, scope activation, and the first encrypted ticket
    sync. This prevents checkout recovery or automatic refills from acting on a
    transient zero balance.
  - The account-data guard canonicalizes a missing persisted scope to the
    anonymous `null` scope. It still rejects every real account mismatch while
    allowing a clean anonymous wallet to accept prepared tickets.
  - A commercial extension can register one compact right-panel ticket-count
    action that opens Membership. While registered, the right panel omits its
    ticket-code controls but keeps a collapsed question-mark explanation of
    inference tickets. Membership supplies Import, Share, and
    account-free access-code redemption in one place.
    Standalone public builds still render their original access-code controls.
  - Signed-out commercial actions may transition from the Account dialog into
    Membership through `context.ui.closeAccount()`. They must capture
    `getAccountMenuReturnTarget()` first, close Account, and then open the next
    dialog so only one modal and one keyboard focus trap are active.
  - The compact ticket launcher's icon and label share the same left edge as
    the Ephemeral Access Key heading below it; avoid adding nested horizontal
    padding to the launcher.
  - The commercial launcher uses its original `text-xs font-medium` heading
    treatment, with its original compact question-mark control
    immediately after the count. Do not replace it with a full-width navigation
    row or move the help control to the far edge of the panel. Standalone
    public ticket controls retain their existing compact typography.


- 2026-08-07: Google is the only supported SSO provider.
  - The account UI and client account state no longer expose GitHub sign-in,
    GitHub-linked flags, or GitHub compatibility wrappers.
  - The org no longer mounts `/auth/github/*` routes or accepts GitHub OAuth
    configuration. Access and refresh tokens carrying GitHub authentication
    provenance are rejected. Older provenance-less refresh records are also
    retired because their original provider cannot be distinguished safely, so
    sessions issued before provider removal cannot outlive the route removal.
    Existing identity rows remain opaque storage records, but there is no
    GitHub authentication path into them.

- 2026-08-11: Popup OAuth completion creates the SuperTokens browser session
  through an intercepted API response.
  - The callback navigation cannot deliver its `front-token` header to the
    Session SDK. It instead posts a short-lived, opaque single-use completion
    token to its exact opener. The client sends that token in the body of
    `/auth/google/complete`; the backend atomically consumes it and creates the
    HttpOnly session on that SDK-intercepted response.
  - Keep the order `complete -> verify -> provider session read`. Creating the
    session on the callback navigation or checking `doesSessionExist()` first
    leaves the SDK unaware of a valid Core session.
  - `/auth/google/start` is deliberately session-independent. It must remain
    usable when a browser carries a stale invalid SuperTokens access cookie;
    linking mode is still rejected, and an `expectedAccountId` is only a
    continuity hint that cannot create or retarget an identity mapping.

- 2026-07-30: SSO encryption passkeys use the provider email as their WebAuthn
  username and display name.
  - Google requests `openid email`. The org stores the verified email with the
    provider identity and returns it from the authenticated provider session.
  - `accountService.oauthEmail` is populated by the Google session path and
    is passed explicitly into every SSO encryption-passkey creation, including
    legacy SSO migration. `encryptionPasskey.js` has no generic label fallback;
    missing email requires a fresh SSO sign-in.
  - Existing identity rows gain a nullable email column. If an older refresh
    session restores `PRF_PENDING` or `LEGACY_SSO` before a new OAuth callback
    has populated it, the client returns to the provider sign-in screen instead
    of entering a passkey flow that cannot be labeled.

- 2026-07-30: SSO accounts now sync encrypted inference tickets across devices.
  - The SSO-only `syncTickets` gate was removed. Active and archived tickets,
    preferences, and their timestamps use the same version-1 encrypted blob
    format for identity-backed and legacy account-number accounts.
  - Ticket additions/imports/clears schedule the normal debounced sync.
    Redemption consumption deliberately does not for identity-backed accounts:
    its encrypted archive record is uploaded by the next initial/periodic sync,
    avoiding a deterministic
    identity-authenticated request two seconds after anonymous redemption.
    Legacy identity-free accounts retain immediate consumption sync.
  - Empty wallet arrays are encrypted too. Cash-style clear/export removes
    redeemable ticket secrets locally and syncs a separate encrypted SHA-256
    deletion-tombstone blob so stale devices cannot resurrect them. Remote
    active/archive merges always apply those tombstones.
  - A new device must authenticate with Google and unlock the shared
    master key with the PRF passkey before it can decrypt the restored wallet.
    A newly created SSO account adopts and uploads tickets already on that
    device, matching legacy account creation. Remote ticket merges immediately
    broadcast a cache invalidation to other tabs; stale notifications for a
    prior account are ignored instead of clearing the current account cache.
  - The org sees identity-bound sync metadata (request timing, ciphertext size,
    and stable opaque blob IDs), but not ticket plaintext or the HMAC-derived
    logical IDs. Redemption remains separate from account authentication, but
    optional identity-backed ticket sync weakens the strict metadata-level
    unlinkability claim: a malicious org can still attempt timing/size
    correlation around later syncs.

- 2026-07-29: SSO uses a Confer-style authentication/encryption split; see
  [ENCRYPTION_PASSKEYS.md](ENCRYPTION_PASSKEYS.md).
  - Google authenticates and authorizes opaque account storage. A
    separate client-only WebAuthn PRF passkey wraps the random sync master key.
    The org stores `credentialId` plus the versioned AES-GCM wrapper and never
    receives a WebAuthn assertion, PRF output, or plaintext key.
  - New SSO users are no longer shown an OA account number or recovery code.
    The required post-OAuth step is create/unlock encryption passkey. Losing all
    copies of that passkey is unrecoverable by design.
  - `oauthSetupRequired` means the authenticated account has no keyring and must
    create its first encryption passkey. `oauthKeyringRequired` means wrappers
    exist and a passkey must unlock one. `oauthRecoveryRequired` is only the
    one-time migration path for SSO accounts from the recovery-wrapper build.
    `oauthLegacyPasskeyRequired` is distinct: a legacy linked account still
    authenticates through its original WebAuthn credential.
  - `encryptionPasskey.js` handles the PRF-specific WebAuthn flow. Keep the
    follow-up `credentials.get()` after creation: some authenticators report
    PRF support at creation but return output only from an assertion.
  - IndexedDB persists non-extractable AES-GCM, HKDF, and HMAC `CryptoKey`
    objects in one account-bound `account-key-bundle-v1`, never new raw
    master-key bytes. Loading rejects a bundle for any other account. A
    one-time migration imports and deletes the old independent key values.
    Logout/token invalidation deletes the bundle.
  - Syncable tickets/preferences and their metadata now have per-account local
    snapshots (`sync-account-data:<accountId>`). OAuth reauthentication and
    logout must deactivate the active scope before clearing sync credentials,
    or unsynced local wallet state can be lost. Clear credentials first to
    invalidate in-flight work. Scope transitions and sync share the `oa-sync`
    Web Lock, and sync verifies its account against the persisted active marker
    before reading live values. Ticket mutations and syncable-preference writes
    also take this lock; scope snapshot/live-key/marker changes commit through
    one settings transaction, and stale store caches are cleared.
  - Superseded by the 2026-07-30 entry above: identity-backed accounts now sync
    encrypted ticket wallets as well as preferences. Google linking
    remains rejected to preserve dedicated account identity/recovery semantics.
  - Legacy unscoped values are adopted when the user creates a new account on
    that device, matching the original account-number flow. For a returning
    account, adoption requires persisted settings proving continuity with the
    same account. Otherwise values are preserved under `sync-unclaimed-data`
    and restored on logout; canceling setup before scope activation leaves them
    untouched.
  - Keep the legacy server-authentication `credentialId` separate from the
    client-only `encryptionCredentialId`. A linked legacy account still needs
    its original ID as the `/auth/challenge` hint and still displays its account
    number.
  - The sync blob format itself remains version 1. The service accepts the new
    non-extractable key bundle while retaining raw-byte input only for existing
    tests/compatibility.
  - An OAuth refresh token records its original auth method and time. Refresh
    preserves those claims, so a stale cookie cannot become a fresh provider-
    linking step-up merely by calling `/auth/refresh`.

- 2026-07-28: Account authentication supports Google OAuth in addition to
  passkeys; see [GOOGLE_SIGN_IN.md](GOOGLE_SIGN_IN.md).
  - `accountService.authenticateWithOAuth(provider, ...)` owns the shared popup,
    setup, recovery-unlock, account-mismatch, and local-key restoration flow.
    The Google-linked flag plus `lastOAuthProvider` are persisted so a locked
    browser can recover through Google.
  - Superseded by the 2026-07-30 passkey-label entry above: Google now requests
    `openid email`, and the org retains the verified email with `sub` so it can
    label the user's encryption passkey.
  - `npm run dev` serves static assets and proxies non-static requests to the
    local org on port `8005`. The browser therefore uses its own origin for
    passkey, OAuth, ticket, and sync API calls, avoiding local-network/CORS
    restrictions. OAuth callbacks still come directly from port `8005`, so
    `ORG_AUTH_ORIGIN` remains separate from the local `ORG_API_BASE`.
    The dev server injects a runtime-only proxy marker, so `npm run preview` on
    localhost still uses `https://org.openanonymity.ai`. The callback host is
    canonical `localhost`; requests to the dev server via `127.0.0.1` redirect
    there before the app loads.
  - `authenticateWithGoogle(...)` uses the shared popup
    flow and the org's HttpOnly refresh cookie. OAuth/access tokens never travel
    through the popup message or app URL.
  - Superseded by the 2026-07-29 encryption-passkey entry above: new or
    logged-out SSO browsers now unlock with WebAuthn PRF, not a recovery code.
  - Superseded by the 2026-07-29 identity-partition rule above: provider linking
    is rejected. A legacy passkey account and an OAuth identity account remain
    separate namespaces.
  - Refresh preserves the original provider/passkey method and authentication
    time; refresh does not manufacture newer authentication provenance.
  - Opting into Google makes the sync account identifiable to the org,
    but does not put identity into blinded ticket redemption or inference
    traffic.
  - Superseded by the 2026-07-29 account-scope entry above: syncable local state
    is now snapshotted and restored per account.

- 2026-08-16: Sticky Parallel width can be collapsed with the existing width icon.
  - Active Parallel/Council with two model columns stays wide and hides the
    manual width control. A one-model Parallel configuration, or a session
    returned to Chat after Parallel, shows the existing expand/collapse icon.
  - The control has no visible label. Its assistive name switches between
    `Expand view` and `Collapse view`, and a per-session collapsed hint keeps
    old Parallel transcripts narrow until multi-column mode is active again.


- 2026-07-11: OpenRouter `~author/*-latest` aliases normalize in the catalog adapter,
  while provider display/icon metadata resolves through the shared provider registry;
  cached OpenRouter catalog entries also recompute provider metadata from their model
  IDs when used as a network fallback. Legacy UI paths must prefer catalog metadata,
  then resolve model IDs by author or explicit `Provider: Model` prefixes; do not infer
  a company from family keywords such as `llama`, and do not default unresolved names
  to OpenAI. Clean unknown display names keep their initial, while malformed/empty or
  explicitly `Unknown` providers use the generic `A` badge. All runtime provider
  assets are self-hosted. Unknown or missing providers fall back
  to neutral initial badges. Image load failures are handled by one capture-phase
  delegated listener, which swaps the failed image for its neutral initial badge;
  keep this fallback free of inline event handlers for strict-CSP compatibility.
  The image-failure badge uses an explicit dark foreground because known-provider
  consumers retain their white icon-circle background after the image is hidden.

- 2026-07-13: Provider logos hydrate from the local model-catalog cache before a saved
  model choice is rendered. `inferenceService.getCachedModels(...)` delegates to the
  restored session's backend; OpenRouter normalizes cached provider metadata before
  returning it. The result lives in `cachedModelDisplayMetadata`, not `state.models`, so
  stale cache entries cannot influence request-time availability or model selection.
  Session switches refresh this display-only cache for the new backend, and clearing the
  current session restores the default backend's cached metadata.
  Keep the live catalog fetch as a background refresh so saved choices such as `Auto
  Router` never flash an unknown initial while waiting on the network.

- 2026-07-02: Memory retrieval fallback now shows a safe, calm note in-chat.
  - `runMemoryAugmentFlow(...)` still logs the raw exception to the browser
    console as `Memory augment query failed:`, but the persisted local Memory
    Agent message now also carries `memoryRetrievalFailure`.
  - The failure note is classified by `chat/services/memoryRetrievalError.js`
    into safe categories such as auth, network, timeout, service, request,
    storage, runtime, and unknown. User-facing copy should stay calm and avoid
    scary diagnostic wording such as raw HTTP statuses or provider exception
    strings. Do not render raw provider error bodies, prompts, memory file
    contents, URLs with secrets, or API keys in the chat.
  - `MessageTemplates` renders the note as a compact sub-row under the Memory
    Agent status, but only shows the short title by default to keep the chat
    low-noise. The main fallback copy stays one line:
    `Memory context was not added this time. Sending without it.`
  - `buildSharePayload(...)` now routes through `chat/services/sharePayload.js`
    so shared Memory Agent messages preserve this safe reason metadata without
    pulling share-service network side effects into payload tests.
- 2026-06-27: Memory now has a global feature gate.
  - IndexedDB setting `memoryFeatureEnabled` defaults on. When false, app
    initialization and `setMemoryFeatureEnabled(false)` force `memoryMode` false
    and persist that reset so reloads stay in Chat mode.
  - The settings menu has a dedicated `Memory` section. Its first row is the
    global `Memory feature` switch; `Always attach retrieval`, the memory agent
    model, and memory import/export controls are flat rows beneath it rather
    than nested behind a vertical rule, and become disabled when the feature is
    off.
  - `triggerPostTurnMemoryExtraction(...)`, `runPostTurnMemoryExtraction(...)`,
    and `runMemoryAugmentFlow(...)` all check the feature gate before requesting
    confidential memory keys or constructing retrieval/extraction memory banks.
    Disabling the feature increments a memory-work generation, aborts in-flight
    memory retrieval/extraction signals, clears pending memory prompt overrides,
    resolves pending approval prompts as skipped, and closes/aborts memory-editor
    backfill work. The bottom chat/memory slider remains hoverable but locked to
    Chat with `Memory is off in settings` copy on the Memory icon.
    Confidential memory-key redemption now receives those abort signals, and
    returned keys are not stored if the feature is disabled during redemption.
    Memory-editor local storage operations also use an operation generation and
    abort signal so stale saves, imports, maintenance, and folder operations do
    not continue their UI completion path after the global feature flips off.
    `memoryBridge`, `memoryInstances`, and OMF import helpers lazy-load
    `chat/nanomem/browser.js` only inside active memory operations. Importing
    the app shell, constructing `MemoryEditor`, toggling settings, or validating
    disabled controls must not evaluate nanomem while the global feature is off.
    The memory panel/import/export storage bank is also lazy and only constructs
    when the feature is enabled and the user explicitly opens or uses memory
    management.
- 2026-06-03: Inline quick ask is a non-persistent mini-chat for selected
  assistant text.
  - Selecting text inside an assistant `.message-content` shows a compact
    fixed-position `Ask` popover. User-message selections, selections inside the
    quick-ask window, scrubber-restored assistant responses, and collapsed
    selections are ignored.
  - Clicking `Ask` opens a small force-touch-style panel near the selection
    as a body-level fixed overlay with a saved chat-scroll anchor, with a single unsaved user turn,
    `Briefly explain "<selection>" in context.`, and a streamed assistant
    answer. The panel is portaled out of the message container so it paints
    above the composer and message chrome while staying below modal layers, but
    `ChatArea` updates its saved anchor on chat scroll so it still moves with
    the selected response instead of staying pinned to the screen. Clicking
    elsewhere in the chat UI hides the panel without aborting the in-flight
    answer. While the popover or panel is visible, `body.quick-ask-layer-active`
    lowers the composer-specific z-indexes below the quick-ask layer; keep quick
    ask below modal `z-50` surfaces.
  - The panel intentionally has no title/selected-term header; the selected text
    is already represented by the generated user question. Keep the panel shadow
    restrained and reuse the main `.message-user` bubble styling for the quick
    user prompt so it stays visually consistent with normal chat turns. Pending
    labels and reasoning traces reuse the main chat `.pending-response-*` and
    `buildReasoningTrace(...)` formatting rather than custom quick-ask labels.
    The panel has no close control; outside clicks and Escape hide it without
    aborting the request, and reopening the same selected text restores the same
    in-memory quick-ask state. Same-session message rerenders must preserve and
    reconnect the cached quick-ask panel; otherwise key acquisition or storage
    refreshes can leave `this.quickAsk.window` pointing at a detached DOM node
    and make later `Ask` clicks appear to do nothing. Restores should reattach
    the panel without recomputing its position because its saved absolute
    `left/top` are already content-relative and should continue to scroll with
    the message.
  - `ChatApp.inlineQuickAsk(...)` appends the quick question to the sanitized
    current transcript in memory only. It reuses the current session backend,
    scrubber redaction, file-to-API processing, search and reasoning toggles,
    and the current ephemeral access credential when one is active, but it
    resolves inference to the first pinned GPT Instant model instead of the
    session's selected model. If no pinned GPT Instant model is loaded, it falls
    back through the normal pinned default path. For older sessions with a
    missing or expired key, quick ask goes through the same
    `acquireAndSetAccess(...)` ticket redemption path as a normal send with a
    model id override so ticket cost is based on the resolved instant model even
    when catalog display names differ from normalized names, shows the standard
    `Requesting ephemeral key` pending state, and re-checks the panel abort
    before inference begins. Access acquisition is keyed by backend, session,
    and model so callers with different ticket-cost models do not incorrectly
    share a redemption; same-model callers still share via
    `accessAcquisitionInFlight`. Normal send/regenerate call
    `reserveAccessAcquisitionHandoff(...)` before closing the quick-ask panel so
    same-model key requests can survive the handoff. The underlying key request
    receives an abort signal and is cancelled when the last waiter aborts
    outside that handoff window.
  - Quick-ask answers are not written to IndexedDB, do not create sessions, and
    do not update session search/title state. User close only hides the panel and
    lets the request finish in memory. Full `ChatArea.render()` calls abort/reset
    the panel so a quick ask cannot linger across session switches. Starting a
    normal send or regeneration hides any active quick ask before the main
    session stream begins.
- 2026-08-14: Fresh-chat default model is OpenRouter Auto Router.
  - `modelConfig.getDefaultModelConfig()` returns `openrouter/auto` / `Auto Router`
    unless the org explicitly disables that model. The pinned model order is an
    availability fallback rather than an override of the product default.
  - Send-time fallback tries Auto Router first, then walks pinned model IDs in
    order if Auto Router is absent from the loaded catalog, and finally uses the
    catalog's first selectable model.
  - `ModelPicker` refreshes its default label when pinned-model config updates
    and asks `ChatApp.getDefaultModelName()` for empty-session display, keeping
    the button aligned with the rendered pinned section after models load.
  - Stored preferences matching recent default labels (`GPT-5.1/5.2/5.3
    Instant`) upgrade to Auto Router. Explicit custom preferences and
    per-session model choices are still left intact.
  - When fresh pinned-model data arrives after a stale local cache, the
    availability refresh reruns the stored default preference upgrade and updates
    the no-session pending model if it was still tracking the old default.
    Initial model-catalog load also drains pinned updates that arrived while
    `modelsLoading` was true.
- 2026-08-04: Parallel/Council lane access is bound to its selected model.
  - Ordinary Chat keeps the existing key-based charging behavior: changing its
    model does not redeem immediately, and a valid verified session key can be
    tried until expiry or credit exhaustion. Parallel/Council is stricter for
    cost preflight and lane isolation. Each lane reuses access only when its
    verifier proof is approved, its station is not banned, it has not expired,
    and its recorded model matches that lane's selected model. A lane model
    change therefore makes only that lane stale and the next Parallel send
    acquires a fresh key at the new model's ticket cost.
- 2026-05-29: Parallel/Council response mode is wired as a session-level opt-in.
  - The bottom response-mode slider has `Chat` and `Parallel` states. Memory is
    a separate book-icon toggle immediately to the left of that slider, so users
    can combine `Chat + Memory` or `Parallel + Memory`; clicking Parallel no
    longer turns Memory off, and clicking the book no longer leaves Parallel. A
    single book click toggles memory auto-attach; a quick double-click opens the
    memory panel and leaves auto-attach on. Turning on user-facing `Parallel`
    from the composer exposes an inline second-model picker beside the primary
    model picker and, by default, keeps output to Stage 1 only: two model
    responses, no synthesis/chairman request. Council is no longer a visible composer mode;
    the settings menu has a `Parallel` section with a `Council review` switch.
    Turning that switch on also turns Parallel on, writes
    `outputMode: 'synthesis'`, reveals a Council model select inside settings,
    and enables the existing review pass below the two first responses. The
    primary picker uses `⌘K`, the secondary picker uses `⌘J`, and `⌘L` still
    opens the shared searchable model picker for Council selection when Council
    review is enabled or the settings menu is open. The visible Council setting
    itself follows the Scrubber/Memory settings pattern: a compact native
    select row, not a composer-style model chip. Its option values stay as raw
    catalog names for model matching, but visible option labels omit provider
    prefixes/company names like `OpenAI:` or `Anthropic:`. Secondary and Council selection can
    choose any selectable model, including the current primary model. If a
    persisted Council model is
    no longer selectable, settings fall back to the same primary/default model
    the controller will charge for instead of displaying a stale model name.
    Ticket costs remain shown inside the modal options. While Parallel is
    active, the composer shows primary and secondary model chips with provider
    icons, provider-stripped names, and full model names in tooltip/aria labels;
    the Council model is never shown in the composer. Turning Council review
    off leaves the user in Parallel but skips the Council answer. Switching the composer
    from Parallel back to Chat resets `outputMode` to plain Parallel, so the
    next Parallel use starts as two-model comparison unless the user re-enables
    Council review; synthesis access is still only preflighted/acquired when
    Parallel is active with Council review on. Toggling Council review does not
    alter the independent Memory book state.
    The picker derives the same fallback secondary model as the controller,
    including legacy model-id members and stale-member skipping, so its
    displayed model matches the lane that will be charged, and refreshes when
    model ticket tiers update. When there is no configured second model,
    Parallel prefers Google Gemini 3.5 Flash as the secondary lane if it is
    available and not already the primary model; otherwise it falls back to the
    first available non-primary model. This keeps GPT OSS from becoming the
    implicit second lane just because it appears earlier in the catalog. If the
    session's primary model is stale or unavailable, both the composer and
    controller resolve the primary lane to the default/fallback model before
    assigning the secondary lane.
    The settings menu no longer exposes duplicate legacy multi-model rows.
    Parallel is an explicit composer choice. A new chat/tab/window inherits the
    last explicit Chat/Parallel choice from the versioned
    `parallelModePreferenceV2` setting; an older global `parallelModeEnabled`
    value is ignored so historical state cannot opt a user into extra requests.
    Only the mode control writes the versioned preference, so model changes in
    another tab cannot overwrite it. The last secondary model, Council model,
    and Parallel/Council output mode are persisted as
    `parallelSecondaryModel`, `parallelSynthesisModel`, and
    `parallelOutputMode`. New single-chat sessions still keep the saved
    secondary model in their disabled `councilConfig`, so turning Parallel on in
    that session reuses the user's last secondary model instead of reverting to
    the default. The empty New Chat composer rebuilds its pending council config
    from those persisted model defaults and the versioned mode preference before
    rendering. Composer components update
    the in-memory persisted defaults through `ChatApp.setParallelDefaults()`;
    direct writes like `this.app.parallelModeEnabled = ...` will fail through
    the strict component facade.
  - The switch can be set before a session exists; `ChatApp.pendingCouncilConfig`
    carries that choice into the first created session. Enabled sessions persist
    `responseMode: 'council'` plus `councilConfig` with up to two member display
    names, `outputMode`, `synthesisModel`, and `reviewEnabled` derived from
    whether output mode is `synthesis`. The
    active session model is the primary lane; the selected second model is the
    comparison lane. Parallel with Council review off writes
    `outputMode: 'parallel'`, so synthesis is skipped and no synthesis key is
    acquired. Parallel with Council review on writes `outputMode: 'synthesis'`,
    so the selected Council model gets its own synthesis key and writes the
    final answer. Missing/legacy `outputMode` still normalizes to `parallel` to
    avoid unexpected third-key redemption. If a config only names the primary
    model, the controller adds the first available non-primary model as the
    secondary lane.
  - The Council synthesis prompt lives in `chat/domain/councilPrompts.js`. It
    asks the synthesis model to act as an independent reviewer over anonymous
    `Response A` / `Response B` drafts, briefly compare only material
    differences, errors, missing caveats, and useful synthesis, then produce a
    concise final answer to the original request. The review should be fair,
    critical, concise, and evidence-oriented, but avoid generic praise, model/provider identities,
    scores/grades/ranked lists, chatty phrasing, and generic follow-up offers.
    Partial synthesis is supported when only one draft response is available.
  - `chat/application/councilController.js` runs the selected models in
    parallel through `inferenceService.streamCompletion(...)`, preserving the
    browser-only OpenRouter path and the existing ephemeral access flow. Strict
    completion remains only as a fallback for tests or future backends that do
    not expose streaming.
  - Council access is lane-scoped under `session.councilAccess.primary` and
    `session.councilAccess.secondary`, plus `session.councilAccess.synthesis`
    for the Council answer. Each lane stores its own ephemeral key, access
    metadata, expiry, and last-issued model id. Lane keys are both lane-scoped
    and model-bound: primary only uses `councilAccess.primary`, secondary only
    uses `councilAccess.secondary`, synthesis only uses
    `councilAccess.synthesis`, and a model change refreshes that lane before
    inference. There is no cross-lane key pooling.
    `RightPanel` renders these lane records as separate Ephemeral Access Key
    rows when Parallel/Council is active: `Model 1`, `Model 2`, and `Council`
    only when synthesis/Council review is enabled. This is display-only and
    does not change key acquisition, ticket preflight, or lane isolation. The
    RHS panel intentionally shows lane roles, not model names; the current model
    choice belongs in the composer/settings while the RHS panel represents
    access-key state. The multi-lane panel notes that keys persist until expiry,
    model change, or exhaustion. When there is no active session, the RHS panel
    mirrors `pendingCouncilConfig` and shows pending `Model 1` / `Model 2` /
    optional `Council` rows only after Parallel is explicitly selected. These no-session rows
    are a preview only: they do not create a session, redeem tickets, or acquire
    access until the first send.
    Lane rows mask the actual lane token rather than the session's primary
    ephemeral alias, and use their own lightweight expiry refresh when there is
    no single-chat key timer active. If a single-chat key timer is active while
    lane rows are displayed, that timer refreshes the lane panel instead of
    looking for the single-key expiry chip; when the single key expires, it
    forces one lane-panel refresh and lets the lane timer take over. Each lane
    row owns its own verifier-attestation button and passes that lane token and
    access metadata to the modal; do not reuse the single-session key
    attestation context for the multi-lane panel.
  - If a lane key is missing, expires, is banned, or OpenRouter reports credit
    exhaustion, only that lane is cleared and refreshed. Reused lane keys are
    also checked against the verifier's live/cached banned-station state before
    use; a now-banned lane key is treated as stale, cleared, included in ticket
    preflight, and replaced before inference. A lane model switch also counts
    as stale access for ticket preflight and causes that lane to acquire a fresh
    key priced for the selected model before inference.
    Before acquiring any missing/expired/banned lane keys, the controller checks
    that enough tickets exist for all fresh primary/secondary/synthesis lanes so
    it does not partially charge one lane and then fail on another. Parallel
    with Council review off preflights/acquires only the primary and secondary
    lanes. Changing the Council model or toggling Council review does not
    proactively clear `councilAccess.synthesis`; synthesis access refreshes only
    when that lane actually needs a fresh key.
  - Parallel/Council reasoning uses the same collapsed reasoning trace UI as
    normal chat. Stage 1 lanes render `entry.reasoning` above each lane
    response with lane-specific IDs, and Council synthesis stores and renders
    `council.synthesis.reasoning` above the Council answer. Lane responses now
    stream through lane-scoped DOM targets (`primary`, `secondary`, and
    `synthesis`), so content and reasoning can appear token-by-token without
    clobbering the other lane. `ChatArea` keeps a separate
    `councilReasoningStreams` map for those concurrent traces while the normal
    single-chat `reasoningBuffer` remains unchanged. Final lane/synthesis
    completion still saves parsed reasoning, duration, citations, and canonical
    message content as before.
  - Persisted Memory mode can remain enabled globally, and send/regenerate now
    run memory augmentation once before a Parallel/Council turn fans out to
    model lanes. The approved `_lastApiContent` override is applied by
    `processMessagesWithFiles(...)` to the shared last user turn, so primary
    and secondary lanes receive the same memory-augmented prompt. The Council
    synthesis prompt still uses the canonical chat context plus Stage 1
    responses; memory is not injected a second time into synthesis. The
    override is cleared by the app-level send/regenerate `finally` block after
    the full turn completes, fails, or is cancelled. Council regenerate
    preserves the current local-only Memory Agent status row while pruning old
    model responses. A single book-toggle click only changes `memoryMode` and
    does not alter Parallel/Council session config; double-clicking the book
    opens the memory panel and keeps `memoryMode` enabled. Post-turn background
    memory extraction still runs after successful Parallel responses, so a
    separate confidential memory key redemption can appear after the visible
    model requests finish; that is memory ingestion, not a hidden response lane.
  - If Parallel is enabled after a normal single-model turn, the primary
    lane can seed from the existing `session.apiKey` when the key is valid and
    the access metadata identifies the same primary model. In that case,
    opening Parallel only redeems tickets for missing/new lanes such as the
    secondary model; seeded primary lane access records use
    `ticketsConsumed: 0`. Newly acquired single-model access records are stamped
    with `modelId`/`modelName` so council does not seed an old key whose model
    ownership is ambiguous.
  - If Parallel is disabled, `ChatApp.setCouncilModeForCurrentSession(...)`
    seeds normal single-chat access back from a valid `councilAccess.primary`
    record. Returning to single chat should therefore keep using the primary
    lane key instead of redeeming a new ticket, unless that primary lane key is
    missing, expired, banned, or later rejected by OpenRouter for exhausted
    credit. Secondary and synthesis keys are never pooled into single-chat
    access.
  - A Stage 1 council turn is stored as one assistant message with
    `message.council` metadata. `message.council.stage1` keeps the two
    first-opinion responses. In Stage 1-only mode, each future lane request
    builds API history from that lane's own prior Stage 1 responses, so the
    secondary lane does not inherit the primary lane's previous answer.
  - With Council review enabled, `message.council.synthesis` keeps the Council
    answer status/response/error. When synthesis succeeds,
    `message.content` is the Council answer and `message.model` is `Council`, so
    future turns use the prior Council answer as normal assistant context. If
    synthesis fails or the user chose Stage 1-only mode, `message.content` falls
    back to the first completed Stage 1 response; synthesis failures set
    `message.council.synthesis.fallbackUsed` to true.
  - The current implementation covers Stage 1 "first opinions" plus one
    Council review pass. It does not yet run Karpathy-style peer ranking or
    scoring.
  - `MessageTemplates` renders two council lanes side by side on desktop and
    stacked on narrow screens, then renders the Council Answer below them only
    after synthesis actually starts. Stage 1 response headers include provider
    icons. Parallel/Council does not use the generic typing-indicator row during
    access acquisition; `CouncilController` saves the assistant message before
    lane access is acquired so the selected model cards and `Waiting for
    response` shimmer appear immediately. The aggregate assistant row
    intentionally omits a visible `Parallel`/`Council` text label and redundant
    top-left mode icon; the lane cards and optional Council Answer section
    already identify the mode. Completed lane and synthesis status chips are
    also hidden, while error/cancelled/partial/fallback status remains visible.
    Pending lane cards reuse the normal chat `Waiting for response` shimmer
    instead of showing a `Pending` chip or custom `Waiting for this model to
    finish...` copy. Stage 1-only mode removes the aggregate status/note row
    instead of showing a waiting row, completion label, lane-history
    implementation note, or canonical-context explanation. While synthesis
    runs, the Council answer section is separated from the two draft responses
    by a subtle horizontal rule, then shows the selected synthesis model with
    its provider icon, providerless model name, and a visible `Council` role
    badge. It reuses the normal chat `Waiting for response` shimmer while
    omitting the aggregate `Council`/ready status row. Once the Council answer
    is available, the same selected-model row remains above the answer,
    matching the model the user chose and was charged for; redundant `Council
    Answer` header copy and completed-status text stay hidden. On synthesis failure it shows `Council synthesis failed.
    Continuing from Response A.` (or the actual fallback label). Council
    review suppresses the aggregate copy/regenerate/fork action row while
    synthesis is waiting/pending/running, then restores copy/regenerate inside
    the Council synthesis block once synthesis reaches a final or fallback
    state; fork stays disabled. Plain Parallel keeps normal actions directly
    under each completed lane response instead of on the aggregate message,
    because aggregate copy/regenerate/fork is ambiguous when two drafts are
    visible. Both the synthesis and lane action rows reuse the normal
    `assistant-actions-row` anchor so their spacing matches single-chat
    assistant actions.
    Web-search sources are also lane-local: each Stage 1 lane renders its own
    Sources button and citation carousel at the bottom of that response only
    when that lane produced citations. Council synthesis renders its own
    separate Sources button when the synthesis response has citations; aggregate
    Council/Parallel messages no longer reuse one canonical sources button for
    all visible responses.
    The Council answer block is width-capped, centered, and given extra top
    spacing below the two lanes so synthesis reads like the normal narrow
    transcript even when Parallel keeps the page wide. Lane copy copies only that lane response. Lane fork is
    intentionally disabled for Parallel lanes for now, and completed aggregate
    Council answers also omit fork; normal fork remains on single-chat
    assistant messages only.
    Lane regenerate refreshes only that lane, reusing or refreshing only that lane access; if the lane was not canonical, the
    existing canonical response stays canonical. Like normal regenerate, lane
    regenerate prunes later messages before rerunning so future context cannot
    depend on the replaced answer. Canonical citation controls stay available
    with the aggregate message.
  - Parallel/Council layout has two separate stability rules. Selecting
    Parallel changes the composer without changing transcript width. Submitting
    a turn with more than one model sets `session.hasCouncilLayoutPreference`
    and expands the transcript before the prompt and response lanes render.
    That preference preserves the wider layout when the user toggles back to
    Chat, even before a Parallel response is saved. Pending no-session Parallel
    configuration is transferred into the first session without widening the
    empty page; the submitted turn activates the layout. `session.hasCouncilTranscript`
    separately tracks saved `message.council` output across session switches and forks, and
    `ChatArea.render(...)` backfills/recomputes it from stored messages for
    older sessions. Regenerate, resend, prompt edit, and cancelled Council turns
    recompute the transcript hint after pruning, but they do not clear the
    user's sticky layout preference. The manual wide-screen toggle and
    Parallel/Council share the production transcript cap (`66rem`) so switching
    modes keeps a consistent readable measure. The top-left manual wide-mode
    button remains available while Parallel is only being configured, then is
    hidden while a submitted multi-model layout owns the wider transcript.
    Background saves may mark a non-visible session as having a council
    transcript, but root layout classes should only update for the currently
    viewed session. Composer controls are
    stable independently: the default composer keeps attachment and Settings
    visible inline, while Web search moves to the bottom of the existing
    Settings menu; there is no separate `+` menu. File upload, settings, and
    web search keep their original element IDs/handlers, and response mode and
    Memory stay visible beside them. Web search defaults on, but only the Web
    search row shows `On`/`Off` and active styling. Compact model pickers sit on
    the left side of the composer, with file/settings/mode/memory/send controls
    anchored together on the right to reduce layout flash. Chat mode shows the
    primary model icon plus a compact name; Parallel reveals the secondary
    model chip after primary. Model chips use `fit-content` natural width up to
    a shared responsive max width (`12.25rem` on desktop, `8.75rem` on small
    screens) so short model names produce short buttons while long names cap
    cleanly. The root `data-composer-mode` is refreshed from both the mode
    toggle and the multi-model settings refresh so Chat/Parallel layout rules
    apply immediately after switching modes. The composer label is the
    full provider-stripped catalog name; JavaScript does not apply a character
    budget or semantic/family-name rewrite. CSS owns the
    visual ellipsis via the label span (`overflow: hidden`, `white-space:
    nowrap`, `text-overflow: ellipsis`), so truncation follows actual rendered
    button width across devices. Labels must not wrap to multiple lines. The
    chip should not hide overflow at the button level because that clips
    descenders in labels with letters like `g`, `p`, and `y`; horizontal
    clipping belongs on the label span. The composer left action group allows
    visible overflow so model-chip tooltips are not clipped. Composer model
    chips set both
    `data-tooltip` and native `title` to the full provider-stripped catalog
    name, with no lane label like `Primary model:` or `Secondary model:` and no
    provider prefix like `OpenAI:` or `Anthropic:`. Those hover labels stay on a
    single line. When a user edits/rewrites a prompt, the edit box mirrors the
    models that will receive the regenerated turn: Chat shows the primary chip,
    while active Parallel/Council sessions show primary and secondary chips.
    The Council/chair model remains Settings-only and is not shown in the edit
    box. Changing either model while edit mode is open refreshes those edit
    chips from the composer chips. Full provider names remain visible in the shared model picker. Run
    `npm run audit:model-labels` to check the current live OpenRouter catalog
    for labels that fail providerless normalization and to inspect the longest
    CSS-truncated label. Chat mode primary chips use natural width and can grow
    up to the same width as two Parallel chips plus their gap; Parallel stays
    unchanged. Chat max width is calculated as two Parallel chip maxes plus
    `--composer-model-chip-gap`, the same variable used for the actual Parallel
    model-chip gap. Short model names still use natural button width. Keep the
    Chat width selector at ID-level specificity because the base composer chip
    width rule is also ID-scoped. The send button has a small
    left margin (`0.9rem`) so the Memory-to-send gap is wider without changing
    spacing between Memory and the other right-side controls. This targets only
    `.composer-right-actions #send-btn`, not the shared right-side control gap.
    The Chat/Parallel slider also has a small left margin so it breathes after
    the Memory/book button without changing spacing between the other tool
    buttons. The Memory book tooltip is two-line copy: the first line names
    auto-attach, and the second line says double-click opens Memory with the
    Beta badge. If the global Memory feature switch is off, only the Memory
    book is marked disabled; the Chat/Parallel slider remains interactive.
    OpenRouter catalog display names are trimmed on live ingest and cache
    load/save, and model selection helpers compare by id plus trimmed display
    name so provider catalog quirks
    like `Baidu: ERNIE 4.5 VL 424B A47B ` do not make secondary selection fail
    when the visible label omits the trailing whitespace. Parallel mode permits
    the same model in both lanes. `session.councilConfig.members` may therefore
    contain duplicate model names, and the controller preserves them as separate
    primary/secondary lane entries with separate lane access records. If both
    lanes need fresh access, they are still charged independently even when the
    selected model is the same.
  - The old `?composerVariant=...` and `?composerWidth=...` design comparison
    knobs were removed after the composer direction settled. The fixed behavior
    is full model-name chips, attachment and Settings visible inline, Web
    search inside Settings, and wider Chat-mode model-chip capacity by default.
  - Completed assistant Markdown finalization now funnels in-place content
    updates through `ChatArea.renderCompletedAssistantContent(...)`, the same
    citation -> Markdown/LaTeX -> inline-citation -> link-enhancement pipeline
    used by the normal full render path. This guards the single-chat path where
    finalized reasoning can otherwise update only `.message-content` in place.
    Normal send completion must always call `finalizeStreamingMessage(...)`,
    even when text content exists, because the streaming DOM may contain only a
    partial Markdown render from the last chunk; regenerate already followed
    this final-render pattern. Run that final message render before
    `finalizeReasoningDisplay(...)` so the final action row and Sources UI are
    rebuilt before the reasoning trace is polished. Citation metadata
    enrichment must call `finalizeStreamingMessage(message, { forceFullRender:
    true })`, because enriched source cards live outside `.message-content` and
    would otherwise be skipped by the no-flash finalized-reasoning branch.
  - `CouncilController` receives `chatDB`, `inferenceService`, and
    `ticketClient` from `ChatApp` instead of importing the service singletons
    directly. This keeps browser storage/network singleton initialization out
    of unit tests and lets `test/application/councilController.test.js` lock
    down mixed lane costs, model-switch refresh, synthesis 402 retry,
    insufficient-ticket preflight behavior, lane-specific Stage 1 history,
    partial synthesis, and synthesis fallback behavior with small stubs.
  - `chat/domain/councilPrompts.js` defines the Council synthesis prompt. It
    intentionally omits Stage 2 peer-ranking inputs, anonymizes first-opinion
    drafts as `Response A`, `Response B`, and asks the Council model to briefly
    compare only material differences, errors, missing caveats, and useful
    synthesis before writing a concise final answer. It avoids model/provider identities,
    scores/grades/ranked lists, chatty phrasing, and generic follow-up offers.
- 2026-05-26: Prompt edit file drag feedback is scoped to the inline editor.
  - While a prompt edit draft is open, file drags highlight the edit prompt card
    and keep the bottom composer drop overlay hidden, matching the drop target.
  - The edit form does not replay its enter animation on attachment add/remove
    refreshes, avoiding a post-drop flash when the attachment list rerenders.
- 2026-05-25: Memory-agent status summaries were shortened.
  - Approved/reused memory sends now use compact copy such as `No new retrieval.
    Using previously approved memory.` instead of spelling out minimized
    personal context or generic sending state.
  - No-memory adaptive sends now say `No added memory. Sending original prompt.`
    so the status row stays easier to scan.
- 2026-05-25: Pulled `nanomem` to `dbdbd4b` on top of latest upstream
  `origin/main` `9dd3581`.
  - Upstream added ingestion prompt/version-log cleanup and temporal wording
    changes. Root still depends on cancellation propagation through
    `memoryBridge`, so the abort-support patch was carried forward on top of
    upstream and verified with `test/engine/retrieveAbort.test.js`.
  - While integrating, `nanomem` version-log mutation paths were adjusted to
    respect stored bullet `v=` metadata as well as existing `_vlog` entries.
    This keeps delete/update/corroboration/compaction entries monotonic for
    memories that already have inline versions but no companion vlog yet.
  - `_vlog/` audit files are now treated as internal storage: they stay readable
    through raw storage/export paths but are excluded from the memory tree,
    search/list surfaces, bullet index, deletion deep scans, and portable
    text/ZIP exports so the agent does not ingest its own audit log. OMF export
    in the browser/IndexedDB app still preserves vlogs under
    `extensions.nanomem.vlogs` for round-trips.
  - Agent-facing memory tools normalize path strings before internal-path
    checks and reject `_tree.md` / `_vlog/` paths across read and write tools,
    including `./_vlog/...` and `work/../_vlog/...` forms.
  - Storage writes canonicalize internal paths before persisting, so OMF vlog
    extension keys like `./_vlog/...` are restored as canonical `_vlog/...`
    records instead of becoming normal memory files.
- 2026-05-25: User prompt edit mode now has an attachment draft.
  - `ChatApp.editDrafts` keeps edited text plus attachment metadata in memory while
    the inline editor is open; IndexedDB is not updated until the user saves.
  - The edit form can add newly validated files and remove existing attachments.
    On save, `message.content` and `message.files` are committed together before
    later turns are truncated and `regenerateResponse()` runs.
  - Empty-text prompts are valid only when at least one attachment remains, matching
    normal send behavior for file-only turns.
  - Edit attachments render inside the same bordered prompt editor surface as the
    textarea and controls. Global file paste routes to the active edit textarea's
    draft instead of the main chat input.
  - Edit-mode file drop routes to the hovered edit prompt card, falling back to
    the focused edit textarea. The attachment count label opens the same file
    picker as the paperclip icon.
- 2026-05-25: Forked conversations preserve generated/manual titles.
  - `ChatApp.forkConversation(...)` now asks `chat/domain/sessionSearch.js` for
    fork title fields instead of rebuilding every fork title from the first user
    message.
  - Source sessions with `titleSource: 'generated'` or `manual` keep that
    visible title plus ` (fork)`. Local fallback titles still derive from the
    first copied user prompt.
  - Forks explicitly set `titleGenerationPending: false`; copied historical
    messages are saved directly and should not restart async title generation.
- 2026-05-21: The left chat sidebar can now be toggled with `Cmd/Ctrl+\`.
  - The shortcut calls the same `showSidebar()` / `hideSidebar()` paths as the
    toolbar buttons, preserving the existing desktop persistence and mobile
    overlay behavior.
  - During the desktop close animation, `data-left-sidebar-closing` keeps the
    main-toolbar expand button hidden until the sidebar width transition ends.
  - The collapse and expand sidebar buttons use real tooltip markup, not
    `[data-tooltip]`, so the shortcut can match the model-picker style with
    separate muted `⌘` and key glyphs.
  - The delete-history sidebar icon uses the shared `[data-tooltip]` hover
    bubble, right-aligned to stay inside the sidebar edge.
  - While `data-left-sidebar-closing` is set, sidebar hover bubbles are
    suppressed so a hovered icon does not leave tooltip feedback during the
    collapse animation.
- 2026-05-18: Memory-mode stop now cancels the active memory retrieval itself.
  - The input stop button's existing chat-stream `AbortController` is threaded
    from `ChatApp.runMemoryAugmentFlow(...)` through `chat/services/memoryBridge.js`
    into `nanomem` `augmentQuery(...)` / `augmentQueryAdaptive(...)`.
  - `nanomem` now accepts optional `{ signal }` on retrieval/augment entrypoints
    and forwards it through the tool loop, adaptive no-op check, direct answer
    rendering, and the inner `augment_query` prompt-crafter request/retry sleep.
  - Aborted retrieval normalizes back to the app's cancelled-error path, persists
    `Memory retrieval cancelled.`, and does not continue into the frontier-model
    send.
- 2026-05-18: Resending a user prompt prunes approved memory context linked to
  the resent turn and any later user turns before regenerating.
  - First-turn resend clears `session.memoryRetrievedContext.entries` because
    there is no earlier approved chat context that should be reused.
  - Later-turn resend keeps entries from earlier user turns, so adaptive memory
    can still reuse context the user already approved before the resend point.
  - The resend action button is blurred and given a stable pressed/busy style
    before the message list rerenders to avoid a transient white focus flash.
- 2026-05-18: Pulled `nanomem` to `24871d9` / `v0.1.3-26-g24871d9`.
  - The latest commit tightens adaptive retrieval: before re-querying memory, it
    runs a small no-op check to skip only obvious already-covered follow-ups.
    If the adaptive agent skips with partial/low coverage before trying a
    targeted retrieval, `nanomem` now falls back to keyword search instead of
    silently reusing incomplete context.
  - `augmentQueryAdaptive(...)` now returns retrieval sufficiency metadata more
    consistently on skipped/no-new-memory paths (`retrievalConfidence`,
    `coverage`, `missingVariables`, `retrievalReason`). Root already normalizes
    these into `memoryRetrievalAssessment`, and the revised-prompt header only
    shows confidence when metadata is explicitly present in the retrieval
    result.
  - First-turn `augmentQuery(...)` still crafts prompts through the
    `augment_query` terminal tool and does not yet forward retrieval confidence
    into successful prompt results. Keep the UI quiet for that path unless
    `nanomem` later adds explicit metadata there.
- 2026-05-17: Pulled `nanomem` to `3510fb2` / package `0.1.3`.
  - The browser seam remains compatible with root `oa-chat`; `src/browser.js`
    still exposes `createMemoryBank`, `stripUserDataTags`, OMF helpers, and
    `augmentQueryAdaptive(...)`. It now also exposes `memoryBank.pruneExpired()`,
    which root uses for deterministic expired-memory cleanup.
  - Retrieval keyword search tool calls are now named `search_memory` instead of
    `retrieve_file`. Keep both labels in `MessageTemplates` so new streaming
    traces render polished names while older persisted traces remain readable.
  - Retrieval results may include sufficiency metadata
    (`retrievalConfidence`, `coverage`, `missingVariables`, `retrievalReason`,
    `uncertainFacts`). Root normalizes this into `memoryRetrievalAssessment` on
    local Memory Agent messages and `ciPromptDraft`. The UI only surfaces
    confidence as a small badge in the revised prompt header when the retrieval
    result explicitly includes confidence metadata; conservative fallback
    defaults stay internal. Coverage and missing/uncertain details remain
    internal metadata.
  - The Memory panel now understands numeric `confidence=0..1` metadata while
    preserving legacy `low` / `medium` / `high` bullets, and exposes a
    deterministic `Clean expired` action backed by `memoryBank.pruneExpired()`.
- 2026-05-10: The first UI-facing app interface seam is in place.
  - `chat/ui/appInterface.js` exposes component-specific facades for
    `ModelPicker` and `Sidebar`.
  - `chat/ui/vanilla/VanillaChatUi.js` now owns concrete component construction;
    `chat/app.js` should not import files from `chat/components/` directly.
  - `ModelPicker` now selects models through `ui.actions.selectModel(...)`
    instead of importing `chatDB`, so UI rewrites can call the same action
    without inheriting persistence details.
  - `Sidebar` still renders the current DOM, but it now receives a sidebar-only
    interface instead of the whole `ChatApp` object.
- 2026-05-10: The vanilla shell now has explicit persistence and backend ports.
  - `app.data` is supplied by `chat/ui/appInterface.js` and is the only path
    shell components should use for message/session/settings persistence.
    `ChatArea`, `ChatInput`, `MessageNavigation`, `RightPanel`,
    `MemoryEditor`, and `ChatHistoryImportModal` no longer import `chatDB`.
  - `app.services` groups ticket, network logger, proxy, and inference gateways
    for the vanilla shell. `RightPanel`, `WelcomePanel`, `ThanksPanel`,
    `ChatInput`, and `MemoryEditor` should call the injected services instead
    of importing those gateways directly.
  - The same service port now also covers verifier attestation, share URLs,
    account state, and sync. `TLSSecurityModal`, `VerifierAttestationModal`,
    `ShareModals`, `AccountModal`, and `MessageTemplates` should be configured
    through the vanilla adapter rather than reading backend modules/globals.
  - The architecture tests in `test/architecture/uiBoundary.test.js` enforce
    the current boundary: `app.js` cannot construct concrete components,
    domain/application modules cannot import UI, shell components cannot import
    `chatDB`, and gateway-heavy shell components cannot import backend gateway
    modules directly.
- 2026-05-06: The frontend architecture refactor has started with tested domain
  seams.
  - See [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md) for the target
    component map and progress tracker.
  - `chat/app.js` now delegates message API payload shaping, session search/title
    helpers, model-selection helpers, and streaming pending-phase normalization
    to pure modules under `chat/domain/`.
  - Access acquisition now goes through `chat/application/accessController.js`;
    keep UI notifications as injected callbacks so ticket redemption and verifier
    behavior remain testable without DOM dependencies.
  - `npm test` runs unit tests through `scripts/run-unit-tests.mjs`, which
    bundles browser-style ES modules with esbuild and executes Node's built-in
    test runner. This avoids adding a framework test dependency while the app is
    still HTML-first.
- 2026-05-06: `.docx` attachments are supported by local text extraction.
  - `chat/services/fileUtils.js` reads the DOCX ZIP in the browser, inflates
    `word/document.xml` plus headers/footers/notes, and extracts plain text from
    WordprocessingML before inference. The original document still stays in the
    stored attachment `dataUrl` for preview/download.
  - `chat/app.js` persists `file.extractedText` on the user-message file metadata
    for DOCX uploads. `chat/domain/messageContent.js` uses that cached text for
    normal sends, reloads, and regeneration; it does not send the DOCX binary as
    an OpenRouter file part.
  - DOCX parsing requires browser `DecompressionStream('deflate-raw')`; upload
    validation rejects unreadable documents before they enter the draft.
- 2026-05-06: Sending or regenerating a prompt now starts a prompt slide-up effect.
  - `ChatApp.startPromptSlideUpEffect(...)` anchors the active user prompt at roughly 25%
    from the top of `#chat-area`, then keeps `isAutoScrollPaused` true while the response
    streams so long model output does not pull the viewport down.
  - The effect uses a DOM-only `.prompt-scroll-spacer` at the end of `#messages-container`.
    `ChatArea` streaming/append hooks call `updateActivePromptScrollSpacer()` so the spacer
    shrinks as assistant content appears; once output is tall enough, the spacer is hidden.
  - Explicit bottom-following should go through `ChatApp.shouldAutoScrollChat(...)`.
    A live prompt slide-up effect always returns false for non-forced auto-scroll.
    `#chat-area.prompt-slide-active` and `.prompt-scroll-spacer` use `overflow-anchor: none`
    so browser scroll anchoring does not nudge the viewport as the spacer shrinks near the
    bottom of the screen.
  - While the active prompt-slide response is streaming, `updateScrollButtonVisibility()`
    suppresses the scroll-to-bottom button. That button otherwise appears exactly when the
    streamed assistant output reaches the fixed input box and can cause a one-time visual
    flicker at the bottom edge.
  - Once streaming is over, automatic visibility checks may hide the scroll-to-bottom button,
    but they must not clear a visible spacer. The minimally sized spacer often makes the
    anchored prompt technically sit at the scroll container's real bottom; clearing it there
    drops the prompt back down after stream completion. Only clear automatically when the
    spacer is already gone/tiny, or clear explicitly from the scroll-to-bottom button/new
    prompt/session cleanup paths.
  - Final stream cleanup can replace streaming DOM with shorter final markdown/reasoning DOM.
    `ChatArea.finalizeStreamingMessage(...)` and `finalizeReasoningDisplay(...)` must wrap
    those mutations with `captureActivePromptScrollAnchor({ primeRunway: true })` and
    `restoreActivePromptScrollAnchor(...)`; otherwise the browser can clamp `scrollTop`
    before the prompt spacer is recomputed and visually drop the prompt at stream end.
  - Do not persist this spacer in IndexedDB or message records. It is only a viewport runway
    for the current tab. `sessionPromptScrollAnchors` remembers the active prompt per
    session in memory, and `session.promptSlideAnchorMessageId` persists the anchor message
    id so refresh can rehydrate the viewport runway. Switching sessions detaches the DOM
    spacer, and switching back rehydrates it before scroll restoration so an in-flight or
    just-finished response does not snap downward. Reaching the real bottom or clicking the
    scroll-to-bottom button clears the per-session anchor; sending another prompt retargets
    the existing spacer rather than clearing it first.
  - When appending while a prompt-slide spacer is present, insert new message DOM before the
    spacer. Appending after the spacer and then retargeting/removing it causes a visible
    lower-then-slide-up motion on follow-up prompts.
  - Do not detach the old prompt-slide spacer at the start of `switchSession()`. `ChatArea`
    may await IndexedDB before replacing messages, and early detach creates a visible flash
    where the old session drops down. Instead, `ChatArea.render()` calls
    `detachStalePromptSlideUpEffect()` immediately before writing the new session DOM.
  - Stream cancellation must preserve any chunks already received. `chat/api.js` normalizes
    non-Error abort throws before setting `isCancelled`; otherwise a thrown abort string can
    become a generic TypeError and make `ChatApp` replace the partial assistant output.
- 2026-05-04: Sidebar filtering now combines text search, starred-only, quick
  updated-time ranges, and an exact local-date picker.
  - Star state is stored directly on session records as `session.starred` with
    optional `starredAt`; toggling it does not change `updatedAt`, so starring a
    chat does not reorder history.
  - The filter popover lives at the right edge of the sidebar search field. The
    shortcut hint is shifted left to make room for the filter button.
  - Session rows show a separate star affordance on hover/focus so users can
    discover starring without opening the overflow menu. Starred sessions keep
    that star visible. The adjacent overflow menu remains compact.
  - The popover is intentionally compact: a single `Starred only` toggle, one
    `Updated` select, and one exact-date input. Avoid expanding quick ranges
    into a grid of buttons; it makes the sidebar feel like a panel instead of a
    small filter menu.
  - When search, starred-only, or date filtering is active, the sidebar scans
    all session records from IndexedDB so older chats outside the paged sidebar
    are still eligible. Message loading is still avoided unless a text query
    needs lazy `conversationSearchText` backfill.
- 2026-04-30: Memory mode now uses `nanomem.augmentQueryAdaptive(...)` for multi-turn follow-ups.
  - New sessions initialize `session.memoryRetrievedContext = { version: 1, entries: [] }`.
  - A memory context entry is appended only after the user approves the memory prompt or auto-include sends it. Denied/skipped prompts are not reusable context.
  - First memory turns still use `nanomem.augmentQuery(...)`. Once a session has approved memory context, later turns call `augmentQueryAdaptive(query, previouslyRetrievedContext, conversationText)` so adaptive skip decisions and prompt crafting both stay behind the nanomem seam.
  - If adaptive retrieval returns `skipped: true` because previously retrieved context already covers the follow-up, root does not create another review prompt, but it does set a one-shot API override from the already-approved context so the frontier model still receives it. `No new relevant memory found` / `No new memory context needed` skips still send the plain prompt.
  - Turns with newly retrieved `assembledContext` receive a review prompt from nanomem that contains only that new context, and root appends only that new context, so the session context does not duplicate itself every turn.
  - The root app relies on the browser entrypoint exposing `memoryBank.augmentQueryAdaptive(...)`; keep `nanomem/src/browser.js` in parity with `nanomem/src/index.js` when adding new browser-safe APIs.
- 2026-04-27: First-user-message chat titles now get an async model-generated summary.
  - The app still writes an immediate local fallback title from the first user message, then after the session has a valid ephemeral OpenRouter key it requests a short title from `google/gemini-3.1-flash-lite-preview`.
  - Title generation is fire-and-forget and failure-tolerant: a failed title request leaves the local fallback title unchanged and does not block the main chat stream.
  - `session.titleSource` protects user edits. Local automatic titles use `local`, generated titles use `generated`, and sidebar/manual renames use `manual`; async generation only overwrites the unchanged local title it started from.
  - Sidebar search matches the visible title, the legacy first-prompt `session.titleSearchText` for non-manual titles, and the bounded full-conversation `session.conversationSearchText` index.
  - `session.conversationSearchText` is built from non-local user/assistant message text, capped at 12k chars per session and 2k chars per message. Long chats preserve the first searchable message plus the most recent turns, trading complete recall for bounded IndexedDB size and predictable search cost.
  - Sidebar search uses literal/token matching, not arbitrary subsequence matching. Otherwise queries like `meaning` can match characters scattered across `means. In ... GPU`.
  - Existing sessions without `conversationSearchText` are lazily indexed during sidebar search and persisted through `chatDB.updateSessionSearchIndex(...)` without broadcasting a session reload.
  - See [SIDEBAR_SEARCH.md](SIDEBAR_SEARCH.md) for the current search algorithm and cap policy.
  - While a local fallback title is waiting for model generation, `session.titleGenerationPending` applies the sidebar title shimmer. Clear that flag on success, failure, empty-title output, missing/expired access, access-acquisition failure, or manual rename so the temporary-title animation does not persist indefinitely.
- 2026-04-26: Sidebar session titles must use attribute escaping when rendered into input values.
  - First-turn titles are generated from the raw user prompt, so prompts that begin with a double quote can produce titles like `"A CPU TEE ...`.
  - `Sidebar.escapeHtml()` is text-node escaping and is not sufficient inside `value="..."`; use the attribute-safe helper for session title inputs or quoted characters will break the attribute and the browser will show the `Untitled Chat` placeholder.
- 2026-04-26: Chat send now treats OpenRouter 402 credit exhaustion as a recoverable ephemeral-key condition.
  - When a pre-stream inference call fails with a 402 whose provider message mentions credits / affordability / `max_tokens`, `ChatApp.sendMessage()` clears the exhausted session key, shows a toast, redeems a fresh key through the normal inference-ticket flow, advances the pending UI from `Requesting ephemeral key` back to `Waiting for response`, and retries the same turn once.
  - The refresh is intentionally limited to pre-stream failures so an already-started partial assistant response is not discarded or replayed unexpectedly.
- 2026-04-20: Investigated where a future pre-ingestion memory gate should live.
  - Root conversation ingestion currently happens through live post-turn extraction and manual `Backfill`; OMF import and panel edits are explicit storage writes, not chat-session extraction.
  - Live extraction runs after successful `sendMessage()` / `regenerateResponse()` completions while the global memory feature is enabled, re-reads the normalized session, and calls `memoryBridge.ingestMessages(...)` regardless of the chat-vs-memory mode toggle.
  - `memoryProcessedAt` is written after live extraction but only consulted by manual backfill; live dedupe is limited to `memoryExtractionInFlight`.
  - Keep semantic "is this worth remembering?" policy in `nanomem`. Root `oa-chat` should only handle session/UI dedupe such as "did a new user turn appear since the last ingest?"
  - `nanomem` still has no semantic pre-gate or ingest-side progress/decision event, and a no-write tool loop returns `status: 'processed'` with `writeCalls: 0`.
- 2026-04-18: Root memory backfill now runs newest-first and can be stopped mid-run.
  - `chat/components/MemoryEditor.js` now sorts backfill candidates by `updatedAt` / `createdAt` descending before calling `nanomem.importData(...)`, so the freshest chats are processed first.
  - The memory-panel `Backfill` button is now a stop control while the run is active. Clicking it aborts the in-flight confidential import request instead of waiting for the entire batch to finish.
  - Closing the memory panel no longer stops that run. `ChatApp` keeps a single long-lived `MemoryEditor` instance, so the current backfill state/controller stay on that object while the modal is hidden.
  - Abort now threads through `nanomem`'s import loop, ingestion tool loop, and OpenAI-compatible fetch client. This is currently used by root backfill; completed chats still get `memoryProcessedAt`, while the interrupted current chat stays eligible for the next resume run.
  - Root now persists `memoryProcessedAt` on each successful/skipped item completion instead of waiting for the entire backfill call to return. That way, if the user stops and immediately starts backfill again, already-finished chats are skipped on the next candidate scan.
  - Root backfill no longer relies on one confidential key for the whole batch. It now ensures a valid key before each chat import, and if a chat fails with `401` / `403`, it invalidates that key, redeems a fresh one when tickets remain, and retries that same chat once before stopping the run.
- 2026-04-13: Dev startup now hard-requires the `nanomem` submodule, not just production build.
  - `npm run dev` now runs the same submodule init step as build before launching `python3 -m http.server -d chat`.
  - This avoids the misleading browser-side `GET /nanomem/browser.js 404` that happened when `chat/nanomem` still pointed at an uninitialized empty submodule directory.
  - If a local clone does not include submodule contents, dev should now fail immediately at startup and point the user at submodule setup instead of looking like an asset-path bug.
- 2026-04-10: Root `oa-chat` now has a browser-only memory mode wired through the `nanomem` submodule.
  - Read [MEMORY_MODE.md](MEMORY_MODE.md) before touching this path.
  - The app-side contract is `chat/app.js -> chat/services/memoryBridge.js -> chat/nanomem/browser.js`; do not import `nanomem/src/...` from app code.
  - `chat/nanomem` is a tracked symlink and production build now hard-requires the `nanomem` submodule. If the bundle suddenly starts failing on `node:*` imports from `nanomem`, check that the browser entry is still pointing at `nanomem/src/browser.js`, not the generic index.
  - Memory mode is a global book toggle persisted in IndexedDB setting `memoryMode`, not a per-session mode.
  - Memory mode now also persists `memoryAutoInclude` and `memoryAgentModel`. The first short-circuits the in-chat approval wait, and the second is used by both live retrieval and memory backfill/import.
  - The retrieval summary is a local-only assistant message with an agent trace and explicit include/skip controls. Regeneration clears older local-only memory status messages after the last user turn before rerunning retrieval.
  - The pending approval row now has `Include memory`, `Always include`, `Skip`, and `Edit prompt`. After memory is approved/sent, the revised prompt remains visible in the local status message, so the approved row only shows the status chip and omits a separate view/edit button. `Always include` is not just a one-shot approve: it flips the global `memoryAutoInclude` setting on and the settings-menu switch should reflect that immediately.
  - Confidential retrieval keys are cached per session on `memoryKey` / `memoryKeyInfo` and must be invalidated on `401` / `403` auth failures.
  - Root `oa-chat` currently does not use that attested SDK path for memory mode. `chat/services/memoryBridge.js` intentionally forces the confidential memory client onto the plain OpenAI-compatible HTTPS path against `https://inference.tinfoil.sh/v1` (`provider: 'openai'`, not `provider: 'tinfoil'`).
  - `nanomem` still supports the SDK-backed, attested Tinfoil transport, but the root app is not opting into it right now.
  - The generic root-app fallback text `Memory context was not added this time. Sending without it.` logs the underlying exception to the browser console as `Memory augment query failed:`. Check that before assuming the failure is in the retrieval prompt itself.
  - Root `oa-chat` now also has the memory filesystem modal shell from `memory-chat`, opened by `Cmd/Ctrl+Shift+M`. Storage editing and local-chat backfill are ported there, but the old `memory-chat` extractor/cancel UI is still not.
  - The settings menu `Data Controls` section now has a dedicated `Memory` row. `Export` uses the same OMF exporter as the memory panel header. `Import` uses a hidden settings-menu file input, then opens the memory panel and hands the selected file into the same OMF preview/merge flow as the panel header import button.
  - The root memory panel now also uses `memory-chat`'s OMF import/export UX, but the actual OMF logic has been moved into `nanomem`. `Export` now goes through `memoryBank.exportOmf()`, and import preview/merge go through `memoryBank.previewOmfImport()` / `memoryBank.importOmf()` instead of app-local format logic.
  - The canonical OMF format doc now lives in [nanomem/docs/omf.md](../nanomem/docs/omf.md). If OMF behavior changes, update that spec in the same change as the implementation.
  - Root `oa-chat` memory backfill is now a real `nanomem` import flow. The `Backfill` button gathers local chat sessions, normalizes them into `{ title, messages, updatedAt }`, and sends them through `nanomem.importData(...)` over the confidential memory key path instead of using a root-app extractor.
  - Backfill progress in root is intentionally light-touch: the header button turns into a stop control while it runs, and completion/stop/error is reported via toast. There is still no separate queue modal.
  - Backfill uses `session.memoryProcessedAt` to skip chats whose `updatedAt` has not changed since the last successful import. If a user reports repeated full re-imports, inspect whether `memoryProcessedAt` is getting saved on the session records.
  - Backfill/import now retries transient confidential-model transport failures inside `nanomem`'s OpenAI-compatible client before an item is marked failed. The current policy is 3 attempts total for network errors plus `408/429/5xx`, with `Retry-After` respected for `429`.
  - Failed backfill items still do not set `memoryProcessedAt`, so even after in-run retries are exhausted they remain eligible for the next manual backfill run.
  - Backfill input must exclude local-only memory-agent status messages (`message.isLocalOnly` / `message.model === 'memory agent'`) and should prefer restored scrubber content when available before falling back to plain message text.
  - The memory agent receives recent in-session conversation text on every run. `chat/app.js` builds it from all non-local-only messages in the current session, then `nanomem` trims it to about 2k chars for outer retrieval and about 3k chars for the inner prompt crafter.
  - That trim is now turn-aware, not a blind tail slice. Long assistant answers are clipped before older user turns, so follow-up retrieval is less likely to lose the previous user question while keeping the most recent turn.
  - Root `oa-chat` now runs background memory extraction after every successful assistant response in both normal chat mode and memory mode. Explicit actions such as `Backfill`, `Import`, or direct memory editing still use the same `nanomem` write path, but the post-turn extractor is no longer gated on the mode toggle.
  - The memory-agent model selector in settings is populated from the confidential model list. The allowed list is currently `kimi-k2-5`, `gpt-oss-120b`, `gpt-oss-safeguard-120b`, `llama3-3-70b`, and `gemma4-31b`. `gemma4-31b` is now the default memory-agent model. `kimi-k2-5` remains allowed and is still the only one marked slow.
  - Root `oa-chat` now mirrors `memory-chat`'s post-response extraction pattern after every successful assistant response while the global memory feature is enabled, regardless of whether the session is currently in chat mode or memory mode. The app kicks off a non-blocking background `nanomem.ingest(...)` run for the current session.
  - That live extraction path uses the same normalized message filter as backfill: local-only messages and `memory agent` status messages are excluded, and scrubber-restored text is preferred over raw stored content when available.
  - The chat controller does not implement a separate extractor. It only orchestrates `ensureMemoryKey(...)` plus `memoryBridge.ingestMessages(...)`; the actual extraction prompt/tools remain inside `nanomem`.
  - Unlike backfill, live post-turn extraction does not skip on `memoryProcessedAt`. This is intentional so regenerations and repeated assistant completions can still re-run extraction if needed. The only dedupe is an in-flight session guard.
  - The memory prompt viewer is no longer the simplified review/API modal. It now uses the same tagged prompt editor/viewer pattern as `memory-chat` (`showTaggedPromptEditor` / `showCiPromptEditor`) and persists edits in `message.ciPromptDraft.editedFullPrompt`.
  - `ciPromptDraft` in root is now a flat prompt shape: `fullPrompt`, optional `editedFullPrompt`, `status`, `linkedUserMessageId`, and `memoryFiles`. `apiPrompt` may still exist as a cached original result, but approval should derive the final send payload from the edited/full prompt via the bridge seam.
  - `nanomem` augment mode now executes `augment_query` as a real tool. The outer retrieval loop only selects files and calls `augment_query(user_query, memory_files)`. A separate prompt-crafter call inside `nanomem` then turns those inputs directly into the final `reviewPrompt`/`apiPrompt`.
  - The inner prompt-crafter prompt is now modeled on `memory-chat`'s later `ciPromptCrafter` flow, not the older "outer retrieval LLM drafts the final prompt" design. The key privacy rule is stronger minimization: names, relationship labels, and locations should be omitted unless the task truly needs them.
  - The crafter should omit generic background facts that only confirm what the current query already makes obvious. Memory should only survive minimization when it changes the answer through real constraints, tradeoffs, personalization, or disambiguation.
  - The inner `augment_query` prompt-crafter no longer sends a forced `max_tokens` cap. It now relies on the provider default and retries empty / invalid / task-less model outputs up to 3 total attempts before surfacing an error.
  - If the final crafted `reviewPrompt` contains no `[[user_data]]` tags, `nanomem` now treats that as "no personal context actually used" and returns a no-memory result instead of surfacing a redundant review prompt.
  - That inner crafter call is now streaming when the provider supports it, but the visible trace only shows coarse phase updates such as prompt-crafting / minimization / finalization. Raw inner prompt-crafter chain-of-thought should not be forwarded into the user-visible memory-agent trace.
  - There is currently no app-imposed timeout on that non-streaming crafter request. If it fails fast, look for transport/model issues or empty-output behavior, not a short client timeout.
  - Because of that change, the memory-agent trace should now show `augment_query(user_query: "...", memory_files: [...])` instead of exposing the already-crafted final prompt in the outer tool-call arguments.
  - `augment_query` is also allowed to finish with `memory_files: []` when nothing relevant exists. That should render as a benign no-memory outcome in the trace, not an executor error.
  - Memory-agent tool rows must render as soon as the LLM emits the tool call, not after executor completion. `nanomem` now emits `started` and `finished` tool events from the tool loop, and `chat/app.js` upserts trace rows by `toolCallId` so the same row transitions directly from a live running state to the final result without an extra inline `working...` / `running...` result line.
  - `nanomem` retrieval now resolves `read_file(...)` through a separator/punctuation-tolerant fallback before declaring `File not found`. This specifically covers model-generated path variants like swapping spaces / `-` / `_`, dropping `./`, or changing slash style.
  - `retrieve_file` path matching now uses the same normalized comparison and skips unreadable/path-only records, so discovery and `read_file` are less likely to disagree on whether a file exists.
  - `nanomem` now canonicalizes resolved memory paths before returning them from retrieval/augment flows. If the model emits a weird-but-resolvable path wrapper like `<|"|personal/family.md<|"|`, the storage layer may still resolve it, but the UI/returned `files` list should now show the real canonical path (`personal/family.md`) instead of the raw malformed tool arg.
  - Augment-mode progress must not blindly claim `augment_query` succeeded. If the executor returns JSON `{ error: ... }`, surface that error text in the Memory Agent trace instead of a fake “crafted augmented prompt…” status.
  - Memory-agent assistant messages are identified by `message.model === 'memory agent'`. The header is intentionally custom: inline book icon, `Memory Agent` label, and a non-hover-fading timestamp to avoid header flash during trace refreshes.
- 2026-03-22: Welcome-panel Turnstile for free preview is now intentionally lazy and single-submit.
  - The Cloudflare script/widget should not load on modal open. Warmup now starts on the first meaningful preview-email edit, not on initial render or invite-code mode.
  - Interactive Turnstile UI remains submit-gated: typing may load/render the invisible widget, but the challenge bubble should only open once the user actually submits the free-preview form.
  - While Turnstile verification is in flight, the welcome access-mode toggle, access input, submit button, and import/invite actions are locked in place. This prevents the validated email snapshot from drifting before `/chat/free_access` is posted.
  - Free-preview submission must use the locally validated email snapshot captured before `requestToken()`, not `this.previewEmail` after async waits.
  - `TurnstileBubble.destroy()` should clean up only its own widget/script DOM. Do not delete `window.turnstile` or globally remove Cloudflare iframes from the page.
- 2026-03-14: Mid-stream message actions are intentionally split between snapshot-safe actions and active-session mutations.
  - Safe actions that should keep working during streaming are copy actions and `forkConversation()`.
  - Assistant/user copy should prefer the live DOM for the actively streaming message because IndexedDB saves lag the UI by design during token streaming.
  - Code-block copy now hooks on `pointerdown` for streaming content so rapid DOM replacement does not eat the click before the handler runs.
  - Streaming code-block updates must patch the existing `.code-block-wrapper` in place; replacing the whole message HTML while the model is still appending code makes the hovered copy button flicker and drops transient copy-feedback state.
  - Forking during streaming must clone a static snapshot of each copied assistant message and clear `streamingPending`, `streamingPhase`, `streamingReasoning`, and `streamingTokens`; otherwise the new session can inherit a fake "still streaming" placeholder.
  - Timeline-mutating actions that intentionally restart generation (`edit`, `resend`, `regenerate`) should interrupt the current stream first, wait for abort cleanup to finish, then apply their normal truncate-and-regenerate behavior.
  - `Edit prompt` is side-effect free until confirm/send. Opening the editor during streaming must not stop the in-flight response; only confirming a non-empty edit should interrupt the stream and regenerate.
- 2026-03-14: The welcome-panel access-mode segmented control must position its indicator with layout-space metrics (`offsetLeft` / `offsetWidth`), not `getBoundingClientRect()`.
  - The welcome dialog is scaled down on narrow/mobile viewports with `transform: scale(...)`.
  - Measuring the active button with `getBoundingClientRect()` inside that transformed dialog returned already-scaled pixels, which made the indicator too narrow and horizontally offset only on mobile.
  - `WelcomePanel` now resyncs that indicator via `ResizeObserver` so late font/layout settling does not leave the selected pill misaligned.
- 2026-03-12: Inline citation styling must not run as a global regex over rendered HTML.
  - Replacing `[\d+]` across the full HTML string corrupted code blocks when code contained array indexing like `choices?.[0]`.
  - The breakage was especially severe because the same pattern appeared inside the code block copy button's `data-code` attribute, which malformed the header DOM and produced bogus code-block titles.
  - `addInlineCitationMarkers()` now traverses DOM text nodes and skips `pre`, `code`, `a`, `button`, and other non-prose containers so only real prose markers become clickable citations.
- 2026-03-12: Fenced code block headers should only use the first token from the Markdown info string.
  - `marked` exposes the full fence info string, not just the language token.
  - The custom renderer now trims to the first non-whitespace token and escapes it before using it in the visible label or `language-*` class, which avoids titles/classes ballooning when extra fence metadata or malformed text appears.
- 2026-03-08: Established this file as the canonical handoff log for ongoing web-app
  state. Future agents should read it before UI-heavy work and update it after learning
  something that is not obvious from the code alone.
- 2026-03-09: Assistant streaming/pending UI now has an explicit two-phase placeholder
  model coordinated across `chat/app.js`, `chat/api.js`, `chat/components/ChatArea.js`,
  `chat/components/MessageTemplates.js`, and `chat/services/networkLogRenderer.js`.
  The phases are:
  - `requesting-key`: The session is actively redeeming tickets for a fresh access token.
  - `waiting-response`: The access token is ready and the app is waiting for reasoning or
    response output to begin.
- 2026-03-09: Pending copy is semantic, not purely cosmetic.
  - Show `Requesting ephemeral key` only when the session actually needs a new or renewed
    access token (`!getAccessToken(session)` or `isAccessExpired(session)`).
  - If the session already has a valid access token, start directly at `Waiting for response`.
  - If the session starts without access, flip to `Waiting for response` when key redemption
    succeeds, at the same boundary that produces the `Ephemeral access key granted` activity.
    Do not wait for the first streamed token, because some providers emit reasoning or answer
    tokens immediately and otherwise make key acquisition look slower than it was.
- 2026-03-09: `Response stream open` in the activity timeline intentionally means
  "HTTP/SSE stream established", not "visible output rendered". Keep this separate from the
  pending placeholder semantics in chat: the label should already be `Waiting for response`
  once access is granted, so the later stream-open event must not visually reset the shimmer.
- 2026-03-09: Avoid DOM replacement during pending-state phase changes.
  - Updating the standalone placeholder by replacing the whole node caused visible header
    flashes and restarted the shimmer.
  - `updateTypingIndicator()` now mutates the existing label in place and no-ops if the
    phase is unchanged.
  - The first real assistant message must replace the existing pending placeholder in place
    via `ChatArea.appendMessage()` rather than removing the placeholder and appending a new
    node, otherwise the header visibly repaints.
- 2026-03-09: Bottom-of-viewport spacing is easy to regress in the assistant pending flow.
  - The standalone placeholder and the streamed assistant message must reserve the same
    bottom footprint as a reasoning-only assistant message.
  - `typingWrapper` was trimmed to match the assistant wrapper, and the pending states now
    include the same invisible action-row spacer used by reasoning-only messages.
  - If you tweak pending copy/layout again, compare three cases at the bottom of the screen:
    `Requesting ephemeral key`, `Waiting for response`, and reasoning-trace-only streaming.
- 2026-03-09: Assistant toolbar buttons (copy/regenerate/fork) are intentionally hidden
  while a response is still in reasoning-only streaming and no actual output tokens/images
  exist yet.
  - The buttons are not reliably actionable during pure reasoning streaming anyway.
  - A placeholder row is kept in the layout to avoid a jump when the buttons appear once
    actual output content starts.
  - Any stream-time DOM insertion that adds text/images before final re-render must target
    the shared action-row anchor, not only the real toolbar row. Otherwise the placeholder
    stays above the new content and creates a temporary gap between the reasoning trace and
    the streaming answer until completion.
- 2026-03-09: Pending shimmer styling is intentionally distinct from the reasoning-trace
  shimmer.
  - Pending labels use a dimmer muted-gray shimmer so they read as pre-output status, not
    as actual reasoning content.
  - Both `Requesting ephemeral key` and `Waiting for response` share the same shimmer effect.
- 2026-03-09: Production build cache-busting matters for pending-state UI correctness.
  - JS entry bundles were already hash-versioned, but `index.html` also references shared
    local CSS/vendor assets that can otherwise remain stale in browser cache.
  - `scripts/build.mjs` now appends the current build hash as `?v=<hash>` to local
    `link[href]` and `script[src]` references in `dist/index.html` so fresh JS does not run
    against stale shared CSS.
  - If users report "the pending UI looks wrong only in one browser" after deploy, inspect
    the built `index.html` first and confirm the versioned asset refs are present.
- 2026-03-14: Android background-streaming support now lives at the transport seam in
  `chat/api.js`, not in the chat controller.
  - `oa-chat` still builds the OpenRouter request body and still parses SSE lines into
    reasoning/content/image/token updates.
  - On Android WebView only, `chat/services/androidNativeInferenceTransport.js` can hand the
    live HTTP/SSE call to native code and poll buffered raw SSE lines back into the existing
    parser.
  - This keeps pending/reasoning/content UI behavior aligned with web/desktop because the
    parser and message-update path remain in JS.
- 2026-03-14: Launcher resume matters for Android background streams.
  - The native transport alone is not enough if the Android shell force-reloads the page on
    launcher re-entry.
  - `MainActivity` now preserves the current page when a `singleTask` launcher intent has no
    deep-link URL, so the in-flight JS promise/state survive Home -> launcher reopen.
