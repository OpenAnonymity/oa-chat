/**
 * Global Export Service
 * Collects all user data (chats, tickets, preferences) and exports as a single JSON file.
 */

const FORMAT_VERSION = '1.0';
const APP_NAME = 'oa-fastchat';

/**
 * Collect all localStorage preferences.
 * @returns {Object} Preferences object
 */
function collectPreferencesFromLocalStorage() {
    const preferences = {};

    // Theme preference
    const theme = localStorage.getItem('oa-theme-preference');
    if (theme !== null) {
        preferences.theme = theme;
    }

    // Wide mode
    const wideMode = localStorage.getItem('oa-wide-mode');
    if (wideMode !== null) {
        preferences.wideMode = wideMode === 'true';
    }

    // Flat mode (display mode)
    const flatMode = localStorage.getItem('oa-flat-mode');
    if (flatMode !== null) {
        preferences.flatMode = flatMode !== 'false';
    }

    // Right panel visibility
    const rightPanelVisible = localStorage.getItem('oa-right-panel-visible');
    if (rightPanelVisible !== null) {
        preferences.rightPanelVisible = rightPanelVisible === 'true';
    }

    // Ticket info visibility
    const ticketInfoVisible = localStorage.getItem('oa-ticket-info-visible');
    if (ticketInfoVisible !== null) {
        preferences.ticketInfoVisible = ticketInfoVisible === 'true';
    }

    // Proxy settings
    const proxySettings = localStorage.getItem('oa-network-proxy-settings');
    if (proxySettings) {
        try {
            preferences.proxySettings = JSON.parse(proxySettings);
        } catch (e) {
            console.warn('Failed to parse proxy settings:', e);
        }
    }

    return preferences;
}

/**
 * Collect preferences from IndexedDB settings store.
 * @returns {Promise<Object>} Preferences object
 */
async function collectPreferencesFromIndexedDB() {
    const preferences = {};

    if (typeof chatDB === 'undefined' || !chatDB.db) {
        return preferences;
    }

    try {
        const searchEnabled = await chatDB.getSetting('searchEnabled');
        if (searchEnabled !== undefined) {
            preferences.searchEnabled = searchEnabled;
        }

        const reasoningEnabled = await chatDB.getSetting('reasoningEnabled');
        if (reasoningEnabled !== undefined) {
            preferences.reasoningEnabled = reasoningEnabled;
        }

        const modelPickerConfig = await chatDB.getSetting('modelPickerConfig');
        if (modelPickerConfig !== undefined) {
            preferences.modelPickerConfig = modelPickerConfig;
        }
    } catch (e) {
        console.warn('Failed to load settings from IndexedDB:', e);
    }

    return preferences;
}

/**
 * Collect all chat sessions and their messages.
 * @returns {Promise<Object>} Object with sessions and messages arrays
 */
export async function collectChats() {
    if (typeof chatDB === 'undefined' || !chatDB.db) {
        return { sessions: [], messages: [] };
    }

    try {
        const sessions = await chatDB.getAllSessions();
        const allMessages = [];

        for (const session of sessions) {
            const messages = await chatDB.getSessionMessages(session.id);
            allMessages.push(...messages);
        }

        return { sessions, messages: allMessages };
    } catch (e) {
        console.error('Failed to collect chats:', e);
        return { sessions: [], messages: [] };
    }
}

/**
 * Collect all tickets from localStorage.
 * @returns {Object} Object with active and archived ticket arrays
 */
export function collectTickets() {
    const tickets = { active: [], archived: [] };

    try {
        const activeJson = localStorage.getItem('inference_tickets');
        if (activeJson) {
            const parsed = JSON.parse(activeJson);
            if (Array.isArray(parsed)) {
                tickets.active = parsed;
            }
        }

        const archivedJson = localStorage.getItem('inference_tickets_archive');
        if (archivedJson) {
            const parsed = JSON.parse(archivedJson);
            if (Array.isArray(parsed)) {
                tickets.archived = parsed;
            }
        }
    } catch (e) {
        console.error('Failed to collect tickets:', e);
    }

    return tickets;
}

/**
 * Export chats as a downloadable JSON file.
 * Uses the same format as the chats section in the full export.
 * @returns {Promise<boolean>} True if export succeeded
 */
export async function exportChats() {
    try {
        const chats = await collectChats();

        const exportData = {
            formatVersion: FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            app: APP_NAME,
            exportType: 'chats',
            data: {
                chats
            }
        };

        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `oa-fastchat-chats-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`✅ Exported ${chats.sessions.length} sessions, ${chats.messages.length} messages`);
        return true;
    } catch (error) {
        console.error('Error exporting chats:', error);
        return false;
    }
}

/**
 * Export tickets as a downloadable JSON file.
 * Uses the same format as the tickets section in the full export.
 * @returns {boolean} True if export succeeded
 */
export function exportTickets() {
    try {
        const tickets = collectTickets();

        const exportData = {
            formatVersion: FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            app: APP_NAME,
            exportType: 'tickets',
            data: {
                tickets
            }
        };

        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `oa-fastchat-tickets-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`✅ Exported ${tickets.active.length} active, ${tickets.archived.length} archived tickets`);
        return true;
    } catch (error) {
        console.error('Error exporting tickets:', error);
        return false;
    }
}

/**
 * Export all user data as a downloadable JSON file.
 * @returns {Promise<boolean>} True if export succeeded
 */
export async function exportAllData() {
    try {
        // Collect all data
        const chats = await collectChats();
        const tickets = collectTickets();
        const localPreferences = collectPreferencesFromLocalStorage();
        const dbPreferences = await collectPreferencesFromIndexedDB();
        const preferences = { ...localPreferences, ...dbPreferences };

        // Build export object
        const exportData = {
            formatVersion: FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            app: APP_NAME,
            data: {
                chats,
                tickets,
                preferences
            }
        };

        // Create JSON blob and trigger download
        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `oa-fastchat-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`✅ Exported ${chats.sessions.length} sessions, ${tickets.active.length + tickets.archived.length} tickets`);
        return true;
    } catch (error) {
        console.error('Error exporting data:', error);
        return false;
    }
}

/**
 * Get export summary without downloading.
 * Useful for showing what will be exported.
 * @returns {Promise<Object>} Summary of exportable data
 */
export async function getExportSummary() {
    const chats = await collectChats();
    const tickets = collectTickets();

    return {
        sessionCount: chats.sessions.length,
        messageCount: chats.messages.length,
        activeTicketCount: tickets.active.length,
        archivedTicketCount: tickets.archived.length
    };
}
