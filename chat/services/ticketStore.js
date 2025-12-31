/**
 * Ticket Store
 * Manages inference tickets with atomic operations and localStorage persistence.
 */

const STORAGE_KEY = 'inference_tickets';
const ARCHIVE_KEY = 'inference_tickets_archive';
const LOCK_NAME = 'oa-inference-tickets';
const TICKETS_UPDATED_EVENT = 'tickets-updated';

class TicketStore {
    constructor() {
        this.lockQueue = Promise.resolve();
        this.tickets = this.readTicketsFromStorage();
        this.archive = this.readArchiveFromStorage();

        window.addEventListener('storage', (event) => {
            if (event.key === STORAGE_KEY && event.newValue !== event.oldValue) {
                this.tickets = this.readTicketsFromStorage();
                window.dispatchEvent(new CustomEvent(TICKETS_UPDATED_EVENT));
                return;
            }
            if (event.key === ARCHIVE_KEY && event.newValue !== event.oldValue) {
                this.archive = this.readArchiveFromStorage();
                window.dispatchEvent(new CustomEvent(TICKETS_UPDATED_EVENT));
            }
        });

        this.cleanLegacyTickets();
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

    readRawTickets() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            const parsed = stored ? JSON.parse(stored) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.error('❌ Error loading tickets:', error);
            return [];
        }
    }

    readRawArchive() {
        try {
            const stored = localStorage.getItem(ARCHIVE_KEY);
            const parsed = stored ? JSON.parse(stored) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.error('❌ Error loading ticket archive:', error);
            return [];
        }
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

    readTicketsFromStorage() {
        const raw = this.readRawTickets();
        const { tickets } = this.normalizeTickets(raw);
        this.tickets = tickets;
        return tickets;
    }

    readArchiveFromStorage() {
        const raw = this.readRawArchive();
        const { tickets } = this.normalizeTickets(raw, { allowUsed: true });
        this.archive = tickets;
        return tickets;
    }

    writeTickets(tickets) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(tickets));
            this.tickets = tickets;
            window.dispatchEvent(new CustomEvent(TICKETS_UPDATED_EVENT));
        } catch (error) {
            console.error('❌ Error saving tickets:', error);
        }
    }

    writeArchive(tickets) {
        try {
            localStorage.setItem(ARCHIVE_KEY, JSON.stringify(tickets));
            this.archive = tickets;
            window.dispatchEvent(new CustomEvent(TICKETS_UPDATED_EVENT));
        } catch (error) {
            console.error('❌ Error saving ticket archive:', error);
        }
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

    async cleanLegacyTickets() {
        await this.withLock(async () => {
            const rawTickets = this.readRawTickets();
            const rawArchive = this.readRawArchive();
            const { tickets, archived, changed } = this.normalizeTickets(rawTickets);
            const { tickets: normalizedArchive, changed: archiveChanged } = this.normalizeTickets(rawArchive, { allowUsed: true });
            const combinedArchive = this.mergeTickets(normalizedArchive, archived);

            if (changed) this.writeTickets(tickets);
            else this.tickets = tickets;

            if (archiveChanged || archived.length > 0) this.writeArchive(combinedArchive);
            else this.archive = normalizedArchive;
        });
    }

    getTickets() {
        return [...this.tickets];
    }

    getCount() {
        return this.tickets.length;
    }

    getArchiveTickets() {
        return [...this.archive];
    }

    getArchiveCount() {
        return this.archive.length;
    }

    peekTickets(count = 1) {
        if (count <= 0) return [];
        return this.tickets.slice(0, count);
    }

    peekTicket() {
        return this.peekTickets(1)[0] || null;
    }

    async addTickets(newTickets) {
        return this.withLock(async () => {
            const existing = this.readTicketsFromStorage();
            const { tickets } = this.normalizeTickets(newTickets);
            const combined = this.mergeTickets(existing, tickets);
            this.writeTickets(combined);
            return combined.length;
        });
    }

    async clearTickets() {
        return this.withLock(async () => {
            this.writeTickets([]);
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

        const existing = this.readArchiveFromStorage();
        const merged = this.mergeTickets(existing, normalized);
        this.writeArchive(merged);
        return merged.length;
    }

    async consumeTickets(count, handler) {
        if (typeof handler !== 'function') {
            throw new Error('Ticket handler must be a function.');
        }

        return this.withLock(async () => {
            const available = this.readTicketsFromStorage();

            if (count <= 0) {
                const error = new Error('Ticket count must be greater than zero.');
                error.code = 'INVALID_TICKET_COUNT';
                throw error;
            }

            if (available.length === 0) {
                const error = new Error('No inference tickets available. Please register with an invitation code first.');
                error.code = 'NO_TICKETS';
                throw error;
            }

            if (available.length < count) {
                const error = new Error(`Not enough tickets. Need ${count}, but only ${available.length} available.`);
                error.code = 'INSUFFICIENT_TICKETS';
                throw error;
            }

            const selected = available.slice(0, count);
            const remaining = available.slice(count);

            try {
                const result = await handler({
                    tickets: selected,
                    totalCount: available.length,
                    remainingCount: remaining.length
                });
                this.writeTickets(remaining);
                await this.archiveTickets(selected);
                return {
                    tickets: selected,
                    totalCount: available.length,
                    remainingCount: remaining.length,
                    result
                };
            } catch (error) {
                if (error && error.consumeTickets) {
                    this.writeTickets(remaining);
                    await this.archiveTickets(selected);
                }
                throw error;
            }
        });
    }
}

const ticketStore = new TicketStore();

export default ticketStore;
