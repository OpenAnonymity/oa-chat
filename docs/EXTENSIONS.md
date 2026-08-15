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
- `modalLayer`

The context exposes only narrow capabilities:
`account.menuActions` is rendered inside the signed-in account settings menu.
Nodes mounted there should be buttons with `role="menuitem"` and the shared
`account-menu-item` class. The core menu owns focus movement, Escape handling,
outside-click dismissal, and Account/logout actions. Extensions own their
menu-item label and destination. The legacy `sidebar.accountActions` and
`account.commercial` slots remain supported for compatibility.

The context also provides narrow account, entitlement-ticket, and UI
capabilities. `account.getSnapshot()` exposes only `isReady`, `accountId`,
`sessionVerified`, and `status`; it never exposes credentials or recovery
material. Calling `tickets.prepareEntitlementBatch()` without a `ticketCount`
only resumes an already-saved preparation for that scope.

- `account.getSnapshot()` and `account.subscribe()` return `isReady`,
  `accountId`, `sessionVerified`, and `status`; no credential, recovery, email,
  or encryption material crosses the boundary.
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
- `ui` provides the supported Account, Welcome, and toast actions.

Extensions must not import oa-chat internals under `components/`, `services/`,
`domain/`, `application/`, or `ui/`. An extension failure is isolated and does
not prevent standalone chat startup. Slot, capability, or lifecycle changes
require a new extension API version.
