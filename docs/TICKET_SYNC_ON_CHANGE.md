# Ticket sync after local changes

Production-web candidate, 2026-10-19. User explicitly approved the timing/privacy tradeoff
for mobile-style ticket synchronization on web and desktop. Based on deployed web core `d76e2096360874b2414a9820bc66f1e726fcc9f0`, in branch
`release/production-ticket-sync-on-change-20261019`. The same narrow change is
prepared separately on the desktop 0.1.47 baseline. No deployment, account data inspection,
real-ticket spend, server change or request-timing experiment is included.
The previous ten-second periodic-sync experiment remains excluded.

## Behavior

All unlocked account types now schedule the existing encrypted pull/merge/push
two seconds after the most recent local ticket change, including consumption,
used-ticket removal and issuer invalidation. Repeated changes reset one timer.
Preferences retain the same shared debounce. A timer that expires during an
existing sync retains one follow-up scheduled two seconds after it finishes.
There is no overlapping sync within a service; existing cross-tab/account locks
continue serializing durable wallet operations. Credential replacement and
logout clear previous pending work. A change made under replacement credentials
can schedule its own pass once old work releases the lock.

Automatic local-change passes use background transport: one attempt, bounded
headers and body (five seconds per network request), without foreground retry
backoff. A failed pass waits for the existing 30-second visible-client cycle,
foreground resume, or another local change. The periodic interval is unchanged.
Remote hydration continues opting out of local-change triggers to avoid echoes.

This accelerates the sender's upload, not server push to every recipient. An
idle receiving client may still wait until its next 30-second cycle or foreground
resume. Browser timer throttling, offline state, account locks and network latency
can add delay. Two seconds is a scheduling target, not an end-to-end guarantee.

## Acceptance criteria (defined before final evaluation)

1. No local-change pass before two seconds of quiet; a burst produces one pass.
2. Successful spends and used-ticket removal schedule after local persistence,
   including identity-backed accounts. Remote hydration does not echo uploads.
3. No overlapping pass, including during account-lock release; a busy timer
   retains one follow-up rather than dropping it.
4. Sign-out/replacement cancels old timers; old completion cannot erase new
   account work. Locked wallets schedule no work.
5. Failures do not cause a rapid retry loop or permanently retain the busy flag.
6. Existing encrypted merge, tombstone, account isolation and background timeout
   regressions continue passing. No ticket plaintext added to transport/logging.
7. Full repository checks and an independent adversarial review before handoff.

## Privacy and enforcement boundaries

Redemption still omits account credentials; authenticated wallet sync is a
separate encrypted request. However it now occurs shortly after spending. The
org can observe this timing whether or not request logs are retained. The user
accepted this tradeoff on 2026-10-19. This change does not configure logging,
expose prompts/ticket plaintext, or alter server spending/idempotency semantics.
It does not prevent a second acquisition from recovering the same existing key
before synchronization; that is a separate protocol issue.

## Validation

See test/services/syncLocalChanges.test.js for deterministic scheduler and real
TicketStore persistence/trigger integration tests; ticketSyncConsumption and
syncCredentialGeneration retain encrypted merge and stale-account coverage.
Live web/desktop acceptance with actual deployed builds remains required before
claiming measured end-to-end latency. No public release is prepared here.

The original desktop-baseline local verification passed 2770 tests with 2
skipped and zero failures. Web-baseline integration validation is recorded in
the external release evidence; do not inherit desktop results as web results. All 13 scheduler/integration regressions pass. Independent
adversarial review approved the final diff for local testing with no blockers.
