import { startChatApp } from './publicApi.js';

function start() {
    void startChatApp().catch(error => {
        console.error('[Startup] Chat could not start:', error);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
    start();
}
