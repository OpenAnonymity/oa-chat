# oa-clientd

`oa-clientd` is a local OpenAI-compatible API paid with your OA account's
inference tickets. It runs on your computer, syncs your account's encrypted
ticket wallet, and serves streaming chat completions to any OpenAI client.

| | |
| --- | --- |
| Pays with | OA account inference tickets; it never buys any |
| Local API | `http://127.0.0.1:8797/v1` |
| Profile | `<user config dir>/oa-clientd`, or `OA_CLIENTD_CONFIG_DIR`, or `--config-dir` |
| Service | `oa-clientd.service` (systemd user unit, in Linux archives) |
| Delegation route | `POST /v1/oa/delegate` |
| Platforms | macOS and Linux, `amd64` and `arm64`; Windows is not supported |

## Setup

```sh
oa-clientd setup                 # OA production
oa-clientd setup --env staging   # OA staging; use a separate --config-dir for each
oa-clientd serve
```

Authorizing a computer needs an OA deployment that offers daemon authorization.
It is being introduced on OA staging first. Against a deployment without it,
`setup` and `login` stop with "this OA deployment does not offer daemon
authorization yet"; that first request carries no account credential.

Setup opens your default browser at OA, with the request in the link's fragment.
Sign in the way you normally do, or create an account. Then, in the dialog:

1. Check what is asking, and read what approving allows.
2. Type the code your terminal shows. A link alone can never approve anything.
3. Choose **Approve with passkey** and answer your passkey prompt.

The daemon then syncs your tickets. If no browser can open (SSH, no display), it
prints the link to open on a device you trust. Ctrl+C withdraws the request, and
it expires after 10 minutes. Nothing is ever bought: when you run out, requests
fail with `insufficient_tickets`. Add tickets in OA and they arrive on the next
sync.

A browser with auto-reload turned on can still buy tickets on its own schedule, for
example when this client has spent the wallet down to zero while that browser is
open. That is the browser's existing consent, not this client. Leased tickets still
count in that browser's balance, so a lease alone does not trigger a reload.

Then point an OpenAI client at `http://127.0.0.1:8797/v1`. Localhost inference
needs no key by default; `oa-clientd config --require-api-key true` requires the
one printed by `oa-clientd config --api-key`.

| Command | What it does |
| --- | --- |
| `setup [--env staging\|production] [--no-browser]` | Creates the profile, authorizes this computer and syncs |
| `serve [--verbose \| --semi-verbose]` | Runs the API and background sync |
| `status` | Account and ticket counts, with no network request. Counts exclude tickets other clients reserve; a ticket's validity is checked when it is spent |
| `sync` | Syncs once |
| `list-models` | Model IDs and ticket costs, anonymously |
| `login [--no-browser]` | Authorizes this computer again |
| `logout [--force]` | Final sync, release of reserved tickets, session revocation, erasure |
| `mcp` | MCP on stdin/stdout for the running daemon's strict delegation |
| `config` | Shows or changes settings; restart `serve` to apply |
| `version` | Prints the version |

## Which accounts work

| Account | Supported | How the key is unlocked |
| --- | --- | --- |
| Google, with an encryption passkey | Yes | Keyring passkey, evaluated in the browser |
| Username | Yes | Account passkey, with a server-verified assertion that creates no new session |
| Legacy account number with a PRF passkey | Yes, from a browser that already remembers it | The same route as username |
| Google not yet migrated from a recovery code (`LEGACY_SSO`) | Not until it migrates; the dialog says so | |
| A passkey without PRF, or a lost passkey | No: the wallet cannot be unlocked anywhere | |
| OA Desktop as the approving app | No: approve in a normal browser | |
| No account, local tickets only | No: this client syncs an account wallet | |

Tickets from a membership or ticket pack reach the wallet when a browser claims
them. `oa-clientd` does not claim entitlements itself, so after a renewal open OA
once in a browser; those tickets then sync here.

## Sync and double spending

Tickets stay in the account's end-to-end encrypted wallet, in the browser's own
blob format. `oa-clientd` is another device on it:

- **Consumed always wins.** A ticket spent anywhere is spent everywhere, and this
  client remembers spent tickets even if a stale device drops the record.
- **Leases only avoid collisions.** This client publishes an encrypted lease on up
  to `ticket_lease_size` tickets (default 30), never more than half the wallet, taken
  from the wallet's tail, and renews it during sync. Lowering the setting releases the
  excess on the next sync, except tickets reserved for a request in flight. Browsers
  with lease support skip leased tickets once they have synced. A lease ends on
  `logout`, or by itself after 6 hours, so a stopped or lost daemon cannot strand
  tickets. Leases are not custody: replicas are stale by design, two clients can
  lease the same ticket, and an older browser ignores them.
