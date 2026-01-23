/**
 * Ticket Store
 * Manages inference tickets with atomic operations and IndexedDB persistence.
 */

import storageEvents from './storageEvents.js';
import { chatDB } from '../db.js';
import syncService from './syncService.js';

const STORAGE_KEY = 'inference_tickets';
const ARCHIVE_KEY = 'inference_tickets_archive';
const DB_ACTIVE_KEY = 'tickets-active';
const DB_ARCHIVE_KEY = 'tickets-archive';
const LOCK_NAME = 'oa-inference-tickets';
const TICKETS_UPDATED_EVENT = 'tickets-updated';

class TicketStore {
    constructor() {
        this.lockQueue = Promise.resolve();
        this.tickets = [];
        this.archive = [];
        this.initPromise = null;
        this.storageUnsubscribe = null;
        this.syncUnsubscribe = null;
    }

    async init() {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            storageEvents.init();
            await this.ensureDbReady();
            await this.migrateFromLocalStorage();
            await this.loadFromDatabase({ emitUpdate: false });
            await this.cleanLegacyTickets();

            if (!this.storageUnsubscribe) {
                this.storageUnsubscribe = storageEvents.on('tickets-updated', () => {
                    this.loadFromDatabase({ emitUpdate: true, skipBroadcast: true });
                });
            }

            // Reload from database when sync completes (sync writes directly to settings)
            if (!this.syncUnsubscribe) {
                this.syncUnsubscribe = syncService.subscribe((payload) => {
                    if (payload.event === 'blob_received' && payload.data?.type === 'tickets') {
                        this.loadFromDatabase({ emitUpdate: true, skipBroadcast: true });
                    }
                });
            }

            this.emitUpdate();
        })();

        return this.initPromise;
    }

    ensureInit() {
        if (!this.initPromise) {
            void this.init();
        }
    }

    async ensureDbReady() {
        if (typeof chatDB === 'undefined') return;
        if (!chatDB.db && typeof chatDB.init === 'function') {
            try {
                await chatDB.init();
            } catch (error) {
                console.warn('Failed to initialize ticket storage:', error);
            }
        }
    }

    emitUpdate() {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(TICKETS_UPDATED_EVENT));
        }
    }

    async withLock(handler) {
        if (typeof navigator !== 'undefined' &&
            navigator.locks &&
            typeof navigator.locks.request === 'function') {
            return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, () => handler());
        }

        const run = this.lockQueue.then(handler, handler);
        this.lockQueue = run.catch(() => {});
        return run;
    }

    splitTicketsByStatus(tickets) {
        const activeTickets = [];
        const archivedTickets = [];

        tickets.forEach(ticket => {
            if (!ticket || !ticket.finalized_ticket) return;
            const status = typeof ticket.status === 'string' ? ticket.status.toLowerCase() : '';
            const isArchived = status === 'archived' || status === 'consumed' || status === 'used' ||
                ticket.used === true || !!ticket.consumed_at;

            if (isArchived) {
                archivedTickets.push(ticket);
            } else {
                activeTickets.push(ticket);
            }
        });

        return { activeTickets, archivedTickets };
    }

    extractImportTickets(payload) {
        if (!payload) {
            throw new Error('Invalid ticket file.');
        }

        if (Array.isArray(payload)) {
            return this.splitTicketsByStatus(payload);
        }

        if (typeof payload !== 'object') {
            throw new Error('Invalid ticket file.');
        }

        if (payload.data && typeof payload.data === 'object') {
            if (payload.data.tickets) {
                return this.extractImportTickets(payload.data.tickets);
            }
            if (Array.isArray(payload.data.active) || Array.isArray(payload.data.archived)) {
                return {
                    activeTickets: Array.isArray(payload.data.active) ? payload.data.active : [],
                    archivedTickets: Array.isArray(payload.data.archived) ? payload.data.archived : []
                };
            }
        }

        if (Array.isArray(payload.activeTickets) || Array.isArray(payload.archivedTickets)) {
            return {
                activeTickets: Array.isArray(payload.activeTickets) ? payload.activeTickets : [],
                archivedTickets: Array.isArray(payload.archivedTickets) ? payload.archivedTickets : []
            };
        }

        if (Array.isArray(payload.active) || Array.isArray(payload.archived)) {
            return {
                activeTickets: Array.isArray(payload.active) ? payload.active : [],
                archivedTickets: Array.isArray(payload.archived) ? payload.archived : []
            };
        }

        if (Array.isArray(payload.tickets)) {
            return this.splitTicketsByStatus(payload.tickets);
        }

        throw new Error('No tickets found in the import file.');
    }

    normalizeTickets(rawTickets, options = {}) {
        const input = Array.isArray(rawTickets) ? rawTickets : [];
        const normalized = [];
        const archived = [];
        const allowUsed = options.allowUsed === true;
        let changed = !Array.isArray(rawTickets);

        input.forEach(ticket => {
            if (!ticket || !ticket.finalized_ticket) {
                changed = true;
                return;
            }

            const cleaned = { ...ticket };
            if ('used' in cleaned) {
                delete cleaned.used;
                changed = true;
            }
            if ('used_at' in cleaned) {
                cleaned.consumed_at = cleaned.consumed_at || cleaned.used_at;
                delete cleaned.used_at;
                changed = true;
            }
            if ('reserved' in cleaned) {
                delete cleaned.reserved;
                changed = true;
            }
            if ('reserved_at' in cleaned) {
                delete cleaned.reserved_at;
                changed = true;
            }
            if ('reserved_by' in cleaned) {
                delete cleaned.reserved_by;
                changed = true;
            }

            if (ticket.used && allowUsed && !cleaned.consumed_at) {
                cleaned.consumed_at = new Date().toISOString();
                changed = true;
            }

            if (ticket.used && !allowUsed) {
                if (!cleaned.consumed_at) {
                    cleaned.consumed_at = new Date().toISOString();
                }
                archived.push(cleaned);
                changed = true;
                return;
            }

            normalized.push(cleaned);
        });

        return { tickets: normalized, archived, changed };
    }

    mergeTickets(existing, incoming) {
        const combined = [...existing];
        const seen = new Set(existing.map(ticket => ticket.finalized_ticket));

        incoming.forEach(ticket => {
            if (!ticket?.finalized_ticket) return;
            if (seen.has(ticket.finalized_ticket)) return;
            seen.add(ticket.finalized_ticket);
            combined.push(ticket);
        });

        return combined;
    }

    async readFromDatabase() {
        if (typeof chatDB === 'undefined' || !chatDB.db) {
            return { active: [], archived: [] };
        }

        try {
            const [active, archived] = await Promise.all([
                chatDB.getSetting(DB_ACTIVE_KEY),
                chatDB.getSetting(DB_ARCHIVE_KEY)
            ]);

            return {
                active: Array.isArray(active) ? active : [],
                archived: Array.isArray(archived) ? archived : []
            };
        } catch (error) {
            console.warn('Failed to load tickets from IndexedDB:', error);
            return { active: [], archived: [] };
        }
    }

    async persistTickets(activeTickets, archivedTickets, options = {}) {
        let persisted = false;
        if (typeof chatDB !== 'undefined' && chatDB.db) {
            try {
                if (typeof chatDB.saveSettings === 'function') {
                    await chatDB.saveSettings([
                        { key: DB_ACTIVE_KEY, value: activeTickets },
                        { key: DB_ARCHIVE_KEY, value: archivedTickets }
                    ]);
                } else {
                    await chatDB.saveSetting(DB_ACTIVE_KEY, activeTickets);
                    await chatDB.saveSetting(DB_ARCHIVE_KEY, archivedTickets);
                }
                persisted = true;
            } catch (error) {
                console.warn('Failed to persist tickets:', error);
            }
        }

        this.tickets = activeTickets;
        this.archive = archivedTickets;
        if (options.emitUpdate !== false) {
            this.emitUpdate();
        }
        if (!options.skipBroadcast) {
            storageEvents.broadcast('tickets-updated', { updatedAt: Date.now() });
        }

        // Trigger sync on local changes (debounced)
        if (!options.skipSync) {
            syncService.triggerSync();
        }

        return persisted;
    }

    async loadFromDatabase(options = {}) {
        if (typeof chatDB === 'undefined' || !chatDB.db) {
            if (options.emitUpdate !== false) {
                this.emitUpdate();
            }
            return;
        }
        const { active, archived } = await this.readFromDatabase();
        const { tickets: normalizedActive, archived: reclassified, changed } = this.normalizeTickets(active);
        const { tickets: normalizedArchive, changed: archiveChanged } = this.normalizeTickets(archived, { allowUsed: true });
        const mergedArchive = this.mergeTickets(normalizedArchive, reclassified);

        if (changed || archiveChanged || reclassified.length > 0) {
            await this.persistTickets(normalizedActive, mergedArchive, {
                skipBroadcast: options.skipBroadcast,
                emitUpdate: options.emitUpdate
            });
            return;
        }

        this.tickets = normalizedActive;
        this.archive = normalizedArchive;
        if (options.emitUpdate !== false) {
            this.emitUpdate();
        }
    }

    async migrateFromLocalStorage() {
        if (typeof localStorage === 'undefined') return;

        const rawActive = localStorage.getItem(STORAGE_KEY);
        const rawArchive = localStorage.getItem(ARCHIVE_KEY);
        if (!rawActive && !rawArchive) return;

        let parsedActive = [];
        let parsedArchive = [];

        try {
            parsedActive = rawActive ? JSON.parse(rawActive) : [];
        } catch (error) {
            console.warn('Failed to parse legacy ticket storage:', error);
        }

        try {
            parsedArchive = rawArchive ? JSON.parse(rawArchive) : [];
        } catch (error) {
            console.warn('Failed to parse legacy ticket archive:', error);
        }

        const { tickets: normalizedActive, archived: reclassified } = this.normalizeTickets(parsedActive);
        const { tickets: normalizedArchive } = this.normalizeTickets(parsedArchive, { allowUsed: true });
        const mergedArchive = this.mergeTickets(normalizedArchive, reclassified);

        const existing = await this.readFromDatabase();
        const combinedActive = this.mergeTickets(existing.active, normalizedActive);
        const combinedArchive = this.mergeTickets(existing.archived, mergedArchive);
        const archivedIds = new Set(combinedArchive.map(ticket => ticket.finalized_ticket));
        const filteredActive = combinedActive.filter(ticket => !archivedIds.has(ticket.finalized_ticket));

        const persisted = await this.persistTickets(filteredActive, combinedArchive, { skipBroadcast: true, emitUpdate: false });
        if (persisted) {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(ARCHIVE_KEY);
        } else {
            this.tickets = filteredActive;
            this.archive = combinedArchive;
        }
    }

    async cleanLegacyTickets() {
        await this.withLock(async () => {
            await this.loadFromDatabase({ emitUpdate: false, skipBroadcast: true });
        });
    }

    getTickets() {
        this.ensureInit();
        return [...this.tickets];
    }

    getCount() {
        this.ensureInit();
        return this.tickets.length;
    }

    getArchiveTickets() {
        this.ensureInit();
        return [...this.archive];
    }

    getArchiveCount() {
        this.ensureInit();
        return this.archive.length;
    }

    peekTickets(count = 1) {
        this.ensureInit();
        if (count <= 0) return [];
        return this.tickets.slice(0, count);
    }

    peekTicket() {
        return this.peekTickets(1)[0] || null;
    }

    async addTickets(newTickets) {
        return this.withLock(async () => {
            await this.ensureDbReady();
            const { active, archived } = await this.readFromDatabase();
            const { tickets } = this.normalizeTickets(newTickets);
            const combined = this.mergeTickets(active, tickets);
            await this.persistTickets(combined, archived);
            return combined.length;
        });
    }

    async clearTickets() {
        return this.withLock(async () => {
            await this.ensureDbReady();
            const { archived } = await this.readFromDatabase();
            await this.persistTickets([], archived);
        });
    }

    async archiveTickets(tickets, consumedAt = null) {
        const timestamp = consumedAt || new Date().toISOString();
        const normalized = tickets
            .filter(ticket => ticket && ticket.finalized_ticket)
            .map(ticket => ({
                ...ticket,
                consumed_at: ticket.consumed_at || timestamp
            }));

        const { active, archived } = await this.readFromDatabase();
        const merged = this.mergeTickets(archived, normalized);
        await this.persistTickets(active, merged);
        return merged.length;
    }

    async consumeTickets(count, handler) {
        if (typeof handler !== 'function') {
            throw new Error('Ticket handler must be a function.');
        }

        // No sync needed here - background polling keeps DB fresh
        // See syncService.startPeriodicSync() for status check polling

        return this.withLock(async () => {
            await this.ensureDbReady();
            const { active, archived } = await this.readFromDatabase();

            if (count <= 0) {
                const error = new Error('Ticket count must be greater than zero.');
                error.code = 'INVALID_TICKET_COUNT';
                throw error;
            }

            if (active.length === 0) {
                const error = new Error('No inference tickets available. Please register with an invitation code first.');
                error.code = 'NO_TICKETS';
                throw error;
            }

            if (active.length < count) {
                const error = new Error(`Not enough tickets. Need ${count}, but only ${active.length} available.`);
                error.code = 'INSUFFICIENT_TICKETS';
                throw error;
            }

            const selected = active.slice(0, count);
            const remaining = active.slice(count);

            try {
                const result = await handler({
                    tickets: selected,
                    totalCount: active.length,
                    remainingCount: remaining.length
                });
                const updatedArchive = this.mergeTickets(archived, selected.map(ticket => ({
                    ...ticket,
                    consumed_at: ticket.consumed_at || new Date().toISOString()
                })));
                await this.persistTickets(remaining, updatedArchive);
                return {
                    tickets: selected,
                    totalCount: active.length,
                    remainingCount: remaining.length,
                    result
                };
            } catch (error) {
                if (error && error.consumeTickets) {
                    const updatedArchive = this.mergeTickets(archived, selected.map(ticket => ({
                        ...ticket,
                        consumed_at: ticket.consumed_at || new Date().toISOString()
                    })));
                    await this.persistTickets(remaining, updatedArchive);
                }
                throw error;
            }
        });
    }

    async importTickets(payload) {
        return this.withLock(async () => {
            await this.ensureDbReady();
            const { activeTickets, archivedTickets } = this.extractImportTickets(payload);
            const { tickets: normalizedActive } = this.normalizeTickets(activeTickets);
            const { tickets: normalizedArchived } = this.normalizeTickets(archivedTickets, { allowUsed: true });

            const { active, archived } = await this.readFromDatabase();

            const mergedActive = this.mergeTickets(active, normalizedActive);
            const mergedArchived = this.mergeTickets(archived, normalizedArchived);
            const archivedIds = new Set(mergedArchived.map(ticket => ticket.finalized_ticket));
            const filteredActive = mergedActive.filter(ticket => !archivedIds.has(ticket.finalized_ticket));

            await this.persistTickets(filteredActive, mergedArchived);

            return {
                addedActive: Math.max(0, filteredActive.length - active.length),
                addedArchived: Math.max(0, mergedArchived.length - archived.length),
                totalActive: filteredActive.length,
                totalArchived: mergedArchived.length
            };
        });
    }
}

const ticketStore = new TicketStore();

export default ticketStore;
