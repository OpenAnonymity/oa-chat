import { createChatApp } from './publicApi.js';

function start() {
    createChatApp();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
    start();
}
