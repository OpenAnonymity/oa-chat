/**
 * Ticket Store
 * Manages inference tickets with atomic operations and localStorage persistence.
 */

const STORAGE_KEY = 'inference_tickets';
const LOCK_NAME = 'oa-inference-tickets';
const TICKETS_UPDATED_EVENT = 'tickets-updated';

class TicketStore {
    constructor() {
        this.lockQueue = Promise.resolve();
        this.tickets = this.readTicketsFromStorage();

        window.addEventListener('storage', (event) => {
            if (event.key === STORAGE_KEY && event.newValue !== event.oldValue) {
                this.tickets = this.readTicketsFromStorage();
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

    normalizeTickets(rawTickets) {
        const input = Array.isArray(rawTickets) ? rawTickets : [];
        const normalized = [];
        let changed = !Array.isArray(rawTickets);

        input.forEach(ticket => {
            if (!ticket || !ticket.finalized_ticket) {
                changed = true;
                return;
            }

            if (ticket.used) {
                changed = true;
                return;
            }

            const cleaned = { ...ticket };
            if ('used' in cleaned) {
                delete cleaned.used;
                changed = true;
            }
            if ('used_at' in cleaned) {
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

            normalized.push(cleaned);
        });

        return { tickets: normalized, changed };
    }

    readTicketsFromStorage() {
        const raw = this.readRawTickets();
        const { tickets } = this.normalizeTickets(raw);
        this.tickets = tickets;
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

    async cleanLegacyTickets() {
        await this.withLock(async () => {
            const raw = this.readRawTickets();
            const { tickets, changed } = this.normalizeTickets(raw);
            if (changed) {
                this.writeTickets(tickets);
            } else {
                this.tickets = tickets;
            }
        });
    }

    getTickets() {
        return [...this.tickets];
    }

    getCount() {
        return this.tickets.length;
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
            const combined = [...existing, ...tickets];
            this.writeTickets(combined);
            return combined.length;
        });
    }

    async clearTickets() {
        return this.withLock(async () => {
            this.writeTickets([]);
        });
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
                return {
                    tickets: selected,
                    totalCount: available.length,
                    remainingCount: remaining.length,
                    result
                };
            } catch (error) {
                if (error && error.consumeTickets) {
                    this.writeTickets(remaining);
                }
                throw error;
            }
        });
    }
}

const ticketStore = new TicketStore();

export default ticketStore;
