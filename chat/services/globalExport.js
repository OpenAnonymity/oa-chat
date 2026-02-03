/**
 * Global Export Service
 * Collects all user data (chats, tickets, preferences) and exports as a single JSON file.
 */

import preferencesStore, { PREF_KEYS } from './preferencesStore.js';
import ticketStore from './ticketStore.js';
import { chatDB } from '../db.js';

const FORMAT_VERSION = '1.0';
const APP_NAME = 'oa-fastchat';

/**
 * Collect persisted preferences.
 * @returns {Object} Preferences object
 */
async function collectPreferencesFromStore() {
    const preferences = {};

    const theme = await preferencesStore.getPreference(PREF_KEYS.theme);
    if (theme) {
        preferences.theme = theme;
    }

    const wideMode = await preferencesStore.getPreference(PREF_KEYS.wideMode);
    if (wideMode !== undefined) {
        preferences.wideMode = !!wideMode;
    }

    const flatMode = await preferencesStore.getPreference(PREF_KEYS.flatMode);
    if (flatMode !== undefined) {
        preferences.flatMode = flatMode !== false;
    }

    const fontMode = await preferencesStore.getPreference(PREF_KEYS.fontMode);
    if (fontMode) {
        preferences.fontMode = fontMode;
    }

    const rightPanelVisible = await preferencesStore.getPreference(PREF_KEYS.rightPanelVisible);
    if (rightPanelVisible !== undefined && rightPanelVisible !== null) {
        preferences.rightPanelVisible = !!rightPanelVisible;
    }

    const ticketInfoVisible = await preferencesStore.getPreference(PREF_KEYS.ticketInfoVisible);
    if (ticketInfoVisible !== undefined) {
        preferences.ticketInfoVisible = !!ticketInfoVisible;
    }

    const proxySettings = await preferencesStore.getPreference(PREF_KEYS.proxySettings);
    if (proxySettings) {
        preferences.proxySettings = proxySettings;
    }

    const sharePasswordMode = await preferencesStore.getPreference(PREF_KEYS.sharePasswordMode);
    if (sharePasswordMode) {
        preferences.sharePasswordMode = sharePasswordMode;
    }

    const shareExpiryTtl = await preferencesStore.getPreference(PREF_KEYS.shareExpiryTtl);
    if (Number.isFinite(shareExpiryTtl)) {
        preferences.shareExpiryTtl = shareExpiryTtl;
    }

    const shareCustomExpiryValue = await preferencesStore.getPreference(PREF_KEYS.shareCustomExpiryValue);
    if (Number.isFinite(shareCustomExpiryValue)) {
        preferences.shareCustomExpiryValue = shareCustomExpiryValue;
    }

    const shareCustomExpiryUnit = await preferencesStore.getPreference(PREF_KEYS.shareCustomExpiryUnit);
    if (shareCustomExpiryUnit) {
        preferences.shareCustomExpiryUnit = shareCustomExpiryUnit;
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
 * Collect all tickets from persistent storage.
 * @returns {Object} Object with active and archived ticket arrays
 */
export async function collectTickets() {
    await ticketStore.init();
    const tickets = { active: ticketStore.getTickets(), archived: ticketStore.getArchiveTickets() };
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
 * Save a blob to disk using File System Access API if available, otherwise fallback.
 * Returns true if the file was saved (or fallback was used), false if user cancelled.
 * @param {Blob} blob - The data to save
 * @param {string} suggestedName - Suggested filename
 * @returns {Promise<{ saved: boolean, usedFallback: boolean }>}
 */
async function saveWithConfirmation(blob, suggestedName) {
    // Try File System Access API (Chrome, Edge, Opera)
    if (typeof window.showSaveFilePicker === 'function') {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName,
                types: [{
                    description: 'JSON Files',
                    accept: { 'application/json': ['.json'] }
                }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return { saved: true, usedFallback: false };
        } catch (error) {
            // User cancelled the save dialog
            if (error.name === 'AbortError') {
                return { saved: false, usedFallback: false };
            }
            // Other error - fall through to fallback
            console.warn('File System Access API failed, using fallback:', error);
        }
    }

    // Fallback: use anchor click (cannot detect cancel)
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { saved: true, usedFallback: true };
}

/**
 * Export tickets as a downloadable JSON file.
 * Clears tickets only after user confirms save (cash semantics).
 * @returns {{ success: boolean, activeCount: number, archivedCount: number, cancelled: boolean }} Export result
 */
export async function exportTickets() {
    try {
        const tickets = await collectTickets();
        const activeCount = tickets.active.length;
        const archivedCount = tickets.archived.length;

        if (activeCount === 0 && archivedCount === 0) {
            return { success: false, activeCount: 0, archivedCount: 0, cancelled: false };
        }

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
        const filename = `oa-fastchat-tickets-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

        const { saved, usedFallback } = await saveWithConfirmation(blob, filename);

        if (!saved) {
            // User cancelled
            return { success: false, activeCount, archivedCount, cancelled: true };
        }

        // Clear both active and archived tickets after confirmed save (cash semantics)
        await ticketStore.clearAllTickets();

        console.log(`✅ Exported and cleared ${activeCount} active, ${archivedCount} archived tickets`);
        return { success: true, activeCount, archivedCount, cancelled: false, usedFallback };
    } catch (error) {
        console.error('Error exporting tickets:', error);
        return { success: false, activeCount: 0, archivedCount: 0, cancelled: false };
    }
}

/**
 * Split and export a subset of tickets from the bottom of the active list.
 * Removes exported tickets only after user confirms save (cash semantics).
 * @param {number} count - Number of tickets to export
 * @returns {{ success: boolean, exportedCount: number, cancelled: boolean }} Export result
 */
export async function splitAndExportTickets(count) {
    try {
        await ticketStore.init();
        const allActive = ticketStore.getTickets();

        if (count <= 0 || count > allActive.length) {
            throw new Error(`Invalid count: ${count}. Available: ${allActive.length}`);
        }

        // Take from bottom of list
        const startIndex = allActive.length - count;
        const ticketsToExport = allActive.slice(startIndex);
        const ticketsToKeep = allActive.slice(0, startIndex);

        const exportData = {
            formatVersion: FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            app: APP_NAME,
            exportType: 'tickets',
            data: {
                tickets: {
                    active: ticketsToExport,
                    archived: []
                }
            }
        };

        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const filename = `oa-fastchat-tickets-split-${count}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

        const { saved, usedFallback } = await saveWithConfirmation(blob, filename);

        if (!saved) {
            // User cancelled
            return { success: false, exportedCount: 0, cancelled: true };
        }

        // Remove exported tickets after confirmed save
        await ticketStore.setActiveTickets(ticketsToKeep);

        console.log(`✅ Split and exported ${ticketsToExport.length} tickets, ${ticketsToKeep.length} remaining`);
        return { success: true, exportedCount: ticketsToExport.length, cancelled: false, usedFallback };
    } catch (error) {
        console.error('Error splitting tickets:', error);
        return { success: false, exportedCount: 0, cancelled: false };
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
        const tickets = await collectTickets();
        const localPreferences = await collectPreferencesFromStore();
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
