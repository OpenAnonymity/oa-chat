import assert from 'node:assert/strict';
import test from 'node:test';

const events = [];
globalThis.window ??= {};
globalThis.window.addEventListener ??= () => {};
globalThis.window.location ??= { href: 'http://localhost/', origin: 'http://localhost', hostname: 'localhost' };

const { default: ticketClient } = await import('../../chat/services/ticketClient.js');

const LEGACY_KEY = '61'.repeat(32);

function fakeStore(count, held = 0) {
    const store = {
        count,
        held,
        heldKeyIds: null,
        updates: 0,
        getCount: () => store.count,
        getHeldCount: () => store.held,
        setHeldKeyIds: ids => { store.heldKeyIds = ids; },
        emitUpdate: () => { store.updates += 1; },
        init: async () => {}
    };
    return store;
}

function withStore(store, fn) {
    // The bundled runner shares browser shims across suites. Install the
    // listener during this test, after other suites have registered theirs.
    const previousWindow = globalThis.window;
    globalThis.window ??= {};
    const testWindow = globalThis.window;
    const previousDispatch = testWindow.dispatchEvent;
    testWindow.dispatchEvent = event => {
        if (String(event?.type || '').startsWith('legacy-tickets')) events.push([event.type, event.detail]);
        return true;
    };
    const original = ticketClient.ticketStore;
    ticketClient.ticketStore = store;
    ticketClient.legacyMove = null;
    ticketClient.unannouncedLegacyMove = 0;
    events.length = 0;
    return Promise.resolve().then(fn).finally(() => {
        if (previousDispatch === undefined) delete testWindow.dispatchEvent;
        else testWindow.dispatchEvent = previousDispatch;
        globalThis.window = previousWindow;
        ticketClient.ticketStore = original;
        ticketClient.legacyMove = null;
        ticketClient.legacyTransfer = null;
        ticketClient.legacyTransferRun = null;
        ticketClient.legacyTransferPrimed = false;
        ticketClient.unannouncedLegacyMove = 0;
    });
}

function fakeTransfer(result, { tickets = 0, during = () => {} } = {}) {
    return {
        run: async () => {
            if (tickets) ticketClient.handleLegacyMoveStart(tickets);
            await during();
            return result;
        }
    };
}

test('the shown count holds steady while old tickets leave before new ones arrive', () => withStore(fakeStore(541, 541), async () => {
    assert.equal(ticketClient.getVisibleTicketCount(), 541);
    ticketClient.handleLegacyMoveStart(541);
    assert.equal(ticketClient.getMovingTicketCount(), 541);
    ticketClient.ticketStore.count = 0; // old tickets removed, code saved
    assert.equal(ticketClient.getVisibleTicketCount(), 541);
    assert.equal(ticketClient.getTicketCount(), 0, 'spending logic still sees the real wallet');
    ticketClient.ticketStore.count = 541; // redeemed
    assert.equal(ticketClient.getVisibleTicketCount(), 541);
    ticketClient.legacyMove = null;
    ticketClient.ticketStore.count = 540;
    assert.equal(ticketClient.getVisibleTicketCount(), 540);
}));

test('before a move starts, the held previous-version tickets are the moving count', () => withStore(fakeStore(541, 541), () => {
    assert.equal(ticketClient.getMovingTicketCount(), 541);
    ticketClient.ticketStore.held = 0;
    assert.equal(ticketClient.getMovingTicketCount(), 0);
}));

test('a move announces start, settle and success, in that order', () => withStore(fakeStore(541, 541), async () => {
    ticketClient.legacyTransfer = fakeTransfer({ status: 'moved', moved: 541, redeemed: true, redeemError: null }, {
        tickets: 541,
        during: () => { ticketClient.ticketStore.count = 0; }
    });
    await ticketClient.runLegacyTransfer();
    assert.deepEqual(events, [
        ['legacy-tickets-moving', { tickets: 541 }],
        ['legacy-tickets-move-settled', { moved: 541 }],
        ['legacy-tickets-moved', { moved: 541 }]
    ]);
    assert.equal(ticketClient.legacyMove, null);
}));

