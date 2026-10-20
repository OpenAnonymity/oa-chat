import { chatDB } from '../chat/db.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (left, right, message) => assert(JSON.stringify(left) === JSON.stringify(right), message);
const original = [
    { id: 'question', sessionId: 'test', role: 'user', content: 'Synthetic question', timestamp: 1 },
    { id: 'answer', sessionId: 'test', role: 'assistant', content: 'Original complete answer', timestamp: 2 },
    { id: 'later', sessionId: 'test', role: 'user', content: 'Later question', timestamp: 3 }
];
const response = id => ({ id, sessionId: 'test', role: 'assistant', content: 'Replacement answer', timestamp: 4 });
const withoutNotice = rows => rows.map(({ regenerationNotice, ...row }) => row);

async function freshDatabase() {
    const db = new chatDB.constructor();
    db.dbName = `oa-replacement-fixture-${crypto.randomUUID()}`;
    await db.init();
    await db.saveSessionWithMessages({ id: 'test', title: 'Synthetic test' }, original);
    await db.saveSessionWithMessages({ id: 'other', title: 'Untouched' }, [
        { id: 'other-answer', sessionId: 'other', role: 'assistant', content: 'Unchanged', timestamp: 5 }
    ]);
    const reader = new chatDB.constructor();
    reader.dbName = db.dbName;
    await reader.init();
    return { db, reader, async close() {
        db.db.close(); reader.db.close();
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(db.dbName);
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
        });
    } };
}

const cases = [
    ['Stop restores the complete answer and later turns, including after reopen', async ({ db, reader }) => {
        const draft = await db.beginMessageReplacement('test', 'answer');
        await db.saveMessage(response('partial'));
        equal(await reader.getSessionMessages('test'), original, 'draft leaked to another connection');
        await db.finishMessageReplacement(draft);
        equal(withoutNotice(await reader.getSessionMessages('test')), original, 'original transcript lost');
        assert(!('regenerationNotice' in (await reader.getSessionMessages('test'))[1]), 'a notice was written');
        await db.saveMessage(response('partial'));
        assert(!(await reader.getSessionMessages('test')).some(row => row.id === 'partial'), 'late write resurrected draft');
        reader.db.close(); reader.db = null; await reader.init();
        equal(withoutNotice(await reader.getSessionMessages('test')), original, 'reopen lost original');
    }],
    ['Completed replacement commits atomically without changing another chat', async ({ db, reader }) => {
        const other = await reader.getSessionMessages('other');
        const draft = await db.beginMessageReplacement('test', 'answer');
        await db.saveMessage(response('complete'));
        await db.finishMessageReplacement(draft, { commit: true });
        equal(await reader.getSessionMessages('test'), [original[0], response('complete')], 'replacement not committed');
        equal(await reader.getSessionMessages('other'), other, 'other chat changed');
        await db.saveMessage({ ...original[1], content: 'Late original enrichment' });
        equal(await reader.getSessionMessages('test'), [original[0], response('complete')], 'old response resurrected');
    }],
    ['Transaction abort leaves original intact and rollback releases the draft', async ({ db, reader }) => {
        const draft = await db.beginMessageReplacement('test', 'answer');
        await db.saveMessage(response('aborted'));
        const originalTransaction = db.db.transaction.bind(db.db);
        db.db.transaction = (...args) => {
            const transaction = originalTransaction(...args);
            queueMicrotask(() => transaction.abort());
            return transaction;
        };
        let rejected = false;
        try { await db.finishMessageReplacement(draft, { commit: true }); } catch { rejected = true; }
        delete db.db.transaction;
        assert(rejected, 'aborted commit reported success');
        equal(await reader.getSessionMessages('test'), original, 'aborted transaction changed original');
        await db.finishMessageReplacement(draft);
        assert(db.messageReplacements.size === 0, 'draft left busy');
        equal(withoutNotice(await reader.getSessionMessages('test')), original, 'rollback changed transcript');
    }],
    ...['edit', 'append', 'delete-answer', 'delete-chat'].map(action => [
        `Concurrent ${action} is preserved; replacement cannot overwrite it`, async ({ db, reader }) => {
            const draft = await db.beginMessageReplacement('test', 'answer');
            await db.saveMessage(response('conflict'));
            if (action === 'edit') await reader.saveMessage({ ...original[1], content: 'Edited in another tab' });
            if (action === 'append') await reader.saveMessage({ id: 'concurrent', sessionId: 'test', role: 'user', content: 'New turn', timestamp: 5 });
            if (action === 'delete-answer') await reader.deleteMessage('answer');
            if (action === 'delete-chat') await reader.deleteSessionWithMessages('test');
            const concurrent = await reader.getSessionMessages('test');
            let rejected = false;
            try { await db.finishMessageReplacement(draft, { commit: true }); } catch { rejected = true; }
            assert(rejected, 'concurrent change overwritten');
            await db.finishMessageReplacement(draft);
            equal(await reader.getSessionMessages('test'), concurrent, 'rollback overwrote concurrent change');
            assert(db.messageReplacements.size === 0, 'draft left busy');
            await db.saveMessage(response('conflict'));
            equal(await reader.getSessionMessages('test'), concurrent, 'late candidate resurrected');
        }
    ]),
    ['Thirty interrupted retries keep the same original and release active drafts', async ({ db, reader }) => {
        for (let index = 0; index < 30; index++) {
            const draft = await db.beginMessageReplacement('test', 'answer');
            await db.saveMessage(response(`retry-${index}`));
            await db.finishMessageReplacement(draft, { notice: index % 2 ? 'failed' : 'stopped' });
            assert(db.messageReplacements.size === 0, 'active draft leaked');
            equal(withoutNotice(await reader.getSessionMessages('test')), original, 'retry changed original');
        }
    }]
];

document.querySelector('#run').addEventListener('click', async event => {
    event.target.disabled = true;
    document.querySelector('#results').replaceChildren();
    document.querySelector('#summary').textContent = '';
    const results = [];
    for (const [name, run] of cases) {
        document.querySelector('#status').textContent = name;
        let fixture;
        try {
            fixture = await freshDatabase();
            await run(fixture);
            results.push({ name, result: 'PASS' });
        } catch (error) {
            results.push({ name, result: 'FAIL', error: error.message });
        } finally {
            await fixture?.close();
        }
        const row = document.createElement('li');
        row.className = results.at(-1).result.toLowerCase();
        row.textContent = `${results.at(-1).result}: ${name}${results.at(-1).error ? ` — ${results.at(-1).error}` : ''}`;
        document.querySelector('#results').append(row);
    }
    document.querySelector('#status').textContent = `${results.filter(item => item.result === 'PASS').length}/${cases.length} passed`;
    document.querySelector('#summary').textContent = JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2);
    event.target.disabled = false;
});
