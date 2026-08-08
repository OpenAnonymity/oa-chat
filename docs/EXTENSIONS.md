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
        const node = document.createElement('div');
        const unmount = context.slots.mount(SLOT_NAMES.ACCOUNT_COMMERCIAL, node);
        return () => unmount();
    }
};
```

The supported slots in API version 1 are:

- `sidebar.accountActions`
- `account.commercial`
- `modalLayer`

The context also provides narrow account, entitlement-ticket, and UI
capabilities. `account.getSnapshot()` exposes only `isReady`, `accountId`,
`sessionVerified`, and `status`; it never exposes credentials or recovery
material. Calling `tickets.prepareEntitlementBatch()` without a `ticketCount`
only resumes an already-saved preparation for that scope.

Extensions must not import files under `components/`, `services/`, `domain/`,
or `application/`. Those modules are internal and may change without an
extension API version change.

An extension failure never prevents the standalone chat application from
starting. Changing a slot name, context capability, or lifecycle behavior is a
breaking extension API change.
