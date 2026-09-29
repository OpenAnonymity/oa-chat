# Username Passkey Accounts

Username accounts are a pseudonymous alternative to Google sign-in. They use
one WebAuthn passkey for both OA account authentication and local master-key
unlock. They do not have a recovery code.

## User flow

The commercial landing page offers Google and username only, with the username
field directly below Google. Submitting a structurally valid username uses
the one-use local route `/?auth=username#username=...` (the app now owns the site root; `/chat/?auth=…` redirects there). The username is in
the fragment, so it is not sent in the document request or HTTP referrer. Chat
waits for its normal account bootstrap, removes the authentication intent and
username fragment with
`history.replaceState`, and looks up the username without a second username form.
**Checking username…** covers that lookup. A returning account then goes
straight to its passkey prompt (2026-09-05, reversing the 2026-09-03 decision
to show a **Welcome back** explanation first): the only card behind the OS
sheet is an untitled "Confirm with your passkey to continue." with a disabled
**Waiting…** pill, and a cancelled or failed prompt leaves that untitled card
in its **Try again** state without re-prompting on its own. A free username
does the same (2026-09-06): the account is reserved and the registration prompt
opens at once behind the same spinner; a cancelled registration leaves the
untitled card with **Try again** and **Back** (Back releases the reservation).
Google accounts behave the same way for both keyring unlock and first-time
keyring setup: opening the dialog prompts at once (once per open). Only the
legacy recovery-code migration and legacy-passkey cards keep a heading. Lookup
failures restore the editable form. A remembered verified,
unlocked username account continues directly into Chat only when its normalized
username matches the submitted username. A different remembered username,
Google account, or legacy account stays saved while the submitted username's
passkey is requested. Cancellation preserves the old session and wallet. After
successful passkey authentication and local key unwrap, the new account binding
and non-extractable keys are saved atomically and its scoped wallet is activated.
There is no separate switch confirmation. The route is only a UI handoff; it does
not authenticate the username or bypass the passkey proof.

Missing usernames and unsupported passkeys retain the normal form. An already
active ceremony refuses another handoff and retains the requested URL intent. A missing username does not clear any saved account binding.
The prompt runs independently of the rest of Chat startup; closing during lookup
invalidates the pending handoff and cannot start a late passkey prompt.

The login dialog is a compact, rounded card (360px maximum width) with a
left-aligned **Log in** heading. Google sits above an **Enter a username**
input, separated by a subtle lowercase **or** divider, and a full-width filled
**Continue with username** button follows the field — the same control as the
landing card: black at all times (near-white in dark mode), lifting on hover,
with the label optically centred and a stroked arrow on the right that becomes
a spinner while authentication runs. All three controls are 48px high. The
shared encryption-card heading uses the Account title's medium (500) weight.
The button handles both account creation and returning login (Enter in the
field does the same); it is disabled only while busy or when passkeys are
unsupported, never by the field being empty. The neutral control follows Chat's
light/dark theme, including autofill. This styling is scoped to username login;
saved legacy and Google encryption-unlock layouts are unchanged. It does not
show introductory copy, pseudonym guidance, separate signup/login buttons, or a
manual account-number switch, and it never treats a canceled or failed passkey
as permission to register.

For registration, the user chooses a username and approves one passkey prompt.
The browser generates the random account master key locally, wraps it with the
passkey PRF, completes registration, closes Account, and emits the same
first-account-ready event that opens Membership after first-time Google setup.
The first-time passkey and finalization stages keep the shared card in its disabled
**Waiting…** state, not a username reminder. Setup keeps ownership of the dialog even if account
or sync notifications publish the new account before finalization returns, so
the signed-in Account summary cannot flash before Membership. Passkey retry
and registration errors remain actionable; returning login is unchanged.

For a returning account, the user enters the username and the browser opens the
passkey prompt immediately. While WebAuthn is active, the untitled encryption
card shows a waiting state; cancellation or failure leaves an enabled **Try again**
action without prompting a second time automatically. The same WebAuthn assertion authenticates the account on the server and
its PRF result unwraps the master key locally. The browser persists the username
and non-extractable key bundle for that OA account. If every synced copy of the
passkey is lost, the encrypted account cannot be recovered; the public username
alone is not proof of ownership.

Usernames are normalized with NFKC, trimmed, lowercased, and limited to 3–32
ASCII letters, numbers, hyphens, or underscores. They must begin and end with a
letter or number. The org stores and can see the username; avoiding a real
name or a handle reused elsewhere remains advisable even though the compact
login dialog no longer displays that explanatory copy.

## Protocol and storage

- `POST /auth/init` accepts an optional `username`. Omitting it preserves the
  old empty-body, server-generated account-number flow.
- With no saved local binding, Continue first requests a username challenge.
  A successful lookup opens the passkey prompt immediately without reserving an
  account. A retry fetches a fresh challenge, avoiding stale proofs after a
  cancelled or failed ceremony. Only an explicit `401 AUTHENTICATION_FAILED` from
  this pre-passkey lookup selects setup. This lookup-only mode does not call
  `/auth/init`; **Create passkey** obtains the account reservation and fresh
  registration challenge immediately before WebAuthn. A name claimed meanwhile
  produces an actionable setup error, not an automatic login or another passkey.
  The service's older immediate-continuation contract is retained for compatibility.
  Saved local accounts bypass initialization and authenticate the submitted
  username rather than rejecting it for differing from the saved account. The username retry card uses **Back** and has no title;
  Google's matching returning card is also untitled and has no logout action.
  Since username authentication has not happened yet, Back returns to the form
  without clearing a saved account. Duplicate submissions are blocked, and closing the
  dialog invalidates in-flight lookup results before any passkey prompt.
