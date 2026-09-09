/**
 * Ticket Store
 * Manages inference tickets with atomic operations and IndexedDB persistence.
 */

import storageEvents from './storageEvents.js';
import { chatDB } from '../db.js';
import syncService from './encryptedSyncService.js';
import { PREF_KEYS } from './preferencesStore.js';
import { withAccountDataLock } from './accountDataLock.js';
import { requestQueuedLock } from '../application/queuedLock.js';
import {
    createTicketTombstones,
    filterTicketsByTombstones,
    mergeTicketTombstones
} from './ticketTombstones.js';
import {
    filterTicketsByInvalidatedKeyIds,
    getTicketKeyId,
    normalizeInvalidatedTicketKeyIds,
    normalizeTicketKeyId,
    partitionTicketsByKeyId
} from '../domain/ticketKeys.js';

const STORAGE_KEY = 'inference_tickets';
const ARCHIVE_KEY = 'inference_tickets_archive';
const DB_ACTIVE_KEY = 'tickets-active';
const DB_ARCHIVE_KEY = 'tickets-archive';
const DB_TOMBSTONES_KEY = 'tickets-tombstones';
const LOCK_NAME = 'oa-inference-tickets';
const DB_INVALIDATED_KEYS_KEY = 'tickets-invalidated-key-ids';
const TICKETS_UPDATED_EVENT = 'tickets-updated';

export class TicketStore {
    constructor() {
        this.lockQueue = Promise.resolve();
        this.tickets = [];
        this.archive = [];
        this.initPromise = null;
        this.storageUnsubscribe = null;
        this.scopeStorageUnsubscribe = null;
        this.syncUnsubscribe = null;
        this.hasMarkedTicketHistory = false;
    }

