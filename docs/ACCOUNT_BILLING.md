# Premium Subscription Tickets

The initial billing integration remains disabled by default and is validated in
Stripe test mode before staging activation:

```text
OA Premium — $35/month — 300 tickets per full monthly period
```

The browser can still be used without an account. An authenticated billing
identity is needed only for Checkout, subscription status, the Stripe portal,
and claiming a paid allowance. Ticket redemption remains accountless.

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

Stripe and oa-org can learn that an account claimed an N-ticket allowance, but
the Blind RSA protocol prevents the signed blinded requests from being linked
to the finalized tickets later redeemed. The final wallet records contain only
`blinded_request`, `signed_response`, `finalized_ticket`, and `created_at`.

The temporary development identity is created only when both oa-chat and
oa-org use loopback. Production/non-loopback use must authenticate through the
account adapter. This seam is intended to be replaced by SSO.

## Recovery

Generating and finalizing an entitlement-sized allowance is chunked in groups
of ten. A full period is 300 tickets; the first period may be prorated to a
smaller positive count. The browser stores pending state in the separate
`oa-billing-local-v1` IndexedDB database,
which is not part of chat settings, encrypted sync, account backup, or export.
It records the account scope, issuer fingerprint, blinded requests, serialized
client-only unblinding state, signed responses, and progress.

Closing the modal does not stop active work. Reloading resumes the saved phase.
Changing accounts aborts active work but leaves the old account's recovery
record intact. The record is removed only after every finalized ticket is
durably written to the ordinary wallet and read back from IndexedDB. A failed
wallet write keeps the complete signed/finalized recovery record for retry.

The browser holds a scope-specific Web Lock for the full preparation and
recovery operation. This prevents two tabs for the same billing identity from
overwriting one another's pending state. Browsers without Web Locks fail closed
instead of attempting a paid claim unsafely. One frozen authentication scope
and header set is used throughout each operation; an account change aborts it.

Claim responses use a strict field allowlist. Account, Stripe, subscription,
entitlement, claim, or server-finalized ticket metadata is rejected before any
wallet import.

A Checkout session awaiting webhook reconciliation is also saved locally under
its billing-account scope. Multiple account scopes retain separate recovery
records. Polling uses one frozen identity and is aborted on account switch, so a
response for one account cannot replace the displayed status or clear another
account's Checkout recovery.

Wallet import preserves archive precedence. If a crash leaves the pending claim
after some imported tickets have already been spent, recovery recognizes those
archived tickets as durably imported and never moves them back to the active
wallet.

Only one available entitlement is prepared automatically per local billing
activation. Any additional paid allowances require an explicit preparation
action whose label uses the server-provided `next_claim_ticket_count`.

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
- `POST /api/billing/portal` opens Stripe's customer portal.
- `POST /api/billing/tickets/claim` submits exactly the server-reported next
  allowance: 300 for a full period or the prorated first-period count.
- `POST /api/stripe/webhook` verifies the raw signed Stripe event.

No billing API accepts an account identifier in its JSON body. No billing
identifier is sent to `/api/request_key` or `/api/split_tickets`.
