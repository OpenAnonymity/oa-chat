# Optional UI extensions

`oa-chat` is a complete standalone application. A downstream composition can
import only `chat/publicApi.js` and pass optional extensions to `createChatApp`:

```js
import { createChatApp, EXTENSION_API_VERSION } from './chat/publicApi.js';

createChatApp({
    routeRoot: '/chat/',
    extensions: [{
        id: 'example',
        apiVersion: EXTENSION_API_VERSION,
        async mount(context) {
            // Return an optional cleanup function.
        }
    }]
});
```

`routeRoot` is optional and defaults to `/`. A composition that mounts the
chat document below `/` must pass its absolute mount path so ticket-link
cleanup and generated shared-chat URLs stay reload-safe on that route.

Extension API version 2 supports these named slots:

- `sidebar.accountActions`
- `account.menuActions`
- `account.commercial`
- `welcome.actions`
- `rightPanel.ticketStatus`
- `modalLayer`

`account.menuActions` is rendered inside the signed-in account settings menu.
Nodes mounted there should be buttons with `role="menuitem"` and the shared
`account-menu-item` class. The core menu owns focus movement, Escape handling,
outside-click dismissal, and Account/logout actions. Extensions own their
menu-item label and destination. A dialog opened from this slot should use
`context.ui.getAccountMenuReturnTarget()` as its focus-return target because
the menu itself closes after selection. The legacy `sidebar.accountActions` and
`account.commercial` slots remain supported for compatibility.

An action rendered inside the legacy `account.commercial` slot must not stack a
second modal over Account. Capture `context.ui.getAccountMenuReturnTarget()`,
call `context.ui.closeAccount()`, and only then open the extension-owned dialog
with the captured element as its focus-return target. The close request honors
Account's protected recovery and authorization steps.

The context also provides narrow account, entitlement-ticket, ticket-tool, and UI
capabilities. `account.getSnapshot()` exposes only `isReady`, `accountId`,
`sessionVerified`, `accountScopeReady`, `ticketSyncReady`, and `status`; it
never exposes credentials or recovery material. Calling
`tickets.prepareEntitlementBatch()` without a `ticketCount`
only resumes an already-saved preparation for that scope.

- `account.getSnapshot()` and `account.subscribe()` return `isReady`,
  `accountId`, `sessionVerified`, `accountScopeReady`, `ticketSyncReady`, and
  `status`; no credential, recovery, email, or encryption material crosses the
  boundary.
- `account.resolveAuthContext()` returns an opaque account scope only after the
  SuperTokens session is verified.
- `account.request()` permits only authenticated oa-org `/api/billing*` calls.
  Cookies remain internal to the public session service and are never exposed
  to the extension.
- `org.requestPublic()` permits only the public plan and ticket-issuer routes
  with credentials omitted.
- `tickets.getIssuerPublicKey()` fetches without caching and verifies the
  advertised key ID against the RFC 9578 public key bytes.
- `tickets.prepareEntitlementBatch()` owns browser-side blinding, strict claim
  response validation, unblinding, durable wallet import, and crash recovery.
  Final tickets contain only ordinary ticket fields.
- `ui` provides the supported Account, Welcome, ticket-management, and toast
  actions.

Commercial membership surfaces may call the public ticket-tool capabilities
`getToolsSnapshot`, `subscribe`, `importTickets`, `shareTickets`,
`redeemAccessCode`, and `registerShortageHandler`. `subscribe` emits the same
redacted count/busy snapshot after ticket storage is ready and after local wallet updates; it never emits the
temporary zero used while IndexedDB is loading. It is the supported seam for a
downstream opt-in refill experience to notice a transition to zero. For a
signed-in account, `readyForAutomaticBilling` remains false until initial
encrypted sync succeeds; consumers must not initiate a charge before it is
true. These reuse the browser-wallet operations already used by
the standalone UI. Snapshots expose counts and busy state only; operations
return aggregate counts or the intentionally shareable split code/link, never
wallet ticket material, account credentials, billing identifiers, or inference
content.

`tickets.registerShortageHandler(handler)` is called only after a user tries to
send or regenerate a request whose account ticket balance is below the
complete turn budget. Its frozen payload contains only `availableTickets` and
`requiredTickets`; it excludes the prompt, model identities, Memory context,
session identifiers, and account data. A commercial extension may present an
explicit purchase surface, but this signal must not initiate automatic billing.
Automatic reloads are limited to an independently observed synchronized zero
balance. The core request remains unsent, so a purchase cannot duplicate an
inference request.
Signed-in core preflight does not call this handler until the account is
verified, unlocked, scope-ready, and ticket-synchronized.

