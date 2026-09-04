# Username Passkey Accounts

Username accounts are a pseudonymous alternative to Google sign-in. They use
one WebAuthn passkey for both OA account authentication and local master-key
unlock. They do not have a recovery code.

## User flow

The commercial landing page places a username field directly below Google and
before the access-code divider. Submitting a structurally valid username uses
the one-use local route `/chat/?auth=username#username=...`. The username is in
the fragment, so it is not sent in the document request or HTTP referrer. Chat
waits for its normal account bootstrap, removes the authentication intent and
username fragment with
`history.replaceState`, and looks up the username without a second username form.
**Checking username…** covers that lookup. Returning accounts then see the same
**Welcome back → Unlock** encryption explanation as Google; new accounts see
**Encrypt your data → Create passkey**. The explicit action opens the passkey.
This supersedes the earlier direct-to-passkey behavior at the user's request.
Lookup failures restore the editable form; passkey cancellation keeps **Try again**
on the explanation, without automatically retrying. A remembered verified, unlocked account continues
directly into Chat without opening Account. The route is only a UI handoff; it
does not authenticate the username or bypass the passkey proof.

Missing usernames, unsupported passkeys, or an already-busy account retain the
normal form. Saved legacy and Google unlock/recovery surfaces are not bypassed.
The prompt runs independently of the rest of Chat startup; closing during lookup
invalidates the pending handoff and cannot start a late passkey prompt.

The login dialog is a compact, rounded card (360px maximum width) with a
left-aligned **Log in** heading. Google sits above an accessible **Username**
input with an attached stroked arrow, separated by a subtle lowercase **or**
divider. Both controls are 48px high. This divider is modal-only: the landing
still places Username directly below Google. The supplied **1a** reference informs
the 16px Google text, 18px arrow, and tightly set 22px medium heading. Google uses
regular weight for a lighter appearance; OA's system font and colors are retained.
The shared encryption-card heading uses the Account title's medium (500) weight.
The arrow is named **Continue**
for assistive technology and uses the
same handler as Enter. It becomes a disabled spinner during authentication.
The neutral control follows Chat's light/dark theme, including autofill. This
styling is scoped to username login; saved legacy and Google encryption-unlock
layouts are unchanged. It does not show introductory copy, pseudonym guidance,
separate signup/login buttons, or a manual
account-number switch. Continue handles both account creation and returning
login; it never treats a canceled or failed passkey as permission to register.

For registration, the user chooses a username and approves one passkey prompt.
The browser generates the random account master key locally, wraps it with the
passkey PRF, completes registration, closes Account, and emits the same
first-account-ready event that opens Membership after first-time Google setup.
The first-time passkey and finalization stages keep the shared card in its disabled
**Waiting…** state, not a username reminder. Setup keeps ownership of the dialog even if account
or sync notifications publish the new account before finalization returns, so
the signed-in Account summary cannot flash before Membership. Passkey retry
and registration errors remain actionable; returning login is unchanged.

For a returning account, the user enters the username, chooses **Unlock** on the
Welcome back card, and approves one passkey prompt. The same WebAuthn assertion authenticates the account on the server and
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
  A successful lookup selects the Welcome back card without reserving an account.
  Its Unlock action fetches a fresh challenge, avoiding stale proofs if the user
  pauses on the explanation. Only an explicit `401 AUTHENTICATION_FAILED` from
  this pre-passkey lookup selects setup. This lookup-only mode does not call
  `/auth/init`; **Create passkey** obtains the account reservation and fresh
  registration challenge immediately before WebAuthn. A name claimed meanwhile
  produces an actionable setup error, not an automatic login or another passkey.
  The service's older immediate-continuation contract is retained for compatibility.
  Saved local accounts bypass initialization and use their existing login and
  account-mismatch checks. The username card uses **Back**; Google's returning
  **Welcome back** card has no logout action. Since username authentication has
  not happened yet, Back returns to the form
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

The landing handoff deliberately leaves Google and access-code navigation on
their existing routes. The username field and access-code field share the same
visual control styles, but their submit handlers and query parameters remain
separate so username onboarding cannot intercept anonymous ticket redemption.

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
