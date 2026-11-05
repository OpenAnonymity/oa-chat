import test from 'node:test';
import assert from 'node:assert/strict';
import { accessCoversModel, findTierAccess, retainTicketAccess, mergeTicketAccessHistory, ticketTierPolicyEnabled } from '../../chat/services/inference/ticketTierAccess.js';
import { withTierPurchaseLock } from '../../chat/services/inference/tierPurchaseLock.js';
const future = () => new Date(Date.now() + 600000).toISOString();
const access = (key, paid, models = null) => ({ key, ticketsConsumed: paid, expiresAt: future(), stationId: key, ...(models ? { modelPolicy: { version: 1, tickets: paid, allowed_models: models } } : {}) });
const session = info => ({ id: 's', apiKey: info.key, apiKeyInfo: info, expiresAt: info.expiresAt });
const service = {
    getAccessToken: s => s.apiKeyInfo?.rejected ? null : s.apiKey,
    isAccessExpired: s => Date.parse(s.expiresAt) <= Date.now(),
    setAccessInfo: (s, info) => { retainTicketAccess(s); Object.assign(s, session(info)); },
    getVerificationAdapter: () => ({ getAccessId: info => info?.stationId, isAccessBanned: id => id === 'banned' })
};
test('1→5 requires purchase; 5→1→5 reuses access and immutable policy survives price changes', () => {
    assert.equal(accessCoversModel(access('cheap', 1), 'p/sol', 5), false);
    const high = access('high', 5, ['p/cheap', 'p/sol']);
    assert.equal(accessCoversModel(high, 'p/cheap', 1), true);
    assert.equal(accessCoversModel(high, 'p/sol', 25), true);
    assert.equal(accessCoversModel(high, 'p/premium', 1), false);
});
test('unknown and malformed purchase metadata cannot authorize an upgrade', () => {
    for (const info of [{}, { ticketsConsumed: -1 }, { modelPolicy: {} }, { ticketsConsumed: 1 }]) assert.equal(accessCoversModel(info, 'p/sol', 5), false);
});
test('expired active key reuses retained eligible key; banned/rejected keys never restore', () => {
    const s = session({ ...access('expired', 5), expiresAt: '2000-01-01' });
    s.ticketAccessHistory = [access('banned', 5), { ...access('rejected', 5), rejected: true }, access('good', 5)];
    assert.equal(findTierAccess(s, 'p/sol', 5, service).key, 'good');
});
test('stale saves merge paid history and never resurrect retired exhausted keys', () => {
    const stored = { ...session(access('new', 5)), ticketAccessHistory: [access('old', 1)] };
    const incoming = { ...session(access('old', 1)), retiredTicketAccess: [access('old', 1)] };
    const merged = mergeTicketAccessHistory(incoming, stored);
    assert.deepEqual(merged.ticketAccessHistory.map(x => x.key), ['new']);
    assert.equal(findTierAccess({ ...incoming, ...merged }, 'p/cheap', 1, service).key, 'new');
});
test('only staging activates the behavior', () => {
    const original = globalThis.location;
    try {
        globalThis.location = { hostname: 'chat.openanonymity.ai' }; assert.equal(ticketTierPolicyEnabled(), false);
        globalThis.location = { hostname: 'staging.openanonymity.ai' }; assert.equal(ticketTierPolicyEnabled(), true);
    } finally { globalThis.location = original; }
});
test('two tabs purchase once, preserve stored history and do not overwrite another tab model', async () => {
    let stored = { ...session(access('cheap', 1)), model: 'other-tab-model', ticketAccessHistory: [access('older', 3)] };
    let queue = Promise.resolve(); let purchases = 0;
    const locks = { request: (_name, _opts, callback) => { const result = queue.then(callback); queue = result.catch(() => {}); return result; } };
    const db = { getSession: async () => structuredClone(stored), saveSession: async s => { stored = structuredClone(s); }, updateExistingSession: async (_id, fn) => fn(stored) };
    const run = s => withTierPurchaseLock({ session: s, modelId: 'p/sol', cost: 5, service, db, locks, acquire: async () => {
        purchases++; service.setAccessInfo(s, access('high', 5)); s.model = stored.model; await db.saveSession(s); return s.apiKey;
    } });
    await Promise.all([run({ ...session(access('cheap', 1)), model: 'A' }), run({ ...session(access('cheap', 1)), model: 'B' })]);
    assert.equal(purchases, 1); assert.equal(stored.apiKey, 'high'); assert.equal(stored.model, 'other-tab-model');
    assert.ok(stored.ticketAccessHistory.some(x => x.key === 'older'));
});
test('failed purchase retains old access, and absence of locks cannot spend', async () => {
    const s = session(access('cheap', 1));
    const args = { session: s, modelId: 'p/sol', cost: 5, service, db: { getSession: async () => s }, acquire: async () => { throw new Error('failed'); } };
    await assert.rejects(withTierPurchaseLock({ ...args, locks: { request: (_n, _o, fn) => fn() } }), /failed/);
    assert.equal(s.apiKey, 'cheap');
    await assert.rejects(withTierPurchaseLock({ ...args, locks: null }), /locking/);
});

test('upgrading a shared key preserves session-level expiry and reuses the original purchase', () => {
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const original = { apiKey: 'shared', expiresAt, apiKeyInfo: { key: 'shared', ticketsConsumed: 5 } };
    retainTicketAccess(original);
    assert.equal(original.ticketAccessHistory[0].key, 'shared');
    assert.equal(original.ticketAccessHistory[0].expiresAt, expiresAt);
    original.apiKey = 'upgraded';
    original.apiKeyInfo = { key: 'upgraded', ticketsConsumed: 10, expiresAt };
    original.retiredTicketAccess = [{key:'upgraded',expiresAt}];
    const restored = findTierAccess(original, 'p/high', 5, {getAccessToken:s=>s.apiKey,isAccessExpired:s=>Date.parse(s.expiresAt)<=Date.now()});
    assert.equal(restored.key, 'shared');
});

test('active imported access keeps session expiry when restored by a purchase lock', async () => {
    const expiresAt = future();
    const stored = { id:'chat', apiKey:'shared', expiresAt, apiKeyInfo:{key:'shared',ticketsConsumed:5} };
    const stale = { id:'chat' };
    const service = { getAccessToken:s=>s.apiKey, isAccessExpired:s=>!s.expiresAt||Date.parse(s.expiresAt)<=Date.now(),
        setAccessInfo:(s,info)=>Object.assign(s,{apiKey:info.key,apiKeyInfo:info,expiresAt:info.expiresAt}) };
    let purchases=0;
    await withTierPurchaseLock({session:stale,modelId:'p/high',cost:5,service,
        db:{getSession:async()=>stored,updateExistingSession:async(_id,fn)=>fn(stored)},
        locks:{request:(_name,_options,fn)=>fn()},acquire:async()=>{purchases++;}});
    assert.equal(purchases,0);assert.equal(stale.apiKey,'shared');assert.equal(stale.expiresAt,expiresAt);
    assert.equal(service.isAccessExpired(stale),false);assert.equal(stored.expiresAt,expiresAt);
});
