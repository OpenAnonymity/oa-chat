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

function sanitizeFileNamePart(value, fallback = 'untagged') {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const safe = raw
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return safe || fallback;
}

function buildTagMemoryMarkdown(tag, entries, exportedAtIso) {
    const lines = [];
    lines.push(`# Memory: ${tag}`);
    lines.push('');
    lines.push(`Exported: ${exportedAtIso}`);
    lines.push(`Sessions: ${entries.length}`);
    lines.push('');

    for (const entry of entries) {
        lines.push(`## ${entry.title}`);
        lines.push('');
        lines.push(`- Session ID: \`${entry.id}\``);
        lines.push(`- Updated At: ${new Date(entry.updatedAt || entry.createdAt || Date.now()).toISOString()}`);
        lines.push('');
        lines.push(entry.sessionMemory || '_No session memory summary available._');
        lines.push('');
    }

    return lines.join('\n').trimEnd() + '\n';
}

function buildMemoryIndexMarkdown(sessionRecords, exportedAtIso) {
    const lines = [];
    lines.push('# Memory Index');
    lines.push('');
    lines.push(`Exported: ${exportedAtIso}`);
    lines.push(`Sessions: ${sessionRecords.length}`);
    lines.push('');
    lines.push('## Entries');
    lines.push('');

    const sorted = [...sessionRecords].sort((a, b) =>
        (a.title || '').localeCompare(b.title || '') || (a.id || '').localeCompare(b.id || '')
    );

    for (const record of sorted) {
        const tags = Array.isArray(record.tags) && record.tags.length > 0 ? record.tags.join(', ') : 'untagged';
        const updatedAt = new Date(record.updatedAt || record.createdAt || Date.now()).toISOString();
        lines.push(`- Session ID: \`${record.id}\` | Title: ${record.title} | Updated At: ${updatedAt} | Tags: ${tags}`);
    }

    lines.push('');
    return lines.join('\n');
}

function createCrc32Table() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let j = 0; j < 8; j += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);
    const dosTime = (hours << 11) | (minutes << 5) | seconds;
    const dosDate = ((year - 1980) << 9) | (month << 5) | day;
    return { dosTime, dosDate };
}

function uint16LE(value) {
    const out = new Uint8Array(2);
    out[0] = value & 0xFF;
    out[1] = (value >>> 8) & 0xFF;
    return out;
}

function uint32LE(value) {
    const out = new Uint8Array(4);
    out[0] = value & 0xFF;
    out[1] = (value >>> 8) & 0xFF;
    out[2] = (value >>> 16) & 0xFF;
    out[3] = (value >>> 24) & 0xFF;
    return out;
}

function concatUint8Arrays(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function createZipBlob(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const { dosTime, dosDate } = dosDateTime(now);
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const file of files) {
        const fileNameBytes = encoder.encode(file.fileName);
        const dataBytes = encoder.encode(file.content);
        const checksum = crc32(dataBytes);
        const size = dataBytes.length;

        const localHeader = concatUint8Arrays([
            uint32LE(0x04034b50),
            uint16LE(20),
            uint16LE(0),
            uint16LE(0),
            uint16LE(dosTime),
            uint16LE(dosDate),
            uint32LE(checksum),
            uint32LE(size),
            uint32LE(size),
            uint16LE(fileNameBytes.length),
            uint16LE(0),
            fileNameBytes
        ]);

        localParts.push(localHeader, dataBytes);

        const centralHeader = concatUint8Arrays([
            uint32LE(0x02014b50),
            uint16LE(20),
            uint16LE(20),
            uint16LE(0),
            uint16LE(0),
            uint16LE(dosTime),
            uint16LE(dosDate),
            uint32LE(checksum),
            uint32LE(size),
            uint32LE(size),
            uint16LE(fileNameBytes.length),
            uint16LE(0),
            uint16LE(0),
            uint16LE(0),
            uint16LE(0),
            uint32LE(0),
            uint32LE(localOffset),
            fileNameBytes
        ]);
        centralParts.push(centralHeader);

        localOffset += localHeader.length + dataBytes.length;
    }

    const centralDirectory = concatUint8Arrays(centralParts);
    const localData = concatUint8Arrays(localParts);

    const endOfCentralDirectory = concatUint8Arrays([
        uint32LE(0x06054b50),
        uint16LE(0),
        uint16LE(0),
        uint16LE(files.length),
        uint16LE(files.length),
        uint32LE(centralDirectory.length),
        uint32LE(localData.length),
        uint16LE(0)
    ]);

    const zipBytes = concatUint8Arrays([localData, centralDirectory, endOfCentralDirectory]);
    return new Blob([zipBytes], { type: 'application/zip' });
}

export async function exportMemoryAsTagMarkdown() {
    try {
        const chats = await collectChats();
        const sessions = Array.isArray(chats.sessions) ? chats.sessions : [];
        if (sessions.length === 0) {
            return { success: false, fileCount: 0, tagCount: 0 };
        }

        const exportedAt = new Date().toISOString();
        const tagMap = new Map();
        const sessionRecords = [];

        for (const session of sessions) {
            const tags = Array.isArray(session.keywords) && session.keywords.length > 0
                ? session.keywords
                    .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
                    .map(tag => tag.trim().toLowerCase())
                : ['untagged'];
            const uniqueTags = Array.from(new Set(tags));

            const entry = {
                id: session.id,
                title: session.summary || session.title || 'Untitled Session',
                sessionMemory: (typeof session.sessionMemory === 'string' && session.sessionMemory.trim().length > 0)
                    ? session.sessionMemory.trim()
                    : (typeof session.summary === 'string' ? session.summary.trim() : ''),
                updatedAt: session.updatedAt,
                createdAt: session.createdAt,
                tags: uniqueTags
            };
            sessionRecords.push(entry);

            for (const tag of uniqueTags) {
                if (!tagMap.has(tag)) {
                    tagMap.set(tag, []);
                }
                tagMap.get(tag).push(entry);
            }
        }

        const files = Array.from(tagMap.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([tag, entries]) => ({
                tag,
                fileName: `${sanitizeFileNamePart(tag)}.md`,
                content: buildTagMemoryMarkdown(tag, entries, exportedAt)
            }));

        files.unshift({
            tag: 'index',
            fileName: 'index.md',
            content: buildMemoryIndexMarkdown(sessionRecords, exportedAt)
        });

        const zipBlob = createZipBlob(files);
        const zipUrl = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = zipUrl;
        a.download = `memory-${exportedAt.replace(/[:.]/g, '-')}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(zipUrl);

        return { success: true, fileCount: files.length, tagCount: files.length };
    } catch (error) {
        console.error('Error exporting memory markdown:', error);
        return { success: false, fileCount: 0, tagCount: 0 };
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
