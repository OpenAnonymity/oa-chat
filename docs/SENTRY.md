# Sentry error reporting

OA Chat is a browser JavaScript application. Use `@sentry/browser`, not the
Python/Flask instructions currently shown for the Sentry project. The pinned
SDK is bundled locally; no third-party script loader is used.

## Enable a build

The integration is opt-in at build time. Without `SENTRY_DSN`, there is no SDK
script or Sentry request in the generated page. Raw development serving also
does not enable it. The build hook applies to both standalone and commercial
compositions using this revision of `scripts/build.mjs`.

Set the following build environment variables on the hosting project, then
build and deploy using the normal OA release process:

- `SENTRY_DSN`: the public ingestion DSN in `.env.sentry.example` for
  organization `fpl-pbc`, project `oa-chat`, project ID `4512167064436736`.
- `SENTRY_ENVIRONMENT`: `staging` or `production`. Defaults to `VERCEL_ENV`,
  then `development` if neither is set.
- `SENTRY_RELEASE`: a commit SHA or version. Defaults to
  `VERCEL_GIT_COMMIT_SHA` when available.

Do not put a Sentry authentication token in any browser configuration.
The DSN is public and intentionally included in enabled build output.
Self-hosted Sentry DSNs are currently rejected by the configuration validator.

For a local enabled build (Node 24+), copy `.env.sentry.example` to ignored
`.env.local`, initialize dependencies as usual, then run:

```sh
node --env-file=.env.local scripts/build.mjs
npm run preview
```

Commercial hosts must first pin the oa-chat revision containing this change.
This work does not deploy a release or change hosting environment variables.

## Verify ingestion

```sh
node --env-file=.env.local scripts/verify-sentry.mjs
```

This sends exactly one synthetic error through the real browser SDK and the
same privacy filter. It does not open a chat or access user state. It prints the
event ID only after Sentry returns HTTP 200. Open the Sentry project Issues page,
select environment `setup-verification`, and find the event. Its fixed message
is `OA Chat runtime error (details withheld)` and its synthetic stack file is
`app:///assets/sentry-setup-check.js`.

HTTP 200 confirms ingestion acceptance, not issue processing or dashboard
visibility. Confirm the first deployed browser error separately after release.
In the Sentry project settings, select JavaScript as the platform if the setup
screen still shows Flask. The same DSN can receive JavaScript events.

## Data boundary and limitations

Only uncaught window errors and unhandled promise rejections with a stack frame
in a known generated application bundle are captured. Handled failures at the inference service boundary are explicitly reported for
key acquisition, verification and streaming/strict completions. These include
HTTP 520 and other allowlisted HTTP statuses, timeouts and unexpected failures.
Verification refusals may be generic because the existing verifier adapter
sometimes discards HTTP status or timeout metadata. Tolerated verifier outages
that return an accepted fallback are not reported by this boundary. Other caught
application errors are not automatically reported. CSS/layout
problems that throw no error still require visual checks.
The event is reconstructed with only a random per-event ID, fixed error category
and message, environment/release, and allowlisted script paths/line/column numbers.
Handled request reports use a new synthetic error (never the original error or
its cause). A finite phase/reason allowlist produces a fixed message and grouping
fingerprint, e.g. `OARequest_access_http_520`. No destination or model is included.
Reports are limited to once per category per page and at most 20 total per page;
counts indicate observed incidents, not request volume or failure rates. User
cancellation and expected HTTP 402 credit recovery are excluded. A failed attempt
may later recover through application policy, so a report does not prove the
whole chat ultimately failed. Reporting never changes retries or request results.

Provider SSE errors have their own finite `provider_code_NNN` category when the
provider reported an allowlisted numeric code, or `provider_error` otherwise.
These are distinct from actual HTTP status categories: a stream can be HTTP 200
and still terminate with a provider error before output. The raw provider body,
message, model and arbitrary code strings remain excluded. Diagnostic categories
never assign HTTP status to operational errors or authorize credit recovery.
Older generic `unexpected` events cannot be reclassified after the fact.