test('a failed redeem settles quietly, and the retry announces the earlier move', () => withStore(fakeStore(541, 541), async () => {
    ticketClient.legacyTransfer = fakeTransfer(
        { status: 'moved', moved: 541, redeemed: false, redeemError: new Error('relay down') },
        { tickets: 541, during: () => { ticketClient.ticketStore.count = 0; } }
    );
    await ticketClient.runLegacyTransfer();
    assert.deepEqual(events, [
        ['legacy-tickets-moving', { tickets: 541 }],
        ['legacy-tickets-move-settled', { moved: 0 }]
    ]);
    // The old tickets are gone and the new ones not issued yet: they are
    // still on their way, so the count holds instead of showing zero.
    assert.equal(ticketClient.getVisibleTicketCount(), 541);
    assert.equal(ticketClient.getMovingTicketCount(), 541);
    assert.equal(ticketClient.getTicketCount(), 0, 'spending logic still sees the real wallet');
    events.length = 0;
    // A retry that fails again keeps holding.
    ticketClient.legacyTransfer = fakeTransfer({ status: 'none', moved: 0, redeemed: false, redeemError: new Error('relay down') });
    await ticketClient.runLegacyTransfer();
    assert.deepEqual(events, []);
    assert.equal(ticketClient.getVisibleTicketCount(), 541);
    ticketClient.legacyTransfer = fakeTransfer({ status: 'none', moved: 0, redeemed: true, redeemError: null }, {
        during: () => { ticketClient.ticketStore.count = 541; }
    });
    await ticketClient.runLegacyTransfer();
    assert.deepEqual(events, [['legacy-tickets-moved', { moved: 541 }]]);
    assert.equal(ticketClient.legacyMove, null);
    assert.equal(ticketClient.getVisibleTicketCount(), 541);
}));

test('an early status read holds previous-version tickets before sign-in', () => withStore(fakeStore(541), async () => {
    const original = ticketClient.fetchLegacyTransferInfo;
    let reads = 0;
    ticketClient.fetchLegacyTransferInfo = async () => { reads += 1; return { enabled: true, key_id: LEGACY_KEY }; };
    try {
        await ticketClient.primeLegacyTransfer();
        assert.deepEqual(ticketClient.ticketStore.heldKeyIds, [LEGACY_KEY]);
        await ticketClient.primeLegacyTransfer();
        assert.equal(reads, 1, 'asked once per page');
    } finally {
        ticketClient.fetchLegacyTransferInfo = original;
    }
}));

test('an empty wallet never asks about a move', () => withStore(fakeStore(0), async () => {
    const original = ticketClient.fetchLegacyTransferInfo;
    let reads = 0;
    ticketClient.fetchLegacyTransferInfo = async () => { reads += 1; return { enabled: true, key_id: LEGACY_KEY }; };
    try {
        await ticketClient.primeLegacyTransfer();
        assert.equal(reads, 0);
        assert.equal(ticketClient.ticketStore.heldKeyIds, null);
    } finally {
        ticketClient.fetchLegacyTransferInfo = original;
    }
}));

test('a wallet that opens after startup is primed once it has tickets', () => withStore(fakeStore(0), async () => {
    const original = ticketClient.fetchLegacyTransferInfo;
    let reads = 0;
    ticketClient.fetchLegacyTransferInfo = async () => { reads += 1; return { enabled: true, key_id: LEGACY_KEY }; };
    try {
        await ticketClient.primeLegacyTransfer();
        assert.equal(reads, 0);
        assert.equal(ticketClient.legacyTransferPrimed, false, 'an empty wallet leaves the door open');
        ticketClient.ticketStore.count = 541; // the released account's wallet opened
        await ticketClient.primeLegacyTransfer();
        assert.equal(reads, 1);
        assert.deepEqual(ticketClient.ticketStore.heldKeyIds, [LEGACY_KEY]);
        await ticketClient.primeLegacyTransfer();
        assert.equal(reads, 1, 'still once per page');
    } finally {
        ticketClient.fetchLegacyTransferInfo = original;
    }
}));
