/**
 * Global Import Service
 * Parses and imports user data (chats, tickets, preferences) from a backup JSON file.
 */

import ticketStore from './ticketStore.js';
import preferencesStore, { PREF_KEYS } from './preferencesStore.js';
import { chatDB } from '../db.js';
import { normalizeReasoningEffort } from './reasoningConfig.js';

const SUPPORTED_FORMAT_VERSIONS = ['1.0'];

/**
 * Validate the import file structure.
 * @param {Object} data - Parsed JSON data
 * @returns {{ valid: boolean, error?: string }}
 */
function validateImportData(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, error: 'Invalid file: not a valid JSON object.' };
    }

    if (!data.formatVersion) {
        return { valid: false, error: 'Invalid file: missing formatVersion.' };
    }

    if (!SUPPORTED_FORMAT_VERSIONS.includes(data.formatVersion)) {
        return { valid: false, error: `Unsupported format version: ${data.formatVersion}. Supported: ${SUPPORTED_FORMAT_VERSIONS.join(', ')}.` };
    }

    if (!data.data || typeof data.data !== 'object') {
        return { valid: false, error: 'Invalid file: missing data section.' };
    }

    return { valid: true };
}

/**
 * Import chat sessions and messages.
 * Merges with existing data - new sessions are added, existing sessions are preserved.
 * @param {Object} chatsData - Object with sessions and messages arrays
 * @param {string|null} source - Source identifier for dedupe checks
 * @returns {Promise<{ importedSessions: number, skippedSessions: number, importedMessages: number }>}
 */
async function importChats(chatsData, source = null) {
    const result = { importedSessions: 0, skippedSessions: 0, importedMessages: 0 };

    if (!chatsData || typeof chatDB === 'undefined') {
        return result;
    }

    if (!chatDB.db && typeof chatDB.init === 'function') {
        try {
            await chatDB.init();
        } catch (error) {
            console.warn('Failed to initialize chat storage for import:', error);
            return result;
        }
    }

    if (!chatDB.db) {
        return result;
    }

    const { sessions = [], messages = [] } = chatsData;

    // Get existing session IDs
    const existingSessions = await chatDB.getAllSessions();
    const existingSessionIds = new Set(existingSessions.map(s => s.id));
    const existingImportedKeys = new Set();

    if (source) {
        if (typeof chatDB.collectImportedSessionKeys === 'function') {
            const keys = await chatDB.collectImportedSessionKeys(source);
            keys.forEach(key => existingImportedKeys.add(key));
        } else {
            existingSessions.forEach(session => {
                if (session.importedSource && session.importedExternalId) {
                    existingImportedKeys.add(`${session.importedSource}:${session.importedExternalId}`);
                }
                if (session.importedFrom && session.importedFrom.startsWith(`${source}:`)) {
                    existingImportedKeys.add(session.importedFrom);
                }
            });
        }
    }

    // Import sessions that don't already exist
    for (const session of sessions) {
        if (!session || !session.id) continue;

        const importedKey = source ? `${source}:${session.id}` : null;
        if (existingSessionIds.has(session.id) || (importedKey && existingImportedKeys.has(importedKey))) {
            result.skippedSessions++;
            continue;
        }

        // Ensure required fields
        const normalizedSession = {
            ...session,
            createdAt: session.createdAt || Date.now(),
            updatedAt: session.updatedAt || session.createdAt || Date.now()
        };

        await chatDB.saveSession(normalizedSession);
        result.importedSessions++;
    }

    // Build set of imported session IDs for message filtering
    const importedSessionIds = new Set(
        sessions
            .filter(s => {
                if (!s || !s.id) return false;
                if (existingSessionIds.has(s.id)) return false;
                if (!source) return true;
                return !existingImportedKeys.has(`${source}:${s.id}`);
            })
            .map(s => s.id)
    );

    // Import messages only for newly imported sessions
    for (const message of messages) {
        if (!message || !message.id || !message.sessionId) continue;

        if (!importedSessionIds.has(message.sessionId)) {
            continue; // Skip messages for sessions that weren't imported
        }

        await chatDB.saveMessage(message);
        result.importedMessages++;
    }

    return result;
}

/**
 * Import tickets using the existing ticketStore.
 * @param {Object} ticketsData - Object with active and archived arrays
 * @returns {Promise<{ addedActive: number, addedArchived: number }>}
 */
async function importTickets(ticketsData) {
    if (!ticketsData) {
        return { addedActive: 0, addedArchived: 0 };
    }

    const { active = [], archived = [] } = ticketsData;

    // Use ticketStore's import logic which handles deduplication
    const importResult = await ticketStore.importTickets({
        activeTickets: active,
        archivedTickets: archived
    });

    return {
        addedActive: importResult.addedActive || 0,
        addedArchived: importResult.addedArchived || 0
    };
}

/**
 * Apply imported preferences.
 * Only overwrites preferences that are explicitly present in the import.
 * @param {Object} preferences - Preferences object from import
 * @returns {Promise<string[]>} List of applied preference keys
 */