Custom exception names and messages outside that allowlist, stack variables/function names/source lines,
page URLs, user data, request details, breadcrumbs, attachments, tags, context,
and extra fields are discarded. Unknown or non-application frames are dropped.

Default integrations are disabled. There is no session tracking, replay, console
capture, AI instrumentation, request instrumentation, tracing, or persistent user
identifier. Log/metric/transaction hooks drop data. The transport omits cookies
and the HTTP referrer. Build-time environment and release labels must never
contain user data.

Direct delivery still exposes the sender's network IP, browser HTTP metadata,
and error arrival time to Sentry. This is not anonymous transport and does not
use OA's inference relay. Account for this in the product privacy disclosure.
The pinned browser SDK emits `sdk.settings.infer_ip: "never"` because
`dataCollection.userInfo` is false; the envelope test checks this explicitly.
As additional defense in depth for events from other SDKs, a project admin can
enable Sentry's project-wide setting to prevent storing IP addresses. That
setting limits event storage, not network visibility. The signed-in account
used during staging setup could not edit this project-wide setting; it remained
off. Do not claim it was applied or that delivery is anonymous.
Deployments requiring no third-party metadata exposure should omit `SENTRY_DSN`.

### Hosted geography follow-up — 2026-10-14

Staging issue OA-CHAT-4 displayed User Geography even with the outbound SDK's
`infer_ip: "never"` setting and user-free event allowlist. Sentry's upstream
[geography discussion](https://github.com/getsentry/sentry/issues/92201)
states that preventing IP storage does not remove geography. A project owner,
manager or team admin must separately add this advanced data-scrubbing rule:
**Remove → Anything → `$user.geo.**`**. Also enable **Prevent Storing of IP
Addresses**. Inspect a subsequent synthetic hosted event to verify both rules;
these affect new events and do not rewrite existing ones.

At the October 14 check, both the IP switch and Add Rule control were disabled
for the signed-in account. No project or organization advanced rules were shown.
No setting was changed. Do not treat this as fixed by the client update or
resolve the privacy finding until an authorized admin applies and verifies it.

Source maps are not uploaded by this integration. Code locations identify the
generated bundle; error descriptions are deliberately generic. Worker errors,
browser extensions, scripts outside the generated bundles, and errors before
the SDK loads are outside this initial coverage. SDK failures never block chat.

## Checks

`node --test test/sentry.test.mjs` exercises configuration, frame filtering,
real SDK envelope generation (including seeded private scope/attachments),
transport privacy options, and conditional self-hosted bundling.

Official reference: <https://docs.sentry.io/platforms/javascript/configuration/options/>.

## Diagnostics and the trail — 2026-10-14

The first integration answered "did something throw, and where": one event per
category per page, no context. That is enough to notice an outage and not
enough to find a bug. This extension adds three things, all drawn from the
same finite-vocabulary model, so the data boundary stays the one described
above — nothing free-form, nothing from a prompt, a response, a URL, a ticket
or an account can get in, because there is no field that would carry it.

**The trail (option a).** Each failing request observation owns a local buffer,
with `started` and `failed` steps. The stream watchdog additionally records
`opened`, `first_output` and `timeout`. Reports contain only the failing operation
within the turn; they do not reconstruct the entire turn or use the Activity
Timeline. Concurrent requests never share a buffer. Unscoped background incidents
and uncaught exceptions have no trail. There are no request/turn/session identifiers.
Relative milliseconds are rounded to 100ms and bounded to one hour; absolute
breadcrumb timestamps are removed. Each buffer retains at most forty steps.
All step names are an explicit catalogue, not merely strings matching a pattern.
The SDK's global breadcrumbs are disabled (`maxBreadcrumbs: 0`), and the outgoing
sanitizer reconstructs the explicit request trail. Request exceptions attach it
through `beforeSend`'s original synthetic error hint; diagnostics use explicit
breadcrumbs in their event. No original exception or request data is retained.

**Tags.** Four, each with fixed values (`TAGS` in `scripts/sentry/privacy.mjs`):
`oa.mode` (ticket | zkapi), `oa.surface` (web | desktop), `oa.visibility`
(visible | hidden), `oa.online` (online | offline). They are read from the page
when the event is sent (`collectLiveTags`) and filter dashboards and alerts;
these tags are coarse operational context. Model names, providers, stations and
destinations remain excluded.

**Diagnostics.** A catalogued incident that is not an exception:
`reportDiagnostic(name, fields)` where `name` and every field are listed in
`DIAGNOSTIC_CATALOG` (`chat/services/diagnostics.js`). Enum fields take only
listed values, counts are reported as the top of a coarse bucket
(1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000), booleans are booleans; anything
else is dropped before it leaves the module. The reporter sends an event at most
once a minute per name (later occurrences in that minute ride along as
`repeats` on the next one), ten per name and sixty per page. Each arrives as a
`warning`-level message event `OADiag_<name>` with the fields under
`contexts.oa`, fingerprinted by name, so Sentry groups by incident type and
alert rules can be set per name. The catalogue today:

| name | fields | raised when |
| --- | --- | --- |
| `access.sweep` | skipped, recovered, tier | key acquisition set aside tickets the org had already seen |
| `access.sweep_stalled` | tier | a refusal did not shrink the wallet; the sweep stopped |
| `stream.timeout` | stage (connection, idle, output), seconds | the request watchdog gave up |
| `storage.failed` | store, op | a local store did not confirm a write (tickets, pending turn) |
| `sync.failed` | reason, stage | encrypted wallet sync or its status check failed |

Adding one: add the name and its fields to `DIAGNOSTIC_CATALOG` first, then
call `reportDiagnostic` at the site. An unknown name or field is silently
dropped, so a call without a catalogue entry sends nothing. Application code
never imports the SDK: diagnostics travel as DOM events
(`oa:diagnostic`, `oa:request-failure`) that `scripts/sentry/browser.mjs` listens
for, and an unconfigured build has nothing listening.

What this still does not do, on purpose: no success events (request volume per
address would be usage tracking), no successful-request reports, no absolute trail timing, no session or user
identity, no model or provider names, no error text. The transport caveat is
unchanged: Sentry sees the sender's IP, so the hosted project still needs the
IP-storage and `$user.geo.**` scrubbing rules above.

Checks: `node --test test/services/diagnostics.test.js test/sentryDiagnostics.test.mjs`
(no SDK needed) and `test/sentry.test.mjs` for the real envelope.

## Setup verification — 2026-10-12

- Sentry accepted synthetic event `fcab9a22bc35464d9598ce4a8e58e5fb` with HTTP 200
  in `setup-verification`. Dashboard visibility was not checked because the
  available browser required sign-in.
- The Sentry-enabled full application build passed; its generated page loads
  exactly one self-hosted Sentry bundle before application modules.
- `npm test` passed: 1,103 core tests and 750 payment tests, with 2 payment tests
  skipped and no failures.
- Independent review approved the change and exercised the bundled browser
  entry with both global error handlers, verifying sanitized envelopes.
- Changes remain local on `codex/sentry-setup-20261012`. No hosting configuration,
  project platform setting, IP-storage setting, or deployed application changed.

### Staging release boundaries (2026-10-15)

This candidate adds browser diagnostics only. Source-map upload tooling/tokens,
server-side Sentry and Sentry project administration are not changed. Before
promoting additional telemetry to production, an administrator must verify
IP-storage prevention and `$user.geo.**` scrubbing in the hosted project. Local
sanitizer tests do not establish those hosted settings.
