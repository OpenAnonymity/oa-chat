import { prerenderInitialChat } from './ui/initialChat.js';

// Fast first paint for genuinely new chats only. Conversation restoration keeps
// the ordinary bottom composer while local/shared messages load.
prerenderInitialChat({
    container: document.getElementById('messages-container'),
    search: window.location.search
}).catch(error => console.warn('Prerender failed:', error));
