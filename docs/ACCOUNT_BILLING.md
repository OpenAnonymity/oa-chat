# Premium Subscription Tickets

The initial billing integration remains disabled by default and is validated in
Stripe test mode before staging activation:

```text
OA Premium — $35/month — 300 tickets per full monthly period
Premium ticket pack — $7 one time — 50 tickets
```

The browser can still be used without an account. An authenticated billing
identity is needed only for Checkout, subscription status, the Stripe portal,
and claiming a paid allowance. Ticket redemption remains accountless.

The ticket-pack offer is rendered only when oa-org supplies a validated
`ticket_pack` plan and the authenticated status marks the subscription eligible.
Stripe states `active` and `trialing` qualify, including an active subscription
with `cancel_at_period_end=true`. Signed-out, free, past-due, unpaid, paused,
incomplete, and canceled accounts see no pack copy or control. The browser uses
the server-provided amount and count to render “Buy 50 tickets — $7.”

An eligible subscriber may buy packs sequentially without a lifetime limit, but
only one open Checkout or paid/unclaimed pack is allowed at a time. The purchase
button is replaced while Checkout is pending or the current pack is being
prepared. An unprepared paid pack remains recoverable across month boundaries
until its 50 blind signatures commit. Once prepared, its tickets expire at the
next first-of-month 00:00 UTC global issuer rotation; the exact timestamp is
returned by oa-org and disclosed beside the purchase control before Checkout.
Blind issuance deliberately cannot restore only an identified subscriber's
unused tickets after rotation without weakening unlinkability. Billing-enabled
oa-org deployments rotate the one global issuer at the first instant of each
UTC calendar month, matching the subscription renewal boundary. The rotation
invalidates every ticket from earlier generations immediately; it is global,
not subscriber-specific, because every account shares the same unlinkable
issuer public key.

The initial Welcome screen labels the paid path **Register and upgrade** and opens the public
Premium modal before asking for authentication. If Checkout then needs an
account, Google SSO is the only registration option shown. Successful sign-in
consumes a session-scoped intent and
continues to Stripe exactly once. Cancelling that account step clears the intent
and returns to Premium, so a later account action cannot trigger a surprise
redirect.

The public modal enables the Checkout action only after oa-org returns a
validated price and ticket allowance. An upstream failure replaces loading
placeholders with a clear unavailable state and a retry control; it never lets
the user continue from an unvalidated plan.

On a Stripe success return or reload recovery, reconciliation waits for the
persisted OA account and background SuperTokens session verification. The UI
shell is constructed before `accountService.init()`, so its initial
`sessionVerified=false` snapshot is not treated as a final sign-out and cannot
skip paid-ticket preparation.
Cancellation returns wait without a fail-open timeout until that account scope is
known, so a slow restore cannot later resume a Checkout the user cancelled.

## Privacy Boundary

```text
Subscription claim
  billing identity + entitlement-sized blinded requests (up to 300)
              ↓
  oa-org validates a paid entitlement and blind-signs the requests
              ↓
  browser finalizes and stores that allowance as ordinary tickets

Later redemption
  ordinary finalized ticket(s), with no account or Stripe metadata
              ↓
  existing oa-org ticket redemption and station flow
```

Top-up preparation uses the same boundary. Its request adds only a 64-character
opaque `claim_ref` so oa-org selects the paid 50-ticket entitlement rather than
an older subscription allowance. The reference and all Checkout/payment data
remain in billing recovery state; they are never copied into finalized tickets,
wallet exports, shares, redemption requests, or browser operational logs.

Stripe and oa-org can learn that an account claimed an N-ticket allowance, but
the Blind RSA protocol prevents the signed blinded requests from being linked
to the finalized tickets later redeemed. The final wallet records contain only
`blinded_request`, `signed_response`, `finalized_ticket`, and `created_at`.

Account-authenticated billing claims use the narrow SuperTokens transport
directly to the configured org unless the deployment supplies a first-party
same-origin reverse proxy. The org may therefore observe the subscriber's IP
and claim timing in addition to their billing identity. This is metadata about
identity-bound issuance, not a link to the blinded ticket tokens: later
redemption remains credential-free and uses the accountless proxy path.

The temporary development identity is created only when both oa-chat and
oa-org use loopback. Production/non-loopback billing uses the narrow
SuperTokens session transport for `/api/billing`; no access or refresh token is
exposed to the renderer or written into an `Authorization` header. Accountless
ticket redemption remains outside that transport and forces omitted credentials.

## Recovery

Generating and finalizing an entitlement-sized allowance is chunked in groups
of ten. A full period is 300 tickets; the first period may be prorated to a
smaller positive count. The browser stores pending state in the separate
`oa-billing-local-v1` IndexedDB database,
which is not part of chat settings, encrypted sync, account backup, or export.
It records the account scope, issuer fingerprint, blinded requests, serialized
client-only unblinding state, signed responses, and progress. Top-up records also
carry `source: "topup"`, the local `claimRef`, and `targetCount: 50` until import.

Closing the modal does not stop active work. Reloading resumes the saved phase.
Changing accounts aborts active work but leaves the old account's recovery
record intact. The record is removed only after every finalized ticket is
durably written to the ordinary wallet and read back from IndexedDB. A failed
wallet write keeps the complete signed/finalized recovery record for retry.