async function applyPreferences(preferences) {
    const applied = [];

    if (!preferences || typeof preferences !== 'object') {
        return applied;
    }

    // Persistent preferences
    if ('theme' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.theme, preferences.theme);
        applied.push('theme');
    }

    if ('wideMode' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.wideMode, !!preferences.wideMode);
        applied.push('wideMode');
    }

    if ('flatMode' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.flatMode, preferences.flatMode !== false);
        applied.push('flatMode');
    }

    if ('fontMode' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.fontMode, preferences.fontMode === 'serif' ? 'serif' : 'sans');
        applied.push('fontMode');
    }

    if ('rightPanelVisible' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.rightPanelVisible, !!preferences.rightPanelVisible);
        applied.push('rightPanelVisible');
    }

    if ('ticketInfoVisible' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.ticketInfoVisible, !!preferences.ticketInfoVisible);
        applied.push('ticketInfoVisible');
    }

    if ('proxySettings' in preferences && preferences.proxySettings) {
        await preferencesStore.savePreference(PREF_KEYS.proxySettings, preferences.proxySettings);
        applied.push('proxySettings');
    }

    if ('sharePasswordMode' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.sharePasswordMode, preferences.sharePasswordMode);
        applied.push('sharePasswordMode');
    }

    if ('shareExpiryTtl' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.shareExpiryTtl, preferences.shareExpiryTtl);
        applied.push('shareExpiryTtl');
    }

    if ('shareCustomExpiryValue' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.shareCustomExpiryValue, preferences.shareCustomExpiryValue);
        applied.push('shareCustomExpiryValue');
    }

    if ('shareCustomExpiryUnit' in preferences) {
        await preferencesStore.savePreference(PREF_KEYS.shareCustomExpiryUnit, preferences.shareCustomExpiryUnit);
        applied.push('shareCustomExpiryUnit');
    }

    // IndexedDB preferences
    if (typeof chatDB !== 'undefined') {
        if (!chatDB.db && typeof chatDB.init === 'function') {
            try {
                await chatDB.init();
            } catch (error) {
                console.warn('Failed to initialize chat storage for preferences import:', error);
            }
        }
    }

    if (typeof chatDB !== 'undefined' && chatDB.db) {
        if ('searchEnabled' in preferences) {
            await chatDB.saveSetting('searchEnabled', preferences.searchEnabled);
            applied.push('searchEnabled');
        }

        if ('reasoningEnabled' in preferences) {
            await chatDB.saveSetting('reasoningEnabled', preferences.reasoningEnabled);
            applied.push('reasoningEnabled');
        }

        if ('reasoningEffort' in preferences) {
            await chatDB.saveSetting('reasoningEffort', normalizeReasoningEffort(preferences.reasoningEffort));
            applied.push('reasoningEffort');
        }

    }

    return applied;
}

/**
 * Parse and import data from a backup file.
 * @param {File} file - The JSON backup file
 * @returns {Promise<{ success: boolean, error?: string, summary?: Object }>}
 */
export async function importFromFile(file) {
    try {
        // Read and parse file
        const text = await file.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return { success: false, error: 'Invalid JSON file.' };
        }

        // Validate structure
        const validation = validateImportData(data);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Import each section
        const source = typeof data.app === 'string' ? data.app : null;
        const chatResult = await importChats(data.data.chats, source);
        const ticketResult = await importTickets(data.data.tickets);
        const appliedPreferences = await applyPreferences(data.data.preferences);

        const summary = {
            importedSessions: chatResult.importedSessions,
            skippedSessions: chatResult.skippedSessions,
            importedMessages: chatResult.importedMessages,
            addedActiveTickets: ticketResult.addedActive,
            addedArchivedTickets: ticketResult.addedArchived,
            appliedPreferences
        };

        console.log('✅ Import complete:', summary);

        return { success: true, summary };
    } catch (error) {
        console.error('Import failed:', error);
        return { success: false, error: error.message || 'Import failed.' };
    }
}

/**
 * Build a human-readable summary message from import results.
 * @param {Object} summary - Summary object from importFromFile
 * @returns {string}
 */
export function formatImportSummary(summary) {
    const parts = [];

    if (summary.importedSessions > 0) {
        parts.push(`${summary.importedSessions} chat${summary.importedSessions !== 1 ? 's' : ''} imported`);
    }

    if (summary.skippedSessions > 0) {
        parts.push(`${summary.skippedSessions} existing chat${summary.skippedSessions !== 1 ? 's' : ''} skipped`);
    }

    if (summary.addedActiveTickets > 0 || summary.addedArchivedTickets > 0) {
        const ticketCount = summary.addedActiveTickets + summary.addedArchivedTickets;
        const activeCount = summary.addedActiveTickets || 0;
        const usedCount = summary.addedArchivedTickets || 0;
        parts.push(`${ticketCount} ticket${ticketCount !== 1 ? 's' : ''} added (${activeCount} active, ${usedCount} used)`);
    }

    if (summary.appliedPreferences && summary.appliedPreferences.length > 0) {
        parts.push(`${summary.appliedPreferences.length} preference${summary.appliedPreferences.length !== 1 ? 's' : ''} applied`);
    }

    if (parts.length === 0) {
        return 'No new data to import.';
    }

    return parts.join(', ') + '.';
}
