// zkAPI integration bootstrap — mounts the zkAPI panel into the running app.
//
// Loaded as a module from index.html after app.js. Mounting is idempotent and
// self-contained (the panel injects its own floating button + drawer), so this
// adds the zkAPI surface without modifying oa-chat's component lifecycle.

import { mountZkapiPanel } from '../../components/ZkapiPanel.js';

function boot() {
    try {
        mountZkapiPanel();
    } catch (err) {
        console.error('Failed to mount zkAPI panel', err);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
