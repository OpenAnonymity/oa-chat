/**
 * Global Export Service for Alpha-to-Beta Migration
 * Exports all user data to a JSON format compatible with the beta version.
 */

const FORMAT_VERSION = '1.0';
const APP_NAME = 'oa-fastchat';

/**
 * Collects all chat sessions and messages from IndexedDB.
 * @returns {Promise<{sessions: Array, messages: Array}>}
 */
async function collectChats() {
    if (typeof chatDB === 'undefined' || !chatDB.db) {
        return { sessions: [], messages: [] };
    }
    const sessions = await chatDB.getAllSessions();
    const allMessages = [];
    for (const session of sessions) {
        const messages = await chatDB.getSessionMessages(session.id);
        allMessages.push(...messages);
    }
    return { sessions, messages: allMessages };
}

/**
 * Collects active and archived tickets from localStorage.
 * @returns {{active: Array, archived: Array}}
 */
function collectTickets() {
    try {
        const active = JSON.parse(localStorage.getItem('inference_tickets') || '[]');
        const archived = JSON.parse(localStorage.getItem('inference_tickets_archive') || '[]');
        return { active, archived };
    } catch {
        return { active: [], archived: [] };
    }
}

/**
 * Collects user preferences from localStorage and IndexedDB.
 * @returns {Promise<Object>}
 */
async function collectPreferences() {
    const prefs = {};

    // localStorage preferences
    const theme = localStorage.getItem('oa-theme-preference');
    if (theme) prefs.theme = theme;

    const wideMode = localStorage.getItem('oa-wide-mode');
    if (wideMode !== null) prefs.wideMode = wideMode === 'true';

    const flatMode = localStorage.getItem('oa-flat-mode');
    if (flatMode !== null) prefs.flatMode = flatMode !== 'false';

    const rightPanelVisible = localStorage.getItem('oa-right-panel-visible');
    if (rightPanelVisible !== null) prefs.rightPanelVisible = rightPanelVisible === 'true';

    const ticketInfoVisible = localStorage.getItem('oa-ticket-info-visible');
    if (ticketInfoVisible !== null) prefs.ticketInfoVisible = ticketInfoVisible === 'true';

    const proxySettings = localStorage.getItem('oa-network-proxy-settings');
    if (proxySettings) {
        try { prefs.proxySettings = JSON.parse(proxySettings); } catch {}
    }

    const sharePasswordMode = localStorage.getItem('oa-share-password-mode');
    if (sharePasswordMode) prefs.sharePasswordMode = sharePasswordMode;

    const shareExpiryTtl = localStorage.getItem('oa-share-expiry-ttl');
    if (shareExpiryTtl) prefs.shareExpiryTtl = parseInt(shareExpiryTtl, 10);

    // IndexedDB settings
    if (typeof chatDB !== 'undefined' && chatDB.db) {
        try {
            const searchEnabled = await chatDB.getSetting('searchEnabled');
            if (searchEnabled !== undefined) prefs.searchEnabled = searchEnabled;

            const reasoningEnabled = await chatDB.getSetting('reasoningEnabled');
            if (reasoningEnabled !== undefined) prefs.reasoningEnabled = reasoningEnabled;

            const modelPickerConfig = await chatDB.getSetting('modelPickerConfig');
            if (modelPickerConfig) prefs.modelPickerConfig = modelPickerConfig;
        } catch (e) {
            console.warn('Failed to read IndexedDB settings:', e);
        }
    }

    return prefs;
}

/**
 * Exports all user data to a JSON file.
 * @returns {Promise<boolean>} True if export succeeded
 */
export async function exportAllData() {
    try {
        const chats = await collectChats();
        const tickets = collectTickets();
        const preferences = await collectPreferences();

        const exportData = {
            formatVersion: FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            app: APP_NAME,
            data: { chats, tickets, preferences }
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `oa-fastchat-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`Exported ${chats.sessions.length} sessions, ${tickets.active.length + tickets.archived.length} tickets`);
        return true;
    } catch (error) {
        console.error('Export failed:', error);
        return false;
    }
}