    async init() {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            storageEvents.init();
            await this.ensureDbReady();
            await syncService.bootstrapLocalAccountScope();
            try {
                await this.withLock(async () => {
                    await this.migrateFromLocalStorage();
                    await this.loadFromDatabase({ emitUpdate: false });
                });
            } catch (error) {
                this.tickets = [];
                this.archive = [];
            }

            if (!this.storageUnsubscribe) {
                this.storageUnsubscribe = storageEvents.on('tickets-updated', payload => {
                    this.handleAccountScopeChange(payload, {
                        external: true,
                        ignoreMismatched: true
                    }).catch(() => {});
                });
            }
            if (!this.scopeStorageUnsubscribe) {
                this.scopeStorageUnsubscribe = storageEvents.on(
                    'account-scope-changed',
                    payload => this.handleAccountScopeChange(payload, {
                        external: true
                    })
                );
            }

            if (!this.syncUnsubscribe) {
                this.syncUnsubscribe = syncService.subscribe((payload) => {
                    if (payload.event === 'account_scope_invalidated') {
                        this.tickets = [];
                        this.archive = [];
                        this.emitUpdate();
                        return;
                    }
                    if (payload.event === 'account_scope_changed') {
                        return this.handleAccountScopeChange(payload.data);
                    }
                    if (payload.event === 'blob_received' && (
                        payload.data?.type === 'tickets' ||
                        payload.data?.type === 'ticket-invalidations' ||
                        payload.data?.type === 'ticket-invalidation'
                    )) {
                        return this.loadFromDatabase({
                            emitUpdate: true,
                            skipBroadcast: true
                        });
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

    async markHadTicketsBeforeIfNeeded(activeCount, archivedCount) {
        if (this.hasMarkedTicketHistory) return;
        const total = (Number(activeCount) || 0) + (Number(archivedCount) || 0);
        if (total <= 0) return;

        try {
            const alreadyMarked = !!await chatDB.getSetting(
                PREF_KEYS.hadTicketsBefore
            );
            if (!alreadyMarked) {
                await chatDB.saveSetting(PREF_KEYS.hadTicketsBefore, true);
            }
            this.hasMarkedTicketHistory = true;
        } catch (error) {
            console.warn('Failed to persist ticket history flag:', error);
        }
    }

    emitUpdate() {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(TICKETS_UPDATED_EVENT));
        }
    }

    publishUpdate(options = {}) {
        if (
            Object.hasOwn(options, 'expectedAccountId') &&
            (syncService.getLocalAccountScope() || null) !== (options.expectedAccountId || null)
        ) {
            throw new Error('Prepared tickets belong to a different account scope');
        }
        this.emitUpdate();
        if (!options.skipBroadcast) {
            storageEvents.broadcast('tickets-updated', {
                accountId: syncService.getLocalAccountScope(),
                updatedAt: Date.now()
            });
        }
        if (!options.skipSync) {
            syncService.triggerTicketSync();
        }
    }

    async withLock(handler, options = {}) {
        const { guardScope = true } = options;
        const runWithAccountLock = () => withAccountDataLock(async () => {
            if (guardScope) {
                const activeAccountId = await syncService.assertAccountDataAccess();
                if (
                    Object.hasOwn(options, 'expectedAccountId') &&
                    (activeAccountId || null) !== (options.expectedAccountId || null)
                ) {
                    throw new Error('Prepared tickets belong to a different account scope');
                }
            }
            return handler();
        }, options);
        if (typeof navigator !== 'undefined' &&
            navigator.locks &&
            typeof navigator.locks.request === 'function') {
            if (options.boundedQueue) {
                return requestQueuedLock(navigator.locks, LOCK_NAME, options.signal, runWithAccountLock, options);
            }
            return navigator.locks.request(
                LOCK_NAME,
                { mode: 'exclusive' },
                runWithAccountLock
            );
        }

        const run = this.lockQueue.then(runWithAccountLock, runWithAccountLock);
        this.lockQueue = run.catch(() => {});
        return run;
    }

    async assertAccountScope(expectedAccountId) {
        return this.withLock(
            () => true,
            { expectedAccountId: expectedAccountId || null }
        );
    }

    async refreshForAccount(expectedAccountId, { signal, ...queueOptions } = {}) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        // The public extension seam is installed after wallet initialization.
        // Do not wait behind an unbounded initialization lock a second time.
        await this.ensureDbReady();
        return this.withLock(async () => {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            await this.loadFromDatabase({ emitUpdate: false, skipBroadcast: true, skipSync: true });
            const current = await syncService.assertAccountDataAccess();
            if (signal?.aborted || (current || null) !== (expectedAccountId || null)) {
                throw new DOMException('Account changed', 'AbortError');
            }
            this.emitUpdate();
        }, { ...queueOptions, boundedQueue: true, signal, expectedAccountId: expectedAccountId || null });
    }

    async handleAccountScopeChange(
        payload,
        { external = false, ignoreMismatched = false } = {}
    ) {
        const accountId = payload?.accountId || null;
        if (external) {
            if (
                ignoreMismatched &&
                !syncService.canAccessAccountScope(accountId)
            ) {
                return;
            }
            try {
                await this.withLock(async () => {
                    if (!syncService.canAccessAccountScope(accountId)) {
                        throw new Error('Stale account-scoped ticket update');
                    }
                    await this.loadFromDatabase({
                        emitUpdate: true,
                        skipBroadcast: true
                    });
                });
            } catch (error) {
                // The scope can change while this update waits behind the
                // account lock. A stale ticket notification must never clear
                // the newly activated account's cache.
                if (
                    ignoreMismatched &&
                    !syncService.canAccessAccountScope(accountId)
                ) {
                    return;
                }
                this.tickets = [];
                this.archive = [];
                this.emitUpdate();
            }
            return;
        }
        await this.loadFromDatabase({
            emitUpdate: true,
            skipBroadcast: true
        });
    }

    splitTicketsByStatus(tickets) {
        const activeTickets = [];
        const archivedTickets = [];

        tickets.forEach(ticket => {
            if (!ticket || !ticket.finalized_ticket) return;
            const status = typeof ticket.status === 'string' ? ticket.status.toLowerCase() : '';
            const isArchived = status === 'archived' || status === 'consumed' || status === 'used' ||
                status === 'invalidated' || ticket.used === true || !!ticket.consumed_at ||
                !!ticket.invalidated_at;

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
            const keyId = getTicketKeyId(cleaned);
            if (keyId && cleaned.ticket_key_id !== keyId) {
                cleaned.ticket_key_id = keyId;
                changed = true;
            }
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

            const status = typeof cleaned.status === 'string'
                ? cleaned.status.toLowerCase()
                : '';
            if (!allowUsed && (status === 'invalidated' || !!cleaned.invalidated_at)) {
                cleaned.status = 'invalidated';
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

    async readFromDatabase(options = {}) {
        if (typeof chatDB === 'undefined' || !chatDB.db) {
            if (options.requireDurable) {
                throw new Error('The local ticket database is not available.');
            }
            return {
                active: [],
                archived: [],
                tombstones: [],
                invalidatedKeyIds: []
            };
        }

        try {
            const [active, archived, tombstones, invalidatedKeyIds] = await Promise.all([
                chatDB.getSetting(DB_ACTIVE_KEY),
                chatDB.getSetting(DB_ARCHIVE_KEY),
                chatDB.getSetting(DB_TOMBSTONES_KEY),
                chatDB.getSetting(DB_INVALIDATED_KEYS_KEY)
            ]);

            return {
                active: Array.isArray(active) ? active : [],
                archived: Array.isArray(archived) ? archived : [],
                tombstones: Array.isArray(tombstones) ? tombstones : [],
                invalidatedKeyIds: normalizeInvalidatedTicketKeyIds(invalidatedKeyIds)
            };
        } catch (error) {
            console.warn('Failed to load tickets from IndexedDB:', error);
            if (options.requireDurable) throw error;
            return {
                active: [],
                archived: [],
                tombstones: [],
                invalidatedKeyIds: []
            };
        }
    }

    async persistTickets(activeTickets, archivedTickets, options = {}) {
        let persisted = false;
        if (typeof chatDB !== 'undefined' && chatDB.db) {
            try {
                if (typeof chatDB.saveSettings === 'function') {
                    const entries = [
                        { key: DB_ACTIVE_KEY, value: activeTickets },
                        { key: DB_ARCHIVE_KEY, value: archivedTickets }
                    ];
                    if (Array.isArray(options.tombstones)) {
                        entries.push({
                            key: DB_TOMBSTONES_KEY,
                            value: options.tombstones
                        });
                    }
                    if (Array.isArray(options.invalidatedKeyIds)) {
                        entries.push({
                            key: DB_INVALIDATED_KEYS_KEY,
                            value: normalizeInvalidatedTicketKeyIds(options.invalidatedKeyIds)
                        });
                    }
                    await chatDB.saveSettings(entries);
                } else {
                    await chatDB.saveSetting(DB_ACTIVE_KEY, activeTickets);
                    await chatDB.saveSetting(DB_ARCHIVE_KEY, archivedTickets);
                    if (Array.isArray(options.tombstones)) {
                        await chatDB.saveSetting(
                            DB_TOMBSTONES_KEY,
                            options.tombstones
                        );
                    }
                    if (Array.isArray(options.invalidatedKeyIds)) {
                        await chatDB.saveSetting(
                            DB_INVALIDATED_KEYS_KEY,
                            normalizeInvalidatedTicketKeyIds(options.invalidatedKeyIds)
                        );
                    }
                }
                persisted = true;
            } catch (error) {
                console.warn('Failed to persist tickets:', error);
                if (options.requireDurable) throw error;
            }
        }

        if (options.requireDurable && !persisted) {
            throw new Error('The local ticket database did not confirm the write.');
        }

        this.tickets = activeTickets;
        this.archive = archivedTickets;
        await this.markHadTicketsBeforeIfNeeded(activeTickets.length, archivedTickets.length);
        if (options.emitUpdate !== false) {
            this.publishUpdate(options);
        } else {
            if (!options.skipBroadcast) {
                storageEvents.broadcast('tickets-updated', {
                    accountId: syncService.getLocalAccountScope(),
                    updatedAt: Date.now()
                });
            }
            // Trigger sync on local changes (debounced). Redemption paths opt out:
            // an immediate identity-authenticated request after anonymous ticket
            // redemption would create a direct timing correlation.
            if (!options.skipSync) {
                syncService.triggerTicketSync();
            }
        }

        return persisted;
    }

    async loadFromDatabase(options = {}) {
        if (typeof chatDB === 'undefined' || !chatDB.db) {
            await this.markHadTicketsBeforeIfNeeded(this.tickets.length, this.archive.length);
            if (options.emitUpdate !== false) {
                this.emitUpdate();
            }
            return;
        }
        const {
            active,
            archived,
            tombstones,
            invalidatedKeyIds
        } = await this.readFromDatabase();
        const { tickets: normalizedActive, archived: reclassified, changed } = this.normalizeTickets(active);
        const { tickets: normalizedArchive, changed: archiveChanged } = this.normalizeTickets(archived, { allowUsed: true });
        const generationFilteredActive = filterTicketsByInvalidatedKeyIds(
            normalizedActive,
            invalidatedKeyIds
        );
        const generationFilteredArchive = filterTicketsByInvalidatedKeyIds(
            this.mergeTickets(normalizedArchive, reclassified),
            invalidatedKeyIds
        );
        const [filteredActive, mergedArchive] = await Promise.all([
            filterTicketsByTombstones(generationFilteredActive, tombstones),
            filterTicketsByTombstones(generationFilteredArchive, tombstones)
        ]);
        const invalidatedTicketsRemoved = Math.max(
            0,
            active.length + archived.length - filteredActive.length - mergedArchive.length
        );

        if (changed || archiveChanged || reclassified.length > 0 || invalidatedTicketsRemoved > 0) {
            await this.persistTickets(filteredActive, mergedArchive, {
                skipBroadcast: options.skipBroadcast,
                emitUpdate: options.emitUpdate,
                skipSync: options.skipSync ?? options.skipBroadcast,
                tombstones,
                invalidatedKeyIds
            });
            return;
        }

        this.tickets = filteredActive;
        this.archive = mergedArchive;
        await this.markHadTicketsBeforeIfNeeded(filteredActive.length, mergedArchive.length);
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
        const generationFilteredActive = filterTicketsByInvalidatedKeyIds(
            this.mergeTickets(existing.active, normalizedActive),
            existing.invalidatedKeyIds
        );
        const generationFilteredArchive = filterTicketsByInvalidatedKeyIds(
            this.mergeTickets(existing.archived, mergedArchive),
            existing.invalidatedKeyIds
        );
        const [combinedActive, combinedArchive] = await Promise.all([
            filterTicketsByTombstones(
                generationFilteredActive,
                existing.tombstones
            ),
            filterTicketsByTombstones(
                generationFilteredArchive,
                existing.tombstones
            )
        ]);
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

    async addTickets(newTickets, options = {}) {
        return this.withLock(async () => {
            await this.ensureDbReady();
            const stored = await this.readFromDatabase({
                requireDurable: options.requireDurable === true
            });
            const invalidatedKeyIds = normalizeInvalidatedTicketKeyIds(
                stored.invalidatedKeyIds
            );
            // Reject reintroduced ticket generations during local additions.
            const generationFilteredActive = filterTicketsByInvalidatedKeyIds(
                stored.active,
                invalidatedKeyIds
            );
            const generationFilteredArchive = filterTicketsByInvalidatedKeyIds(
                stored.archived,
                invalidatedKeyIds
            );
            const [active, archived] = await Promise.all([
                filterTicketsByTombstones(
                    generationFilteredActive,
                    stored.tombstones
                ),
                filterTicketsByTombstones(
                    generationFilteredArchive,
                    stored.tombstones
                )
            ]);
            const { tickets } = this.normalizeTickets(newTickets);
            const archivedValues = new Set(
                archived.map(ticket => ticket?.finalized_ticket).filter(Boolean)
            );
            const eligibleTickets = tickets.filter(
                ticket => !archivedValues.has(ticket.finalized_ticket)
            );
            const generationFilteredCombined = filterTicketsByInvalidatedKeyIds(
                this.mergeTickets(active, eligibleTickets),
                invalidatedKeyIds
            );
            const combined = await filterTicketsByTombstones(
                generationFilteredCombined,
                stored.tombstones
            );
            await this.persistTickets(combined, archived, {
                tombstones: stored.tombstones,
                invalidatedKeyIds,
                requireDurable: options.requireDurable === true,
                emitUpdate: options.emitUpdate,
                skipBroadcast: options.skipBroadcast,
                skipSync: options.skipSync
            });
            if (options.requireDurable === true) {
                const confirmed = await this.readFromDatabase({ requireDurable: true });
                const confirmedValues = new Set(
                    [...confirmed.active, ...confirmed.archived]
                        .map(ticket => ticket?.finalized_ticket)
                        .filter(Boolean)
                );
                if (!tickets.every(ticket => confirmedValues.has(ticket.finalized_ticket))) {
                    throw new Error('The local ticket database did not round-trip every prepared ticket.');
                }
                this.tickets = confirmed.active;
                this.archive = confirmed.archived;
            }
            return combined.length;
        }, Object.hasOwn(options, 'expectedAccountId')
            ? { expectedAccountId: options.expectedAccountId || null }
            : undefined);
    }
    async clearTickets() {
        return this.withLock(async () => {
            await this.ensureDbReady();
            const {
                active,
                archived,
                tombstones
            } = await this.readFromDatabase();
            const nextTombstones = mergeTicketTombstones(
                tombstones,
                await createTicketTombstones(active)
            );
            await this.persistTickets([], archived, {
                tombstones: nextTombstones
            });
        });
    }

    async clearAllTickets() {
        return this.withLock(async () => {
            await this.ensureDbReady();
            const {
                active,
                archived,
                tombstones
            } = await this.readFromDatabase();
            const nextTombstones = mergeTicketTombstones(
                tombstones,
                await createTicketTombstones([...active, ...archived])
            );
            await this.persistTickets([], [], {
                tombstones: nextTombstones
            });
        });
    }

    async setActiveTickets(newActiveTickets) {
        return this.withLock(async () => {
            await this.ensureDbReady();
            const {
                active,
                archived,
                tombstones,
                invalidatedKeyIds
            } = await this.readFromDatabase();
            const { tickets: normalized } = this.normalizeTickets(newActiveTickets);
            const generationFiltered = filterTicketsByInvalidatedKeyIds(
                normalized,
                invalidatedKeyIds
            );
            const filtered = await filterTicketsByTombstones(
                generationFiltered,
                tombstones
            );
            const retainedIds = new Set(
                filtered.map(ticket => ticket.finalized_ticket)
            );
            const removed = active.filter(
                ticket => !retainedIds.has(ticket.finalized_ticket)
            );
            const nextTombstones = mergeTicketTombstones(
                tombstones,
                await createTicketTombstones(removed)
            );
            await this.persistTickets(filtered, archived, {
                tombstones: nextTombstones,
                invalidatedKeyIds
            });
            return filtered.length;
        });
    }

    async archiveTickets(tickets, consumedAt = null) {
        return this.withLock(async () => {
            const timestamp = consumedAt || new Date().toISOString();
            const normalized = tickets
                .filter(ticket => ticket && ticket.finalized_ticket)
                .map(ticket => ({
                    ...ticket,
                    consumed_at: ticket.consumed_at || timestamp
                }));

            const stored = await this.readFromDatabase();
            const active = await filterTicketsByTombstones(
                filterTicketsByInvalidatedKeyIds(
                    stored.active,
                    stored.invalidatedKeyIds
                ),
                stored.tombstones
            );
            const merged = await filterTicketsByTombstones(
                filterTicketsByInvalidatedKeyIds(
                    this.mergeTickets(stored.archived, normalized),
                    stored.invalidatedKeyIds
                ),
                stored.tombstones
            );
            await this.persistTickets(active, merged);
            return merged.length;
        });
    }

    async consumeTickets(count, handler, options = {}) {
        if (typeof handler !== 'function') {
            throw new Error('Ticket handler must be a function.');
        }

        // No sync needed here - background polling keeps DB fresh
        // See syncService.startPeriodicSync() for status check polling

        return this.withLock(async () => {
            await this.ensureDbReady();
            const stored = await this.readFromDatabase();
            const invalidatedKeyIds = normalizeInvalidatedTicketKeyIds(
                stored.invalidatedKeyIds
            );
            // Apply tombstones again at the final selection boundary as
            // defense in depth against direct or legacy writes.
            const generationFilteredActive = filterTicketsByInvalidatedKeyIds(
                stored.active,
                invalidatedKeyIds
            );
            const generationFilteredArchive = filterTicketsByInvalidatedKeyIds(
                stored.archived,
                invalidatedKeyIds
            );
            const [active, archived] = await Promise.all([
                filterTicketsByTombstones(
                    generationFilteredActive,
                    stored.tombstones
                ),
                filterTicketsByTombstones(
                    generationFilteredArchive,
                    stored.tombstones
                )
            ]);

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

            const order = options.order === 'tail' ? 'tail' : 'head';
            const selected = order === 'tail'
                ? active.slice(active.length - count)
                : active.slice(0, count);
            const remaining = order === 'tail'
                ? active.slice(0, active.length - count)
                : active.slice(count);

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
                await this.persistTickets(remaining, updatedArchive, {
                    skipSync: syncService.shouldDeferRedemptionSync()
                });
                return {
                    tickets: selected,
                    totalCount: active.length,
                    remainingCount: remaining.length,
                    result
                };
            } catch (error) {
                if (error?.code === 'TICKET_KEY_INVALIDATED') {
                    const invalidatedKeyId = normalizeTicketKeyId(error.invalidatedKeyId);
                    const activePartition = partitionTicketsByKeyId(active, invalidatedKeyId);
                    const archivedPartition = partitionTicketsByKeyId(archived, invalidatedKeyId);
                    const invalidatedActiveTickets = activePartition.matching;
                    const selectedInvalidated = invalidatedActiveTickets.length > 0
                        ? invalidatedActiveTickets
                        : selected.filter(ticket => {
                            const ticketKeyId = getTicketKeyId(ticket);
                            return !invalidatedKeyId || ticketKeyId === invalidatedKeyId;
                        });
                    const invalidatedTokens = new Set(
                        selectedInvalidated.map(ticket => ticket.finalized_ticket)
                    );
                    const updatedActive = invalidatedActiveTickets.length > 0
                        ? activePartition.remaining
                        : active.filter(
                            ticket => !invalidatedTokens.has(ticket.finalized_ticket)
                        );
                    const updatedArchive = invalidatedKeyId
                        ? archivedPartition.remaining
                        : archived.filter(
                            ticket => !invalidatedTokens.has(ticket.finalized_ticket)
                        );
                    const removedCount = (active.length - updatedActive.length)
                        + (archived.length - updatedArchive.length);
                    const currentInvalidatedKeyIds = normalizeInvalidatedTicketKeyIds(
                        invalidatedKeyIds
                    );
                    const nextInvalidatedKeyIds = normalizeInvalidatedTicketKeyIds([
                        ...currentInvalidatedKeyIds,
                        invalidatedKeyId
                    ]);
                    if (
                        removedCount > 0 ||
                        nextInvalidatedKeyIds.length > currentInvalidatedKeyIds.length
                    ) {
                        await this.persistTickets(updatedActive, updatedArchive, {
                            invalidatedKeyIds: nextInvalidatedKeyIds,
                            skipSync: syncService.shouldDeferRedemptionSync()
                        });
                    }
                    error.invalidatedTicketsRemoved = removedCount;
                    error.remainingTickets = updatedActive.length;
                } else if (error && error.consumeTickets) {
                    const usedTokens = Array.isArray(error.usedTokens)
                        ? error.usedTokens
                        : Array.isArray(error.usedTickets)
                            ? error.usedTickets.map(ticket => ticket?.finalized_ticket).filter(Boolean)
                            : Array.isArray(error.usedIndices)
                                ? error.usedIndices.map(idx => selected[idx]?.finalized_ticket).filter(Boolean)
                                : [];

                    const usedTokenSet = new Set(usedTokens.filter(Boolean));
                    const usedSelected = usedTokenSet.size > 0
                        ? selected.filter(ticket => usedTokenSet.has(ticket.finalized_ticket))
                        : [];

                    if (usedSelected.length > 0) {
                        const updatedArchive = this.mergeTickets(archived, usedSelected.map(ticket => ({
                            ...ticket,
                            consumed_at: ticket.consumed_at || new Date().toISOString()
                        })));
                        const updatedActive = active.filter(ticket => !usedTokenSet.has(ticket.finalized_ticket));
                        await this.persistTickets(
                            updatedActive,
                            updatedArchive,
                            {
                                skipSync:
                                    syncService.shouldDeferRedemptionSync()
                            }
                        );
                    } else {
                        const updatedArchive = this.mergeTickets(archived, selected.map(ticket => ({
                            ...ticket,
                            consumed_at: ticket.consumed_at || new Date().toISOString()
                        })));
                        await this.persistTickets(remaining, updatedArchive, {
                            skipSync:
                                syncService.shouldDeferRedemptionSync()
                        });
                    }
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

            const {
                active,
                archived,
                tombstones,
                invalidatedKeyIds
            } = await this.readFromDatabase();

            const generationFilteredActive = filterTicketsByInvalidatedKeyIds(
                this.mergeTickets(active, normalizedActive),
                invalidatedKeyIds
            );
            const generationFilteredArchived = filterTicketsByInvalidatedKeyIds(
                this.mergeTickets(archived, normalizedArchived),
                invalidatedKeyIds
            );
            const [mergedActive, mergedArchived] = await Promise.all([
                filterTicketsByTombstones(
                    generationFilteredActive,
                    tombstones
                ),
                filterTicketsByTombstones(
                    generationFilteredArchived,
                    tombstones
                )
            ]);
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
