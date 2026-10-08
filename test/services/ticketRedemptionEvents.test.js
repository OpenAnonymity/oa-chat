import test from 'node:test';
import assert from 'node:assert/strict';

const { default: ticketClient } = await import('../../chat/services/ticketClient.js');
const runCodeRedemption = Object.getPrototypeOf(ticketClient).runCodeRedemption;

function withWindow(t) {
    const events = [];
    const original = globalThis.window;
    globalThis.window = { dispatchEvent: event => { events.push({ type: event.type, detail: event.detail }); return true; } };
    t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original; });
    return events;
}

test('a redemption announces its progress and settles once, for the ticket status', async t => {
    const events = withWindow(t);
    const seen = [];
    const client = { getCodeRedeemer: () => ({ run: async (code, progress) => {
        progress('Preparing tickets…', 2);
        progress('Code redeemed!', 100);
        return { tickets_issued: 5 };
    } }) };
    const result = await runCodeRedemption.call(client, 'abc', (message, percent) => seen.push([message, percent]));
    assert.equal(result.tickets_issued, 5);
    assert.deepEqual(seen, [['Preparing tickets…', 2], ['Code redeemed!', 100]], 'the caller still gets its progress');
    assert.deepEqual(events.map(event => event.type), ['tickets-redemption-progress', 'tickets-redemption-progress', 'tickets-redemption-settled']);
    assert.deepEqual(events[0].detail, { source: 'code', message: 'Preparing tickets…', percent: 2 });
    assert.deepEqual(events[2].detail, { source: 'code', ok: true, issued: 5 });
});

test('the previous-version move is labelled, a failure settles as not ok, and a run with nothing to do stays silent', async t => {
    const events = withWindow(t);
    const failing = { getCodeRedeemer: () => ({ run: async (code, progress) => { progress('Redeeming saved code…', 65); throw new Error('nope'); } }) };
    await assert.rejects(runCodeRedemption.call(failing, null, undefined, { source: 'legacy-transfer' }), /nope/);
    assert.deepEqual(events.at(-1), { type: 'tickets-redemption-settled', detail: { source: 'legacy-transfer', ok: false, issued: 0 } });

    events.length = 0;
    const idle = { getCodeRedeemer: () => ({ run: async () => null }) };
    assert.equal(await runCodeRedemption.call(idle, null), null);
    assert.deepEqual(events, [], 'a resume with nothing pending says nothing');
});
