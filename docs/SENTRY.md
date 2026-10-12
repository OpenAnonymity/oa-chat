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
in a known generated application bundle are captured. Errors caught by the app
(including many handled inference failures) are not automatically reported.
The event is reconstructed with only a random per-event ID, fixed error category
and message, environment/release, and allowlisted script paths/line/column numbers.
Custom exception names and messages, stack variables/function names/source lines,
page URLs, user data, request details, breadcrumbs, attachments, tags, context,
and extra fields are discarded. Unknown or non-application frames are dropped.

Default integrations are disabled. There is no session tracking, replay, console
capture, AI instrumentation, request instrumentation, tracing, or persistent user
identifier. Log/metric/transaction hooks drop data. The transport omits cookies
and the HTTP referrer. Build-time environment and release labels must never
contain user data.

Direct delivery still exposes the sender's network IP, browser HTTP metadata,
and error arrival time to Sentry. This is not anonymous transport and does not
use OA's inference relay. Before enabling a public deployment, account for this
in the product privacy disclosure and enable Sentry's project setting to prevent
storing IP addresses. That setting limits storage, not network visibility.
Deployments requiring no third-party metadata exposure should omit `SENTRY_DSN`.

Source maps are not uploaded by this integration. Code locations identify the
generated bundle; error descriptions are deliberately generic. Worker errors,
browser extensions, scripts outside the generated bundles, and errors before
the SDK loads are outside this initial coverage. SDK failures never block chat.

## Checks

`node --test test/sentry.test.mjs` exercises configuration, frame filtering,
real SDK envelope generation (including seeded private scope/attachments),
transport privacy options, and conditional self-hosted bundling.

Official reference: <https://docs.sentry.io/platforms/javascript/configuration/options/>.

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