`context.ui.registerTicketManagement(handler)` lets a downstream membership
surface replace the standalone ticket-code controls in the right panel with one
compact ticket-count button. The handler receives that button as the dialog's
focus-return target. Unmounting the extension restores the standalone controls,
so code redemption remains available in public builds with no extension.

`context.ui.registerFirstAccountReady(handler)` is the one-shot routing seam for
a newly created Google-plus-passkey account. Core Account UI closes before it
notifies the extension. The commercial client opens Membership; returning
accounts do not emit this notification.

Extensions must not import oa-chat internals under `components/`, `services/`,
`domain/`, `application/`, or `ui/`. An extension failure is isolated and does
not prevent standalone chat startup. Slot, capability, or lifecycle changes
require a new extension API version.

## Product UI composition

### Runtime composition

`createChatApp({ runtime, ui, analytics })` also accepts a trusted local product
runtime. Omission preserves standalone OA's account, ticket and verifier path;
these options do not change the commercial extension API or its redacted
capabilities. Setting `analytics: false` disables the shared page-hit request.

The runtime supplies an isolated `inferenceService` made by
`createInferenceService` from `publicInferenceApi.js`, optional model
configuration, and `features` (`accounts`, `tickets`, `memory`, `scrubber`,
`council`, all enabled by default). Disabling tickets requires an explicit
`checkCanSend` implementation; it never silently authorizes paid inference.
An accountless app does not bootstrap authentication from `?auth=` either.
Model configuration callbacks (`getDefaultModelConfig`, `getPinnedModels`,
`getDisabledModels`) accept an optional session; mixed runtimes must honor its
backend rather than reading only the visible mode. The core retains separate
backend catalogs, and `context.getModels(sessionId?)` returns the requested
session's models so background inference remains independent of navigation.

Lifecycle methods:

- `attach(context)` receives captured-session lookups/persistence, progress,
  presentation refresh, cancellation, funding-dialog, toast and local-event
  capabilities. It does not receive the raw ChatApp controller.
- `checkCanSend({signal, ...})` validates access before accepting a turn.
  `acquireAccess(options)` replaces only access issuance; default OA still
  redeems tickets and requires verifier approval before activating credentials.
- `prepareTurn({sessionId, signal, onProgress})` runs with an assistant pending
  indicator already mounted. `onNewChat({sessionId})` establishes any background
  retirement barrier synchronously; the composer opens immediately.
  Optional `shouldCancelOnNewChat({session})` chooses whether the previous
  session's owned work should be stopped. Its default follows the presence of
  `onNewChat`; mixed runtimes can retain ordinary ticket streaming while
  retiring only paid sessions.
- `beforeDelete({sessionIds})` runs after owned sends, title jobs, Quick Ask,
  attachment preparation and timeline mutations drain. A failed hook retains
  history so recovery remains possible.
- `usesTicketAccess(session)` optionally selects ticket policy for each
  conversation, overriding the static `tickets` feature for preflight and
  acquisition pricing. Returning false requires `checkCanSend`; there is no
  alternate-payment-to-ticket fallback. `acquireAccess` can delegate ticket
  sessions to public `acquireVerifiedAccess`.
- `context.changeSessionBackend(backendId, {sessionId?})` changes the captured
  conversation without navigation or transcript changes. The default target is
  the current session; an empty composer changes the new-chat default only.
  `context.isSessionBusy(sessionId?)` covers sends, streaming, title generation,
  Quick Ask, access, files, timeline mutations and deletion; product mode
  selectors should remain disabled while it is true. Active Send/stream or
  timeline mutations reject the switch. An exclusive reservation prevents new
  inference jobs and drains existing auxiliary work before the hook below.
- `beforeBackendChange({session, previousBackendId, backendId})` receives a
  staged session clone. Settle/release the previous backend's lease and remove
  its product metadata there. The core then clears old active access and saves
  the backend and metadata together before updating the live object. A hook or
  storage failure leaves the live session unchanged; lease cleanup should be
  idempotent for retry. Historical messages and ephemeral key mappings remain.
  Delete waits for the switch and prevents its write if deletion begins before
  persistence. The hook must not acquire a new paid credential.
