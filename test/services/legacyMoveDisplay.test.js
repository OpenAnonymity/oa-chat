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
    const originalOwner = ticketClient.getLegacyDisplayAccountId;
    ticketClient.getLegacyDisplayAccountId = () => 'account-a';
    ticketClient.ticketStore = store;
    ticketClient.legacyMove = null;
    ticketClient.unannouncedLegacyMoves = new Map();
    events.length = 0;
    return Promise.resolve().then(fn).finally(() => {
        if (previousDispatch === undefined) delete testWindow.dispatchEvent;
        else testWindow.dispatchEvent = previousDispatch;
        globalThis.window = previousWindow;
        ticketClient.ticketStore = original;
        ticketClient.getLegacyDisplayAccountId = originalOwner;
        ticketClient.legacyMove = null;
        ticketClient.legacyTransfer = null;
        ticketClient.legacyTransferRun = null;
        ticketClient.legacyTransferPrimed = false;
        ticketClient.unannouncedLegacyMoves = new Map();
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

function strandingStore(count, held) {
    const store = fakeStore(count, held);
    store.stranded = [];
    store.setStrandedTickets = values => { store.stranded = values; };
    store.getStrandedCount = () => store.stranded.length;
    store.getHeldCount = () => store.held - store.stranded.length;
    return store;
}

test('tickets that cannot move leave the counts and are announced once per run', () => withStore(strandingStore(541, 541), async () => {
    ticketClient.legacyTransfer = fakeTransfer(
        { status: 'limit', moved: 459, redeemed: true, redeemError: null, stranded: Array.from({ length: 82 }, (_, i) => `t${i}`) },
        { tickets: 541 }
    );
    await ticketClient.runLegacyTransfer();
    assert.equal(ticketClient.getStrandedTicketCount(), 82);
    assert.equal(ticketClient.getTicketCount(), 459);
    assert.equal(ticketClient.getVisibleTicketCount(), 459);
    assert.equal(ticketClient.getHeldTicketCount(), 459, 'what is left of the hold is still moving');
    assert.deepEqual(events.at(-1), ['legacy-tickets-moved', { moved: 459, stranded: 82 }]);

    // A later run that moves nothing still says it, as its own line.
    events.length = 0;
    ticketClient.legacyTransfer = fakeTransfer(
        { status: 'limit', moved: 0, redeemed: false, redeemError: null, stranded: Array.from({ length: 82 }, (_, i) => `t${i}`) }
    );
    await ticketClient.runLegacyTransfer();
    assert.deepEqual(events, [['legacy-tickets-stranded', { stranded: 82 }]]);
}));

test('a closed window or a signed-out run leaves the stranded set as the org last said', () => withStore(strandingStore(10, 10), async () => {
    ticketClient.legacyTransfer = fakeTransfer({ status: 'limit', moved: 0, redeemed: false, redeemError: null, stranded: ['a', 'b'] });
    await ticketClient.runLegacyTransfer();
    assert.equal(ticketClient.getStrandedTicketCount(), 2);
    ticketClient.legacyTransfer = fakeTransfer({ status: 'signed-out', moved: 0 });
    await ticketClient.runLegacyTransfer();
    assert.equal(ticketClient.getStrandedTicketCount(), 2, 'signed out: nothing was asked');
    ticketClient.legacyTransfer = fakeTransfer({ status: 'closed', moved: 0, stranded: [] });
    await ticketClient.runLegacyTransfer();
    assert.equal(ticketClient.getStrandedTicketCount(), 0);
}));


test('A restoration progress and announcement counts do not appear in B', () => withStore(fakeStore(40), async () => {
    let owner = 'account-a';
    ticketClient.getLegacyDisplayAccountId = () => owner;
    ticketClient.legacyTransfer = fakeTransfer({ status: 'moved', moved: 40, redeemed: false, redeemError: new Error('offline') }, {
        tickets: 40, during: () => { ticketClient.ticketStore.count = 0; }
    });
    await ticketClient.runLegacyTransfer();
    events.length = 0;
    owner = 'account-b';
    ticketClient.hideLegacyMoveToastOnAccountChange();
    ticketClient.hideLegacyMoveToastOnAccountChange();
    assert.deepEqual(events, [['legacy-tickets-move-settled', { moved: 0 }]]);
    ticketClient.ticketStore.count = 5;
    assert.equal(ticketClient.getVisibleTicketCount(), 5);
    assert.equal(ticketClient.getMovingTicketCount(), 0);
    events.length = 0;
    ticketClient.legacyTransfer = fakeTransfer({ status: 'moved', moved: 5, redeemed: true, redeemError: null }, { tickets: 5 });
    await ticketClient.runLegacyTransfer();
    assert.deepEqual(events.at(-1), ['legacy-tickets-moved', { moved: 5 }]);
    owner = 'account-a';
    ticketClient.legacyTransfer = fakeTransfer({ status: 'none', moved: 0, redeemed: true, redeemError: null });
    await ticketClient.runLegacyTransfer();
    assert.deepEqual(events.at(-1), ['legacy-tickets-moved', { moved: 40 }]);
}));

test('late completion after switching accounts cannot update B or show A success', () => withStore(strandingStore(5, 0), async () => {
    let owner = 'account-a';
    ticketClient.getLegacyDisplayAccountId = () => owner;
    ticketClient.legacyTransfer = fakeTransfer({ status: 'moved', moved: 40, redeemed: true, redeemError: null, stranded: ['old'] }, {
        tickets: 40, during: () => { owner = 'account-b'; }
    });
    await ticketClient.runLegacyTransfer();
    assert.equal(ticketClient.getVisibleTicketCount(), 5);
    assert.equal(ticketClient.getStrandedTicketCount(), 0);
    assert.ok(!events.some(([event]) => event === 'legacy-tickets-moved'));
}));


test('handoff hides an in-flight loading notice before the old request completes', () => withStore(fakeStore(40), async () => {
    let owner = 'account-a';
    ticketClient.getLegacyDisplayAccountId = () => owner;
    ticketClient.legacyTransfer = fakeTransfer({ status: 'moved', moved: 40, redeemed: true }, {
        tickets: 40,
        during: () => {
            assert.equal(events.at(-1)[0], 'legacy-tickets-moving');
            events.length = 0;
            owner = 'account-b';
            ticketClient.hideLegacyMoveToastOnAccountChange();
            assert.deepEqual(events, [['legacy-tickets-move-settled', { moved: 0 }]]);
        }
    });
    await ticketClient.runLegacyTransfer();
    assert.ok(!events.some(([event]) => event === 'legacy-tickets-moved'));
}));