Before generating, claiming, resuming finalization, and importing, the client
fetches the current issuer public key and compares its RFC 9578 SHA-256 key ID
with the pending record. The claim carries that expected key ID through the
server's fenced issuance path. A mismatch means the month/key epoch changed:
the client deletes the old local recovery, imports no ticket, and reports
`BILLING_ISSUER_ROTATED` so
the user can retry against the current allowance. This also closes the boundary
race where the browser fetched the old key immediately before oa-org rotated;
the server releases any uncommitted reservation, and the next attempt discards
the stale blinded state before reuse.

Recovery records created before the RFC key-ID fence stored SHA-256 of the
base64 public-key string. On the first compatible resume, the client accepts
that legacy fingerprint only when it matches the currently fetched key, then
durably rewrites the record to fingerprint version 2 (the RFC key ID) before
claiming, finalizing, or importing. This preserves already signed recovery
without weakening rotation detection.

The browser holds a scope-specific Web Lock for the full preparation and
recovery operation. This prevents two tabs for the same billing identity from
overwriting one another's pending state. Browsers without Web Locks fail closed
instead of attempting a paid claim unsafely. One frozen authentication scope
and header set is used throughout each operation; an account change aborts it.

Claim responses use a strict field allowlist. Account, Stripe, subscription,
entitlement, claim, or server-finalized ticket metadata is rejected before any
wallet import.

A Checkout session awaiting webhook reconciliation is also saved locally under
its billing-account scope. Storage version 3 keeps `subscription` and `topup`
sessions in separate slots for each scope; version-2 sessions migrate as
subscription sessions. Multiple account scopes retain separate recovery records.
Polling uses one frozen identity and is aborted on account switch, so a response
for one account cannot replace displayed status or clear another account's or
purchase kind's Checkout recovery. A failed subscription recovery does not block
the independent top-up recovery slot.

A top-up Checkout remains recoverable after reload, tab closure, crash, or lost
connectivity. While it is pending, the modal shows **Continue ticket-pack
Checkout** and **Cancel Checkout**. Continue reuses the same server session;
Cancel asks oa-org to expire that exact Stripe session and resets immediately
only after Stripe confirms expiration. There is no second confirmation dialog.
An open unpaid pack expires automatically after 30 minutes, and the next status
refresh clears stale local Checkout recovery. A completed payment that is still
processing keeps both recovery controls and cannot be replaced by a new
Checkout.

The Stripe Back/Cancel return uses a small tab-scoped `sessionStorage` record to
identify the Checkout opened by that tab. It never guesses from the durable
account-scoped record, so a stale Stripe tab cannot cancel a newer Checkout. If
payment wins an expiration race, oa-org creates or preserves the entitlement and
the browser begins its normal 50-ticket preparation. Tab closure is not proof of
cancellation: there are deliberately no `beforeunload`, `sendBeacon`, or
tab-close cancellation handlers. The tab-scoped return record contains only the
test Checkout Session ID and is excluded from sync, exports, wallet state,
tickets, and logs.

Checkout recovery and claim recovery are intentionally distinct. Checkout
recovery ends after confirmed cancellation, payment, or automatic expiration.
Once payment creates an entitlement, the IndexedDB claim record remains
authoritative until every ticket is durably imported, even if the server has
already returned to `ready`.

Wallet import preserves archive precedence. If a crash leaves the pending claim
after some imported tickets have already been spent, recovery recognizes those
archived tickets as durably imported and never moves them back to the active
wallet.

Only one available entitlement is prepared automatically per local billing
activation and entitlement identity. Subscription allowances use the Stripe
`current_period_end` as that identity, so a long-lived tab can automatically
prepare a later paid month; top-ups use their `claim_ref`. Any additional paid
allowances require an explicit preparation action whose label uses the
server-provided `next_claim_ticket_count`.
After a top-up payment, the browser automatically prepares the referenced pack.
If claiming has committed but wallet import has not, local recovery overrides a
server `ready` state and continues blocking another purchase until IndexedDB
round-trip verification succeeds. Purchasing never redeems a ticket
automatically; it only fills the ordinary local wallet.

## Product and Checkout copy

The Stripe Product attached to the configured Price must be named **OA Premium**
and use this description:

> 300 privacy-preserving tickets per full monthly period. Your first payment and
> ticket allowance are prorated until the next renewal.

The recurring Price remains $35/month, renews at the start of the next month,
and uses Stripe proration for the initial charge. Checkout also receives this
code-controlled helper from oa-org:

> Your first payment and ticket allowance are prorated. Full monthly periods
> include 300 tickets.

The Stripe catalog and test Checkout must contain no reference to “OA Starter
Monthly” or “500 Tickets.”

## Interfaces

- `GET /api/billing/plan` loads Stripe-validated public plan data.
- `GET /api/billing/status` reports subscription and aggregate batch state.
- `POST /api/billing/checkout` creates or reuses a test Checkout session.
- `POST /api/billing/checkout/complete` reconciles a delayed webhook.
- `POST /api/billing/topups/checkout` creates or reuses the one-time pack Checkout.
- `POST /api/billing/topups/checkout/complete` reconciles its delayed payment.
- `POST /api/billing/topups/checkout/cancel` expires the authenticated account's
  matching unpaid pack Checkout or reports that payment won the race.
- `POST /api/billing/portal` opens Stripe's customer portal.
- `POST /api/billing/tickets/claim` submits exactly the server-reported next
  allowance: 300 for a full period, the prorated first-period count, or exactly
  50 with the top-up `claim_ref`.
- `POST /api/stripe/webhook` verifies the raw signed Stripe event.

No billing API accepts an account identifier in its JSON body. No billing
identifier is sent to `/api/request_key` or `/api/split_tickets`.
