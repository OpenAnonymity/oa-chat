import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';

// The updatedAt backfill used to open a readwrite cursor over every session on
// every page load; a user message written during that walk queued behind it.
// Two index counts now decide whether the walk is needed at all.
function fakeDb({ total, indexed, onWalk }) {
    const transactions = [];
    const request = (result) => {
        const r = { result };
        queueMicrotask(() => r.onsuccess?.({ target: r }));
        return r;
    };
    return {
        transactions,
        db: {
            transaction: (stores, mode = 'readonly') => {
                transactions.push(mode);
                return {
                    objectStore: () => ({
                        count: () => request(total),
                        index: () => ({ count: () => request(indexed) }),
                        openCursor: () => { onWalk?.(); return request(null); }
                    })
                };
            }
        }
    };
}

test('sessions that all carry updatedAt skip the readwrite walk', async () => {
    const db = new chatDB.constructor();
    const fake = fakeDb({ total: 1200, indexed: 1200, onWalk: () => assert.fail('no walk when nothing is missing') });
    db.db = fake.db;
    await db.backfillMissingUpdatedAt();
    assert.deepEqual(fake.transactions, ['readonly']);
});

test('a session missing updatedAt still gets the one-time walk', async () => {
    const db = new chatDB.constructor();
    let walked = 0;
    const fake = fakeDb({ total: 1200, indexed: 1199, onWalk: () => { walked += 1; } });
    db.db = fake.db;
    await db.backfillMissingUpdatedAt();
    assert.equal(walked, 1);
    assert.deepEqual(fake.transactions, ['readonly', 'readwrite']);
});
