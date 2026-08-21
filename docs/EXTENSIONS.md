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
`getToolsSnapshot`, `subscribe`, `importTickets`, `exportTickets`, `shareTickets`,
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
send or regenerate a request whose synchronized wallet balance is below the
complete turn budget. Its frozen payload contains only `availableTickets` and
`requiredTickets`; it excludes the prompt, model identities, Memory context,
session identifiers, and account data. A commercial extension may use this
user-initiated signal to start a previously consented refill or present an
explicit purchase surface. The core request remains unsent, so a refill or
purchase cannot duplicate an inference request.
Signed-in core preflight does not call this handler until the account is
verified, unlocked, scope-ready, and ticket-synchronized.

`context.ui.registerTicketManagement(handler)` lets a downstream membership
surface replace the standalone ticket-code controls in the right panel with one
compact ticket-count button. The handler receives that button as the dialog's
focus-return target. Unmounting the extension restores the standalone controls,
so code redemption remains available in public builds with no extension.

Extensions must not import oa-chat internals under `components/`, `services/`,
`domain/`, `application/`, or `ui/`. An extension failure is isolated and does
not prevent standalone chat startup. Slot, capability, or lifecycle changes
require a new extension API version.