- Cancelled initializers/credential operations cannot overwrite newer pending
  accounts. Setup finalization disables dismissal while uploading the wrapper;
  no key may be zeroed during that commit and then installed locally. Modal
  completion/error callbacks also verify their originating open-view version.
- The server atomically reserves each normalized username for ten minutes and
  maps it to a server-generated opaque 16-digit account ID. Completing the
  initial credential write activates the mapping in one database transaction.
  The final registration is checked against that server-side reservation, so
  omitting the username cannot switch it into the legacy recovery-code path.
- WebAuthn `user.id` is always the opaque account ID. The username appears only
  in `user.name` and `user.displayName`, where it gives the passkey a useful
  label without turning the user-chosen name into a protocol handle.
- Username registration requires a resident, user-verified credential with PRF
  support. The client derives the PRF input from the opaque account ID, matching
  the existing encrypted-sync format.
- Challenge and login requests accept `username` or the legacy `accountId`.
  Username responses include the resolved opaque account ID so local
  cryptography remains account-bound. Recovery endpoints reject usernames and
  remain available only to legacy account-number accounts.
- Username challenges include an opaque, single-use `challengeId`, which the
  login request returns. This permits concurrent passkey prompts without one
  public username lookup replacing another prompt's server challenge.
- Username lookups and invalid credentials share a generic authentication
  failure. Every username request is rate-limited by client IP, and failed
  lookups/proofs also consume a hashed-username bucket. A valid owner request
  does not consume that public-name bucket, preventing it from becoming a
  targeted lockout mechanism. Plaintext usernames are not placed in Redis keys
  or logs.

## Compatibility boundaries

Google accounts keep their separate OAuth-authentication plus encryption-passkey
flow. Existing 16-digit passkey accounts keep the original endpoints, recovery
hash salt, and WebAuthn labels. Remembered legacy accounts retain their automatic
account-number login and recovery UI. Manual account-number entry on a fresh
device has been deliberately removed at the product owner's request; this is
a UI availability change, not a backend migration or deletion of old accounts.
Username and Google identities
cannot be linked in this version, and an existing account cannot be renamed or
given a username.

Roll out the backend schema and API to every instance before enabling the
frontend username UI. The client deliberately rejects an `/auth/init` response
that does not echo the normalized username, preventing an older backend from
silently creating a legacy account during a mixed-version deployment.

The landing handoff leaves Google on its existing route. Access-code entry is no
longer shown on the commercial landing page, but account-free redemption remains
available inside Chat's ticket management and standalone oa-chat. Username
onboarding cannot intercept that anonymous ticket-redemption path.

The frontend persists the username next to the opaque account ID only as a local
label and login locator. Account-scoped key bundles, sync identifiers, sessions,
and server authorization continue to use the opaque account ID. On the same
browser, a valid account session and locally persisted non-extractable keys can
restore without another prompt. Otherwise the saved username is prefilled and
one passkey gesture signs in and unlocks; on a new browser the user types the
username and uses a passkey synced by their platform or password manager.

## Privacy boundary

The username is not sent with ticket redemption or inference requests, and it
does not change blind issuance or client-side sync encryption. It is nevertheless
a stable, org-visible pseudonym on account authentication and encrypted-sync
traffic. Reusing an identifying handle can therefore let the org or an observer
associate the account with an external identity. Existing random account-number
accounts remain supported without gaining a chosen public label; the new-account
UI offers either a pseudonymous username or Google.

## Switching accounts across windows (2026-09-28)

Username login serializes the server session exchange with the origin-wide
account-data lock. A local pending-login marker blocks old credential sync and
wallet access while cookies may be changing, including when the login response
is lost. It clears atomically with the newly authenticated identity/key bundle.
An uncertain failure leaves both wallets preserved but requires another sign-in;
reload must not restore the previous keys against an uncertain server session.
A successful later passkey/keyring unlock can clear that marker.

Other windows receive a credential-free notification and lock their in-memory
account. They do not clear shared storage, revoke the new session, or adopt its
wallet using the old keys. Reload restores the new account from the saved bundle.
Scope activation and encrypted sync also check the saved binding under the data
lock, so safety does not depend on prompt BroadcastChannel delivery. A superseded
native ceremony is refused before it can replace the shared session.

### Existing windows after a successful switch

An origin-wide sign-in completion notification restores the new saved binding in
other windows without another passkey prompt or page reload. The start notification
locks old credentials immediately; reconciliation waits for the account-data lock,
so it cannot read a half-written key bundle. A pending exchange marker remaining
after that lock becomes available means authentication did not commit: keep the
marker, refuse old keys, and return to manual sign-in.

Restoration checks bundle ownership and the shared session before loading keys,
then activates the account scope with binding checks. It never adopts another
account's wallet. Focus/visibility and the send preflight catch missed messages.
While restoring, the existing account loading surface hides the old identity and
closes on success. Sending is blocked until the account is verified, unlocked,
and its scope and initial ticket sync are ready. Only event type and account ID
are broadcast locally; keys, tickets, chats and prompts are not broadcast.