- **The org decides, one request at a time.** Each redemption goes to
  `/api/request_key/nonce` with a random, anonymous `X-OA-Redemption-Nonce`,
  committed to disk before the first send. An org without that route answers 404,
  so this client reports `org_unsupported`, spends nothing and never falls back. The
  org's one-show replay and request ownership key on it, while spent state stays
  global per ticket. So a retry or restart recovers this request's key, and another
  client holding the same tickets can never receive that key.
- **Losing a race loses nothing untouched.** While another request holds a ticket
  provisionally, the org answers `TICKET_REQUEST_IN_PROGRESS` and nothing is
  discarded; this client tries other tickets and that one again later. A definitive
  `TICKET_ALREADY_SPENT` archives only the named ticket; the org releases the rest
  of the request. If a request's device dies before committing, its own client can
  resume within 15 minutes, and afterwards another request may take the unspent
  ticket. The dead request is fenced, so it cannot then commit a key.
- **Interrupted redemption is exact.** Tickets and the nonce are reserved on disk
  before the first send. Only a later request at that price resends them, and it
  uses the key it recovers; nothing redeems in the background, because a resend may
  be the first real spend. If the org keeps refusing one reservation, for example
  because its station is gone, later requests use other tickets and it is retried
  every 5 minutes, with at most two parked per price. `status` shows tickets waiting
  this way.
- **Browsers keep their existing scope.** A browser sends no nonce, so two browsers
  selecting the same tickets still share the org's replay, as they did before. A
  browser and this client never do. Browsers are unchanged here because their
  retry-after-reload recovery depends on that replay.

## Privacy

Your account and your inference stay separated by construction:

- Account traffic (`/auth/daemon/*`, `/auth/sync*`, session refresh, sign-out) and
  anonymous traffic (`/api/request_key`, model lists, verifier, provider) use two
  HTTP clients. The account client refuses every other route. The anonymous client
  refuses `/auth` and `/api/billing`, strips cookies and session headers, and
  refuses redirects. Finalized tickets carry no account credential. Prompts go
  directly to the provider, never through an OA service.
- The org receives only ciphertext it cannot open: the sealed sync key during
  authorization, then opaque wallet blobs. The browser seals the key to a public
  key it reads from the URL fragment, never from the org, so the org cannot
  substitute its own.
- Redemption never triggers a sync. Background sync runs on its own jittered
  timer, as the browser's deferred identity-backed sync does. **The org can still
  observe authenticated sync timing and ciphertext sizes and attempt to correlate
  them with redemption.** A daemon syncs in the background whether or not a browser
  is open, so this surface is larger than for an occasional browser session. Users
  who need the strongest identity-unlinkability should use the identity-free flow.
- **Daemon use is visible as a class.** Redemptions carry a fixed `OA-Clientd/1`
  User-Agent and a nonce header, which browsers do not send, and the org stores the
  User-Agent with each key's request record. Daemon sessions are also marked, so the
  org knows which accounts have authorized one. While few people use oa-clientd on a
  deployment, a daemon redemption narrows to those accounts, even over Tor. Blind
  signatures still prevent linking a specific ticket to its issuance.
- Direct HTTPS exposes this computer's IP to the org, verifier and provider. Set
  `relay_url` for a relay or Tor; in Tor mode account traffic has its own identity,
  and each request gets a fresh identity and key. There are no conversation-scoped
  Tor circuits, so Tor mode spends tickets per request.
- Outside Tor, calls within `key_reuse_window_seconds` (default 60) can share a
  provider key and are linkable by the provider, across chats and local clients.
  Set it to 0 for a fresh key per request, which spends tickets per request.

Your wallet's sync key and tickets live on this computer. They are protected by
file permissions (`0600`, in a `0700` directory; links and loose modes are
refused), not by a passphrase or the OS keychain. Anyone who can read your profile
can spend your tickets. Full-disk encryption is recommended.

## What authorization allows, and how to end it

The session is limited to the encrypted sync store. It cannot reach billing, the
keyring, or account settings, and it has no way to start a charge.

- `oa-clientd logout` syncs, releases the lease, revokes the session and erases
  the sync key, tokens and local wallet. If the final sync fails, or this computer is
  no longer authorized and holds unsynced spends, nothing is erased unless you pass
  `--force`. A new `login` ends this computer's earlier session.
- From a signed-in browser, open OA with `#oa-daemon-devices` to see and revoke
  authorized computers. On its next sync, a revoked daemon erases the sync key and
  tokens and stops serving inference until `oa-clientd login`. Its wallet file stays
  so unsynced spends are not lost; signing in to the same account resumes it.

