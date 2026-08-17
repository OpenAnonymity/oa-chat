# Optional UI Extensions

`oa-chat` runs as a complete standalone application with no extensions. A
downstream build may call the supported application entry point with optional
UI extensions:

```js
import {
    createChatApp,
    EXTENSION_API_VERSION,
    SLOT_NAMES
} from './publicApi.js';

createChatApp({ extensions: [] });
```

## Extension contract

An extension declares the exact API version it supports and mounts through the
narrow context supplied by `oa-chat`:

```js
const extension = {
    id: 'example-extension',
    apiVersion: EXTENSION_API_VERSION,
    async mount(context) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'account-menu-item';
        node.setAttribute('role', 'menuitem');
        const unmount = context.slots.mount(SLOT_NAMES.ACCOUNT_MENU_ACTIONS, node);
        return () => unmount();
    }
};
```

The supported slots in API version 1 are:

- `sidebar.accountActions`
- `account.menuActions`
- `account.commercial`
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

Commercial membership surfaces may call the public ticket-tool capabilities
`getToolsSnapshot`, `subscribe`, `importTickets`, `exportTickets`, `shareTickets`,
and `redeemAccessCode`. `subscribe` emits the same redacted count/busy snapshot
after ticket storage is ready and after local wallet updates; it never emits the
temporary zero used while IndexedDB is loading. It is the supported seam for a
downstream opt-in refill experience to notice a transition to zero. For a
signed-in account, `readyForAutomaticBilling` remains false until initial
encrypted sync succeeds; consumers must not initiate a charge before it is
true. These reuse the browser-wallet operations already used by
the standalone UI. Snapshots expose counts and busy state only; operations
return aggregate counts or the intentionally shareable split code/link, never
wallet ticket material, account credentials, billing identifiers, or inference
content.

`context.ui.registerTicketManagement(handler)` lets a downstream membership
surface replace the standalone ticket-code controls in the right panel with one
compact ticket-count button. The handler receives that button as the dialog's
focus-return target. Unmounting the extension restores the standalone controls,
so code redemption remains available in public builds with no extension.

Extensions must not import files under `components/`, `services/`, `domain/`,
or `application/`. Those modules are internal and may change without an
extension API version change.

An extension failure never prevents the standalone chat application from
starting. Changing a slot name, context capability, or lifecycle behavior is a
breaking extension API change.
