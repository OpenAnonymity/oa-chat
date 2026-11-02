# Authorizing oa-clientd

`oa-clientd` is a local daemon that spends an OA account's inference tickets. This
page is the browser side of authorizing one. The daemon's source and its own guide
are in this repository: [oa-clientd/README.md](../oa-clientd/README.md), with source
layout in [oa-clientd/DEVELOPMENT.md](../oa-clientd/DEVELOPMENT.md).

## Flow

1. The daemon generates a PKCE verifier and a P-256 key pair, and calls
   `POST /auth/daemon/start` with no credentials. It receives a transaction and a
   code to show in the terminal.
2. It opens `<app>/#oa-daemon=<payload>` in the default browser. The fragment holds
   the transaction and the daemon's public key, and browsers never send it to a server.
   A browser with no `oa_returning` cookie is redirected to `/login` first, and browsers
   keep the fragment through that redirect. The landing page replaces itself with
   `/?auth=daemon#oa-daemon=<payload>`: `auth` is a query the first-visit redirect lets
   through, and `getAuthenticationIntent` ignores this value.
3. `createDaemonAuthorizationFlow` runs at the start of `ChatApp.init`, before anything
   awaits, and listens for `hashchange` because a link pasted into an open tab does not
   reload it. `consumeDaemonIntent` removes the fragment and `auth=daemon` at once. It keeps the intent in
   `sessionStorage` (`oa-daemon-authorization`, 15 minutes), because a same-tab sign-in
   redirect must survive. It holds no secret. It is a documented exception to
   "persisted data flows through chatDB": it must exist before an account does.
4. Sign-in uses the ordinary account flows, including creating an account. The dialog
   waits until the account is what the account dialog itself waits for (verified, unlocked,
   scope ready, not busy) and that dialog has closed, so a new account's recovery step is
   never interrupted. Sign-in is offered once; closing it and signing in later still works
   while the intent is fresh. Then `DaemonAuthorizeModal` asks for the terminal's code and a click.
   An account that cannot unlock (`LEGACY_SSO`) is told so as soon as the request is checked.
   A change of account or expiry ends an idle dialog without waiting for a click.
5. Approving is a real re-unlock: the raw master key is zeroed after every unlock, so
   this prompts for the passkey. `accountService.revealMasterKeyForDaemon` uses the
   keyring for Google accounts and a server-verified assertion for username and legacy
   passkey accounts, through a route that creates no session.
6. `sealForDaemon` seals the key to the public key **from the fragment**. If the org
   supplied that key it could substitute its own. The org compares only a hash, which
   catches a tampered link. The key buffer is zeroed in a `finally`.
7. The daemon polls with its verifier, opens the envelope, checks the account and app
   origin, then calls `complete` once for its own session.

Envelope: P-256 ECDH, HKDF-SHA256 (salt: SHA-256 of the transaction; info: label plus
both public keys), AES-256-GCM with the transaction in the additional data.
`test/fixtures/daemon-auth-v1.json` pins the bytes. The Go tests open their copy,
`oa-clientd/internal/oa/account/testdata/daemon-auth-v1.json`, and fail when the two differ.

## Boundaries

- A link alone approves nothing: it needs the code, a click and a passkey. A person can
  still be talked into approving a stranger's request, as with any device flow. The
  dialog warns when the request came from another network; that is a hint, not a check.
- The daemon's session is scoped in its signed payload to `/auth/sync` and
  `/auth/sync/status`. It cannot reach billing, the keyring or account management.
- `#oa-daemon-devices` lists authorized daemons, each with **Revoke**. Revoking ends the
  session. The wallet key does not rotate, so a revoked computer keeps tickets it already
  copied.
- OA Desktop cannot approve: the dialog runs in a normal browser.

## Ticket leases

A daemon publishes an encrypted `ticket-lease` record on its own opaque ID. Sync stores
these in the account-scoped setting `tickets-leases` (never uploaded, not part of the upload
acknowledgment), and drops other devices' expired entries when it stores one.
`consumeTickets` takes unexpired leased tickets **last**. It never refuses because of a
lease: a shortage is only a real shortage, because a lease is not custody and must not stall
this browser or send it towards buying tickets it does not need. `getCount` still counts
leased tickets, so a lease does not trigger auto-reload and the balance shown includes them.

Leases only avoid collisions. Two clients can lease the same ticket and a stale browser can
spend a leased one. The org's single-spend check decides. A daemon redeems only on the dedicated
`POST /api/request_key/nonce`, with no fallback: its required anonymous durable nonce scopes the
redemption, so a browser that lands on the same ticket can never receive the daemon's provider key,
and an older org answers 404 before touching a ticket. This browser stays on `/api/request_key` and
sends no nonce: its reload recovery relies on replay of the exact tokens.

When the org answers 503 `TICKET_REQUEST_IN_PROGRESS`, another request holds a ticket and may
yet roll back, so nothing is archived. The ticket store sets that ticket aside in memory for 60
seconds, because a dead holder can keep it for up to 15 minutes, and the access controller tries
other tickets up to twice before showing the error. `networkProxy` also retries the 503 itself.

Removal records are unchanged: a daemon writes the same per-writer `ticket-removals` record as
any browser installation, and spent or removed tickets merge as before. Sync never redeems.

## One attempt, one sign-in

An attempt is bound to the account and login generation that opened it (`loginGeneration` moves on every
lock and logout), so A to B to A also ends it. After every await, and last thing before the approval is
sent, the account, generation and expiry are checked. The raw key is zeroed as soon as it is sealed, before
the approval goes out. `approve` carries `expectedAccountId`, that bound 16-digit ID and never a fresh read:
the org answers 409 `DAEMON_AUTH_ACCOUNT_MISMATCH` before changing anything if the session is now another
account's. Once the approval has started the dialog never says nothing was sent.

## Dialogs and pending requests

- Each open of `DaemonAuthorizeModal` has an owner token. A list, lookup, render, timer or click from an
  earlier open is ignored, so a late response can never draw over a newer dialog.
- A request stays pending in `daemonAuthorizationFlow` until the dialog accepts it. A newer link replaces an
  idle dialog (declining a review it supersedes) but waits while an approval is running. The devices list waits
  for any open authorization dialog. Closing a dialog clears only its own saved transaction.
- `sessionStorage` `oa-daemon-devices` (`{savedAt}`, 15 minutes, no secret) carries `#oa-daemon-devices`
  across a same-tab sign-in. It is cleared when the list is shown or expires. The list is always that of
  whichever account is signed in when it opens, and closes if the account changes.

## Staging

This integration is on the staging branch, rooted at the deployed staging revision, which carries
the request-timing experiment and so must not reach production, desktop or mobile
([STAGING_REQUEST_TIMING.md](STAGING_REQUEST_TIMING.md)).

The backend goes first, and its runbook `docs/daemon-rollback.md` in oa-org is the source. A worker without
the session scope guard treats a surviving daemon token as an ordinary account session, so:
activate the compatibility release (guard and nonce fence, feature off) on **every** worker, and only
then set `DAEMON_AUTH_ENABLED=true`. Rolling back means the feature off, then the saved compatibility release if
needed. Do not restore an older tree generically: an unguarded rollback needs verified zero daemon Core
sessions first, and it can otherwise widen what a daemon token reaches.

A daemon's lease renewals move the account's `last_sync`, so a browser that is open runs its normal
pull and push cycle after them, on its existing polling cadence.

`test-faults/daemon-authorization.mjs` drives this page in real Chromium against a stand-in org, with a
virtual passkey and no outside network.
