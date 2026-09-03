# Username Passkey Accounts

Username accounts are a pseudonymous alternative to Google sign-in. They use
one WebAuthn passkey for both OA account authentication and local master-key
unlock. They do not have a recovery code.

## User flow

For registration, the user chooses a username and approves one passkey prompt.
The browser generates the random account master key locally, wraps it with the
passkey PRF, completes registration, closes Account, and emits the same
first-account-ready event that opens Membership after first-time Google setup.

For a returning account, the user enters the username and approves one passkey
prompt. The same WebAuthn assertion authenticates the account on the server and
its PRF result unwraps the master key locally. The browser persists the username
and non-extractable key bundle for that OA account. If every synced copy of the
passkey is lost, the encrypted account cannot be recovered; the public username
alone is not proof of ownership.

Usernames are normalized with NFKC, trimmed, lowercased, and limited to 3–32
ASCII letters, numbers, hyphens, or underscores. They must begin and end with a
letter or number. The UI advises users to choose a pseudonym rather than an
email, real name, or handle reused elsewhere because the org stores and can see
the username.

## Protocol and storage

- `POST /auth/init` accepts an optional `username`. Omitting it preserves the
  old empty-body, server-generated account-number flow.
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
hash salt, WebAuthn labels, and UI login option. Username and Google identities
cannot be linked in this version, and an existing account cannot be renamed or
given a username.

Roll out the backend schema and API to every instance before enabling the
frontend username UI. The client deliberately rejects an `/auth/init` response
that does not echo the normalized username, preventing an older backend from
silently creating a legacy account during a mixed-version deployment.

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