- `recordUsage({sessionId, requestId, usage, pricing, kind, final})` receives
  per-request progress/final metadata, never another session's shared counter.
  `discardUsagePreview` removes pre-request estimates when no output or provider
  usage arrived. Accounting failures do not turn provider success into failure.
- `restoreSession(session, messages)` can recover estimates from local history
  without delaying its rendering. Deleted/stale references are not restored.
- `reuseAccessOnFork: false` requests fresh access for a copied conversation;
  `transformForkMessage(snapshot)` can remove product-only accounting fields
  from historical messages. Standalone OA keeps its existing shared-access fork.

`OpenRouterAPI` accepts request-scoped `acquireRequestAccess`, request-body
policy, token estimation, transport, error and completion callbacks. A lease
supplies `baseUrl`, `headers`, optional `apiKey`/`proxyConfig`, and `release()`.
Every title/completion releases its own lease in `finally`. OA owns request
construction and SSE parsing, including incremental reasoning/content, usage,
provider errors and cancellation. Products must not fork that parser.

`createInferenceService` also exposes `hasBackend(id)`, `getBackends()` and
`setDefaultBackendId(id)`. Explicit unknown IDs throw rather than selecting a
different payment method. Send captures the new-chat default synchronously and
saves `session.inferenceBackend`. Older sessions without a stored backend use
the fixed `legacyBackendId` constructor option (initial configured default if
omitted), optionally refined by `resolveLegacyBackendId(session)`. Their
credentials must never be reinterpreted according to the preferred new-chat
mode. `getLegacyBackendId(session?)` exposes that same policy for old shared-key
imports. Products own persistence of the preferred default. The ordinary ticket backend is
available as `openRouterBackend` from `publicInferenceApi.js`, and standard
`WelcomePanel` and `AccountModal` are exported from `publicApi.js`.

Trusted product entry points can pass `ui` options to `createChatApp` while using
the shared renderer. This is distinct from the redacted commercial extension
context above: product components run locally as part of the configured app.

- `components.accountModal`, `components.welcomePanel`, and
  `components.rightPanel` are factories receiving the supported component app
  facade. Omission keeps the ordinary component. A funding panel can extend the
  public `RightPanel` and override `generateFundingSectionHTML()` instead of
  copying its key, proxy, and activity sections.
- `integration` is an explicit product-owned capability object exposed on that
  facade; it does not expose unlisted ChatApp fields.
- `mountShell()` runs once after the components have mounted. It can relocate
  existing shell controls without replacing their event handlers. It must not
  start funding work or install a timer that remounts the UI.
- `presentation.getModelPricing(model)` may return `{label, description}` to
  replace ticket prices with escaped plain-text pricing.
- `presentation.getSessionStatus(session)` may return `{label, tone}` where
  tone is `working`, `waiting`, `success`, or `error`.
- `presentation.getPendingPresentation(phase, progress)` may return
  `{mode, current, description, category, note, progressPhase, steps}`. Mode
  `security` shows a collapsed preparation trace; mode `thinking` shows the
  response-waiting row. Steps contain `{id, label, state}`; stable IDs preserve
  DOM identity as progress advances. Copy is escaped and the default ticket
  placeholder is unchanged when no presenter exists.

These callbacks own presentation only. Durable funding and access lifecycle
work belongs in the product runtime. They must not initiate payments from a
render, expose secrets, or rebuild the shared chat application.

## Shared runtime services

Trusted bundled product runtimes may import `chat/publicRuntimeApi.js`
(`RUNTIME_API_VERSION = 1`). It exports the same `networkProxy`, `networkLogger`,
and `preferencesStore` instances used by the shared app, plus named file,
provider, model-catalog, model-name, and reasoning utilities. Products must not
instantiate or vendor duplicate copies of those services: separate proxy or
preference singletons can show one transport in the UI while requests use
another. This API is a composition boundary, not an extension of the redacted
commercial billing context; ordinary billing extensions should continue using
only `publicApi.js` and their scoped capabilities.

Model catalog cache version 2 retains `top_provider` limits as well as pricing;
older caches refresh without changing chat or ticket storage. The shared log
sink redacts mixed-case sensitive headers, Headers objects, wallet/provider
secrets, and embedded bearer credentials while retaining the existing strict
provider-response metadata allowlist.
TLS inspection retains parsed certificate/protocol metadata, not verbose raw
transport lines that might carry credentials or request content. Runtime
exports can be imported in headless tests without requiring a `window` global.

The shared `modelConfiguration` namespace is exported here so compositions can
reuse standard ticket model availability without importing private services.
