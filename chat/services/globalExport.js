/**
 * Global Export Service
 * Collects portable chat data and preferences for a single JSON export.
 * Inference tickets are intentionally excluded; tickets move only through the
 * explicit Share flow so a generic backup cannot create a second spendable copy.
 */

import preferencesStore, { PREF_KEYS } from './preferencesStore.js';
import { chatDB } from '../db.js';
import { normalizeReasoningEffort } from './reasoningConfig.js';

const FORMAT_VERSION = '1.0';
const APP_NAME = 'oa-chat';

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

        const memoryMode = await chatDB.getSetting('memoryMode');
        if (memoryMode !== undefined) {
            preferences.memoryMode = memoryMode;
        }

        const memoryFeatureEnabled = await chatDB.getSetting('memoryFeatureEnabled');
        if (memoryFeatureEnabled !== undefined) {
            preferences.memoryFeatureEnabled = memoryFeatureEnabled;
        }

        const memoryAutoInclude = await chatDB.getSetting('memoryAutoInclude');
        if (memoryAutoInclude !== undefined) {
            preferences.memoryAutoInclude = memoryAutoInclude;
        }

        const memoryAgentModel = await chatDB.getSetting('memoryAgentModel');
        if (memoryAgentModel !== undefined) {
            preferences.memoryAgentModel = memoryAgentModel;
        }

        const reasoningEnabled = await chatDB.getSetting('reasoningEnabled');
        if (reasoningEnabled !== undefined) {
            preferences.reasoningEnabled = reasoningEnabled;
        }

        const reasoningEffort = await chatDB.getSetting('reasoningEffort');
        if (reasoningEffort !== undefined) {
            preferences.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
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
        a.download = `oa-chat-sessions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
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
export async function saveWithConfirmation(blob, suggestedName) {
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
 * Export all user data as a downloadable JSON file.
 * @returns {Promise<boolean>} True if export succeeded
 */
export async function exportAllData() {
    try {
        // Collect all data
        const chats = await collectChats();
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
                preferences
            }
        };

        // Create JSON blob and trigger download
        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `oa-chat-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`✅ Exported ${chats.sessions.length} sessions and preferences`);
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
    return {
        sessionCount: chats.sessions.length,
        messageCount: chats.messages.length
    };
}