**Revocation has limits.** The wallet key does not rotate. A computer you no longer
trust keeps the key and any tickets it already copied. Revocation stops its access
to the encrypted store, but tickets it holds stay redeemable. If you lose a computer,
revoke it and spend or move your tickets.

## Tickets and keys

Before any spend, the client checks each ticket's shape, OA's fixed challenge, its
issuer generation and the issuer's RSA-PSS signature against the org's current
public key, and refuses others without deleting them from the wallet. Prices come
from the live `/chat/model-tickets` and `/chat/pinned-models`; an unknown or disabled
model costs nothing because it fails first.

Each new key must then pass, in order: its shape, the ticket count charged, its
lifetime against its tier, the org's Ed25519 signature when the org publishes a
key, and a matching `verified` answer from the verifier for that exact station and
key. Station signatures are checked by the verifier. The narrow outage rule from
the privacy model applies: an outage key needs a checkable org signature and is
labelled `verifier-unavailable`. A hard failure discards the key, and its tickets
stay spent.

## One profile, one account

A profile's wallet binds it to one account and one OA deployment. Every sync, final
sync, and account change on a profile runs under `sync.lock`, across processes, so a
delayed push cannot overwrite a newer final record. The login that finishes first
binds an empty profile; a later login for another account is refused and its new
session revoked. Signing in again to the same account works while `serve` runs. If
the wallet and session ever disagree on account or deployment, all spending stops
with `account_mismatch`.

A request already on the network when a client is killed can still land later; no
client lock can recall it. Consumed state still wins on the next sync by any device.

## Files

| File | Holds |
| --- | --- |
| `config.json` | Settings and the local API key |
| `session.json` | Sync key and session tokens |
| `wallet.json` | Encrypted wallet's local replica, including tickets |
| `*.lock` | Stable lock inodes; leave them in place |

Saves are atomic and synced. A profile is bound to one OA deployment and one account;
use `--config-dir` for another. A login that approves a different account than the
profile's wallet is refused before any session exists.

## Configuration

`oa-clientd config --help` lists settings. Reviewed deployments are compiled in:
OA `production` and `staging`. No server answer can change where the browser is sent.

Environment: `OA_CLIENTD_CONFIG_DIR` selects the profile. Environment proxy variables
are ignored.

## Optional features

| Feature | Settings |
| --- | --- |
| Prompt rewriter | `config --rewriter-url --rewriter-model --rewriter-api-key-env --rewriter-notice --rewriter-instruction-file`, `--rewriter-clear` |
| Web search, on by default | `config --web-search false` |
| Cover traffic, Tor only | `config --cover-urls --cover-rate --cover-concurrency`, `--cover-clear` |
| Strict delegation and MCP, Tor only | `POST /v1/oa/delegate`, `oa-clientd mcp` with tools `oa_delegate`, `oa_list_models` |
| Diagnostics, which log private content | `serve --verbose`, `serve --semi-verbose` |

A rewrite runs before any ticket is selected, so a failed rewrite spends nothing.
Uncached user text goes directly to the rewriter you configured, outside Tor and OA.

## Building

From the root of the `OpenAnonymity/oa-chat` repository, with Go 1.25 or newer:

```sh
cd oa-clientd
go build -o bin/oa-clientd ./cmd/oa-clientd
go test -race ./...
OA_CLIENTD_ENV=staging scripts/build-oa-clientd.sh 0.1.0-staging.1 /path/to/artifacts
```

The script cross-compiles `darwin/{arm64,amd64}` and `linux/{amd64,arm64}` with
`CGO_ENABLED=0` and writes one tarball per target plus a `.sha256` file to the
output directory. Each tarball holds `oa-clientd`, `LICENSE`, this `README.md` and
`DEVELOPMENT.md`; in the tarball, links to other repository files point at the
source commit the archive was built from. Linux tarballs also hold
`oa-clientd.service`, a systemd user unit that runs `/usr/bin/oa-clientd serve`
(edit `ExecStart` if you install elsewhere). Without
`OA_CLIENTD_ENV`, setup defaults to OA production. Package-manager formulas are not
part of this source tree.

Source layout and maintenance rules are in [DEVELOPMENT.md](DEVELOPMENT.md). The
browser side of authorization is described in
[docs/DAEMON_AUTHORIZATION.md](../docs/DAEMON_AUTHORIZATION.md), and the account
ticket privacy model in [docs/PRIVACY_MODEL.md](../docs/PRIVACY_MODEL.md).
