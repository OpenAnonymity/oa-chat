// The decision half of "Give up this balance": chat/zkapi/versioning/abandonNote.mjs.
//
// Pins: the dust math is the SDK's own (installed legacy SDK compared live, the
// 0.2.0 successor by vectors produced by its real modules and, when a
// successor alias is installed, live); the dust bound holds whatever the quote
// says (absolute ceiling, extreme answers, stale and future-dated quotes); the
// strict verdict refuses every shape it does not recognize; and each blockedBy
// code is reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAT_SPENDING_TIER_USD } from '@openanonymity/zkapi-browser-sdk/request-compat';
import {
    ABANDON_BLOCKED_BY, DEFAULT_DUST_CEILING_UNITS, DEFAULT_DUST_THRESHOLD_USD_MICROS, DEFAULT_SMALLEST_TIER_USD_MICROS,
    abandonStatus, abandonVerdict, classifyBalance, formatEthUnits, formatUsdMicros, isBareNote,
    nativeUnitsForUsdMicros, nativeUsdMicros
} from '../../chat/zkapi/versioning/abandonNote.mjs';
import { describeSlot } from '../../chat/zkapi/versioning/walletHoldings.mjs';

const DEPLOYMENT = 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930';
const NOW = 1_800_000_000;
const CAP = 50_000; // request_charge_cap of both deployments, gwei

function quote(answer, { decimals = 8, updatedAt = NOW - 100, ttl = 4500, ...rest } = {}) {
    return { asset: 'native_eth', units_per_eth: 1_000_000_000, chain_id: 1, feed_address: `0x${'ab'.repeat(20)}`,
        decimals, round_id: '77', answer: String(answer), updated_at: updatedAt, expires_at: updatedAt + ttl, ...rest };
}
// ETH at $3000 with 8 feed decimals: $1.00 is 333,334 gwei (rounded up).
const ETH_3000 = quote('300000000000');

// ---------------------------------------------------------------- source rules

test('the module imports nothing but the holdings classifier (no SDK, DOM or storage)', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../chat/zkapi/versioning/abandonNote.mjs', import.meta.url)), 'utf8');
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(match => match[1]);
    assert.deepEqual(specifiers, ['./walletHoldings.mjs']);
    assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /\b(?:document|window|localStorage|indexedDB|navigator|Date\.now|fetch)\b/);
});

// ---------------------------------------------------------------- math parity

// Produced by the real 0.2.0 modules (sdk/services/zkapiNativeEth.mjs,
// zkapiRequestCompat.mjs; upstream revision 82c8504): nativeUnitsForUsd and
// nativeUsdMicros over the quotes below, USD given as a six-decimal string and
// results as BigInt text; null where the SDK throws. Regenerate by importing
// those two modules and mapping each (usd, quote) and (units, quote) pair;
// they were identical in the legacy SDK when this was written.
const V2_TIERS = [1, 2, 3, 4.5, 6];
const V2_VECTORS = [
    { label: 'eth-3000-8dp', answer: '300000000000', decimals: 8,
        usdToUnits: [[1, '1'], [10000, '3334'], [420000, '140000'], [999999, '333333'], [1000000, '333334'], [1500000, '500000'], [4500000, '1500000'], [6000000, '2000000']],
        unitsToUsd: [[0, '0'], [1, '3'], [49999, '149997'], [50000, '150000'], [420000, '1260000'], [5000000, '15000000'], [1000000000, '3000000000'], [9007199254740991, '27021597764222973']] },
    { label: 'eth-20000-8dp', answer: '2000000000000', decimals: 8,
        usdToUnits: [[1, '1'], [10000, '500'], [420000, '21000'], [999999, '50000'], [1000000, '50000'], [1500000, '75000'], [4500000, '225000'], [6000000, '300000']],
        unitsToUsd: [[0, '0'], [1, '20'], [49999, '999980'], [50000, '1000000'], [420000, '8400000'], [5000000, '100000000'], [1000000000, '20000000000'], [9007199254740991, '180143985094819820']] },
    { label: 'eth-100-8dp', answer: '10000000000', decimals: 8,
        usdToUnits: [[1, '10'], [10000, '100000'], [420000, '4200000'], [999999, '9999990'], [1000000, '10000000'], [1500000, '15000000'], [4500000, '45000000'], [6000000, '60000000']],
        unitsToUsd: [[0, '0'], [1, '0'], [49999, '4999'], [50000, '5000'], [420000, '42000'], [5000000, '500000'], [1000000000, '100000000'], [9007199254740991, '900719925474099']] },
    { label: 'answer-1', answer: '1', decimals: 8,
        usdToUnits: [[1, '100000000000'], [10000, '1000000000000000'], [420000, null], [999999, null], [1000000, null], [1500000, null], [4500000, null], [6000000, null]],
        unitsToUsd: [[0, '0'], [1, '0'], [49999, '0'], [50000, '0'], [420000, '0'], [5000000, '0'], [1000000000, '0'], [9007199254740991, '90071']] },
    { label: 'answer-1e6', answer: '1000000', decimals: 8,
        usdToUnits: [[1, '100000'], [10000, '1000000000'], [420000, '42000000000'], [999999, '99999900000'], [1000000, '100000000000'], [1500000, '150000000000'], [4500000, '450000000000'], [6000000, '600000000000']],
        unitsToUsd: [[0, '0'], [1, '0'], [49999, '0'], [50000, '0'], [420000, '4'], [5000000, '50'], [1000000000, '10000'], [9007199254740991, '90071992547']] },
    { label: 'answer-1e18', answer: '1000000000000000000', decimals: 8,
        usdToUnits: [[1, '1'], [10000, '1'], [420000, '1'], [999999, '1'], [1000000, '1'], [1500000, '1'], [4500000, '1'], [6000000, '1']],
        unitsToUsd: [[0, '0'], [1, '10000000'], [49999, '499990000000'], [50000, '500000000000'], [420000, '4200000000000'], [5000000, '50000000000000'], [1000000000, '10000000000000000'], [9007199254740991, '90071992547409910000000']] },
    { label: 'dec-0', answer: '3000', decimals: 0,
        usdToUnits: [[1, '1'], [10000, '3334'], [420000, '140000'], [999999, '333333'], [1000000, '333334'], [1500000, '500000'], [4500000, '1500000'], [6000000, '2000000']],
        unitsToUsd: [[0, '0'], [1, '3'], [49999, '149997'], [50000, '150000'], [420000, '1260000'], [5000000, '15000000'], [1000000000, '3000000000'], [9007199254740991, '27021597764222973']] },
    { label: 'dec-18', answer: '1000000000000000000', decimals: 18,
        usdToUnits: [[1, '1000'], [10000, '10000000'], [420000, '420000000'], [999999, '999999000'], [1000000, '1000000000'], [1500000, '1500000000'], [4500000, '4500000000'], [6000000, '6000000000']],
        unitsToUsd: [[0, '0'], [1, '0'], [49999, '49'], [50000, '50'], [420000, '420'], [5000000, '5000'], [1000000000, '1000000'], [9007199254740991, '9007199254740']] }
];

test('the dust math reproduces the successor SDK\'s own functions on its vectors', () => {
    for (const row of V2_VECTORS) {
        const q = quote(row.answer, { decimals: row.decimals });
        for (const [micros, expected] of row.usdToUnits) {
            const got = nativeUnitsForUsdMicros(micros, q);
            assert.equal(got === null ? null : got.toString(), expected, `${row.label}: ${micros} micro-USD in gwei`);
        }
        for (const [units, expected] of row.unitsToUsd) {
            // The SDK returns a BigInt; the host keeps a number and refuses
            // what is not a safe integer.
            const want = expected !== null && BigInt(expected) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(expected) : null;
            assert.equal(nativeUsdMicros(units, q), want, `${row.label}: ${units} gwei in micro-USD`);
        }
    }
});

test('the smallest chat key the rule defaults to is the first tier of both SDKs', () => {
    assert.equal(CHAT_SPENDING_TIER_USD[0] * 1_000_000, DEFAULT_SMALLEST_TIER_USD_MICROS);
    assert.equal(V2_TIERS[0] * 1_000_000, DEFAULT_SMALLEST_TIER_USD_MICROS);
    assert.equal(DEFAULT_DUST_THRESHOLD_USD_MICROS, DEFAULT_SMALLEST_TIER_USD_MICROS);
    assert.equal(DEFAULT_DUST_CEILING_UNITS, 5_000_000, 'the ceiling is 0.005 ETH in gwei');
});

// Every SDK math module this checkout can run: the installed legacy package
// and each registry alias that is installed (a successor's real module comes
// under this guard the moment its alias is).
function installedNativeEthModules() {
    const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const legacyRoot = path.dirname(fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/package.json')));
    const found = [{ name: 'installed legacy SDK', file: path.join(legacyRoot, 'sdk/services/zkapiNativeEth.mjs') }];
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) {
        const file = path.join(repoRoot, 'node_modules', row.sdk.alias, 'sdk/services/zkapiNativeEth.mjs');
        if (fs.existsSync(file) && !found.some(entry => fs.realpathSync(entry.file) === fs.realpathSync(file))) {
            found.push({ name: `registry alias ${row.sdk.alias}`, file });
        }
    }
    return found;
}

// A deterministic generator: the same cases on every run.
function sequence(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

test('the dust math equals the installed SDKs on a fuzzed range of quotes and amounts', async () => {
    const modules = installedNativeEthModules();
    assert.ok(modules.length >= 1 && fs.existsSync(modules[0].file));
    const random = sequence(20260930);
    const pick = list => list[Math.floor(random() * list.length)];
    const digits = () => {
        // log-uniform: 1 .. 1e18
        const exponent = Math.floor(random() * 18);
        return String(BigInt(Math.floor(random() * 9) + 1) * 10n ** BigInt(exponent) + BigInt(Math.floor(random() * 1000)));
    };
    for (const { name, file } of modules) {
        const sdk = await import(pathToFileURL(file).href);
        const seen = { units: 0, unitsNull: 0, micros: 0, microsNull: 0 };
        for (let index = 0; index < 1500; index += 1) {
            const answer = digits();
            const q = quote(answer, { decimals: pick([0, 6, 8, 8, 8, 18]) });
            const micros = pick([1, 7, 10_000, 420_000, 999_999, 1_000_000, 1_500_000, 6_000_000,
                Math.floor(random() * 10_000_000) + 1]);
            const usd = `${Math.floor(micros / 1e6)}.${String(micros % 1e6).padStart(6, '0')}`;
            let expectedUnits;
            try { expectedUnits = sdk.nativeUnitsForUsd(usd, q); } catch { expectedUnits = null; }
            const units = nativeUnitsForUsdMicros(micros, q);
            assert.equal(units, expectedUnits, `${name}: ${usd} at ${answer}/${q.decimals}`);
            seen[units === null ? 'unitsNull' : 'units'] += 1;

            const amount = pick([0, 1, 49_999, 50_000, 5_000_000, Math.floor(random() * 1e9),
                Math.floor(random() * Number.MAX_SAFE_INTEGER)]);
            let expectedMicros;
            try { expectedMicros = sdk.nativeUsdMicros(amount, q); } catch { expectedMicros = null; }
            const got = nativeUsdMicros(amount, q);
            const want = expectedMicros !== null && expectedMicros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(expectedMicros) : null;
            assert.equal(got, want, `${name}: ${amount} gwei at ${answer}/${q.decimals}`);
            seen[got === null ? 'microsNull' : 'micros'] += 1;
        }
        // The comparison covered both outcomes, not one branch.
        assert.ok(seen.units > 300 && seen.unitsNull > 30 && seen.micros > 300 && seen.microsNull > 30,
            `${name}: ${JSON.stringify(seen)}`);
    }
});

test('a quote the SDK would not accept is never used', () => {
    const bad = {
        'no quote': null,
        'not an object': 'quote',
        'another asset': quote('300000000000', { asset: 'erc20' }),
        'another unit scale': quote('300000000000', { units_per_eth: 1_000_000 }),
        'a zero answer': quote('0'),
        'a negative answer': quote('-5'),
        'a fractional answer': quote('1.5'),
        'an answer above the SDK bound': quote('1000000000000000001'),
        'a non-numeric answer': quote('abc'),
        'a missing answer': { ...quote('1'), answer: undefined },
        'decimals above the bound': quote('300000000000', { decimals: 37 }),
        'negative decimals': quote('300000000000', { decimals: -1 }),
        'fractional decimals': quote('300000000000', { decimals: 8.5 }),
        'an unordered window': quote('300000000000', { ttl: 0 }),
        'a missing timestamp': quote('300000000000', { updated_at: undefined })
    };
    for (const [label, q] of Object.entries(bad)) {
        assert.equal(nativeUnitsForUsdMicros(1_000_000, q), null, label);
        assert.equal(nativeUsdMicros(1_000, q), null, label);
    }
    // A quote is judged at the instant the caller names.
    const expired = quote('300000000000', { updatedAt: NOW - 5000, ttl: 4500 });
    const future = quote('300000000000', { updatedAt: NOW + 10 });
    assert.equal(nativeUnitsForUsdMicros(1_000_000, expired, NOW), null);
    assert.equal(nativeUnitsForUsdMicros(1_000_000, future, NOW), null);
    assert.equal(nativeUnitsForUsdMicros(1_000_000, ETH_3000, NOW), 333_334n);
    assert.equal(nativeUnitsForUsdMicros(1_000_000, expired), 333_334n, 'without an instant only the shape is judged');
    // A non-positive or unsafe amount is not a request for a value.
    for (const micros of [0, -1, 1.5, '1', NaN, Infinity]) assert.equal(nativeUnitsForUsdMicros(micros, ETH_3000), null, String(micros));
    for (const units of [-1, 1.5, NaN, '1.5', Number.MAX_SAFE_INTEGER + 1, 2 ** 60]) assert.equal(nativeUsdMicros(units, ETH_3000), null, String(units));
});

// ------------------------------------------------------------------ formatting

test('amounts read as the person would write them, never larger than they are', () => {
    for (const [micros, text] of [
        [0, '$0.00'], [420_000, '$0.42'], [999_999, '$0.99'], [1_000_000, '$1.00'], [1_234_567_890, '$1,234.56'],
        [10_000, '$0.01'], [9_999, 'less than $0.01'], [1, 'less than $0.01']
    ]) assert.equal(formatUsdMicros(micros), text, String(micros));
    for (const bad of [-1, 1.5, NaN, 'abc', null, undefined, {}]) assert.equal(formatUsdMicros(bad), '', String(bad));
    assert.equal(formatUsdMicros('420000'), '$0.42');

    for (const [units, text] of [
        [0, '0'], [1, '0.000000001'], [420_000, '0.00042'], [5_000_000, '0.005'], [1_000_000_000, '1'],
        [1_500_000_000, '1.5'], ['420000', '0.00042'], [9_007_199_254_740_991, '9007199.254740991']
    ]) assert.equal(formatEthUnits(units), text, String(units));
    for (const bad of [-1, 1.5, NaN, 'x', null, undefined, Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatEthUnits(bad), '', String(bad));
});

// ------------------------------------------------------------- classification

const kindOf = (balance, extra = {}) => classifyBalance({ balanceUnits: balance, chargeCapUnits: CAP, ...extra });

test('zero needs no price and no cap; anything else needs both a bound and a reading', () => {
    assert.deepEqual(classifyBalance({ balanceUnits: 0 }), { kind: 'zero', limitUnits: null });
    assert.deepEqual(classifyBalance({ balanceUnits: '0', chargeCapUnits: undefined, quote: null }), { kind: 'zero', limitUnits: null });
    // The dust leg switched off still leaves an empty balance eligible.
    assert.equal(kindOf(0, { thresholdUsdMicros: 0 }).kind, 'zero');
    // No cap known: nothing but zero qualifies.
    assert.deepEqual(classifyBalance({ balanceUnits: 1, quote: ETH_3000 }), { kind: 'above', limitUnits: null });
    assert.deepEqual(classifyBalance({ balanceUnits: 1, chargeCapUnits: 0, quote: ETH_3000 }), { kind: 'above', limitUnits: null });
    assert.deepEqual(classifyBalance({ balanceUnits: 1, chargeCapUnits: 'x', quote: ETH_3000 }), { kind: 'above', limitUnits: null });
});

test('the line is the larger of the charge cap and the smallest chat key at the quoted price', () => {
    // $3000: one dollar is 333,334 gwei, above the 50,000 cap.
    assert.deepEqual(kindOf(333_333, { quote: ETH_3000 }), { kind: 'dust', limitUnits: '333334' });
    assert.deepEqual(kindOf(333_334, { quote: ETH_3000 }), { kind: 'above', limitUnits: '333334' });
    assert.deepEqual(kindOf(1, { quote: ETH_3000 }), { kind: 'dust', limitUnits: '333334' });
    // $25,000: one dollar is 40,000 gwei, below the cap: the cap is the line
    // (the SDK refuses a key whose budget is below it).
    const dear = quote('2500000000000');
    assert.deepEqual(kindOf(49_999, { quote: dear }), { kind: 'dust', limitUnits: '50000' });
    assert.deepEqual(kindOf(50_000, { quote: dear }), { kind: 'above', limitUnits: '50000' });
    // The same on both sides of exactly $20,000, where cap and key are equal.
    const equal = quote('2000000000000');
    assert.deepEqual(kindOf(49_999, { quote: equal }), { kind: 'dust', limitUnits: '50000' });
    assert.deepEqual(kindOf(50_000, { quote: equal }), { kind: 'above', limitUnits: '50000' });
});

test('without a usable price only the cap counts, and a balance past it is not guessed at', () => {
    assert.deepEqual(kindOf(49_999), { kind: 'dust', limitUnits: '50000' });
    assert.deepEqual(kindOf(50_000), { kind: 'price_unknown', limitUnits: null });
    assert.deepEqual(kindOf(5_000_000), { kind: 'price_unknown', limitUnits: null });
    const expired = quote('300000000000', { updatedAt: NOW - 9000, ttl: 4500 });
    const future = quote('300000000000', { updatedAt: NOW + 60 });
    // Judged at NOW these two are unusable; as bare shapes they would be.
    assert.deepEqual(kindOf(100_000, { quote: expired, nowSeconds: NOW }), { kind: 'price_unknown', limitUnits: null });
    assert.deepEqual(kindOf(100_000, { quote: future, nowSeconds: NOW }), { kind: 'price_unknown', limitUnits: null });
    assert.deepEqual(kindOf(100_000, { quote: expired }), { kind: 'dust', limitUnits: '333334' });
    // A quote exactly at its expiry is expired; one just before is current.
    const edge = quote('300000000000', { updatedAt: NOW - 4500, ttl: 4500 });
    assert.equal(kindOf(100_000, { quote: edge, nowSeconds: NOW }).kind, 'price_unknown');
    assert.equal(kindOf(100_000, { quote: edge, nowSeconds: NOW - 1 }).kind, 'dust');
    // A malformed quote is no quote.
    assert.equal(kindOf(100_000, { quote: { answer: '300000000000' } }).kind, 'price_unknown');
});

test('the ceiling bounds dust whatever the quote answers', () => {
    // A depressed price: one dollar would be 100,000,000 gwei (0.1 ETH).
    const cheap = quote('1000000000');
    assert.deepEqual(kindOf(4_999_999, { quote: cheap }), { kind: 'dust', limitUnits: '5000000' });
    assert.deepEqual(kindOf(5_000_000, { quote: cheap }), { kind: 'above', limitUnits: '5000000' });
    // The extreme answers the SDK still accepts.
    for (const [answer, balance] of [['1', 5_000_000], ['1000000', 5_000_000], ['1000000000000000000', 49_999]]) {
        const verdict = kindOf(balance, { quote: quote(answer) });
        const limit = BigInt(verdict.limitUnits ?? '0');
        assert.ok(limit <= BigInt(DEFAULT_DUST_CEILING_UNITS), `answer ${answer}: limit ${limit} is within the ceiling`);
    }
    assert.notEqual(kindOf(5_000_000, { quote: quote('1') }).kind, 'dust');
    assert.notEqual(kindOf(5_000_000, { quote: quote('1000000') }).kind, 'dust');
    // A tighter ceiling is honored; a looser one is adapter data.
    assert.deepEqual(kindOf(999, { quote: ETH_3000, ceilingUnits: 1_000 }), { kind: 'dust', limitUnits: '1000' });
    assert.deepEqual(kindOf(1_000, { quote: ETH_3000, ceilingUnits: 1_000 }), { kind: 'above', limitUnits: '1000' });
    assert.equal(kindOf(6_000_000, { quote: cheap, ceilingUnits: 10_000_000 }).kind, 'dust');
    // Without any ceiling given the default applies (0.005 ETH).
    assert.equal(kindOf(5_000_000, { quote: cheap, ceilingUnits: undefined }).kind, 'above');
});

test('thresholds: lowered, switched off, clamped to the smallest key, and malformed turns the leg off', () => {
    // Half a dollar at $3000 is 166,667 gwei.
    assert.deepEqual(kindOf(166_666, { quote: ETH_3000, thresholdUsdMicros: 500_000 }), { kind: 'dust', limitUnits: '166667' });
    assert.equal(kindOf(166_667, { quote: ETH_3000, thresholdUsdMicros: 500_000 }).kind, 'above');
    // 0 switches the dust leg off, with or without a price.
    assert.equal(kindOf(1, { quote: ETH_3000, thresholdUsdMicros: 0 }).kind, 'above');
    assert.equal(kindOf(1, { thresholdUsdMicros: 0 }).kind, 'above');
    // Above the smallest chat key it is lowered to it: the same verdicts.
    for (const balance of [333_333, 333_334, 1_000_000]) {
        assert.deepEqual(kindOf(balance, { quote: ETH_3000, thresholdUsdMicros: 5_000_000 }),
            kindOf(balance, { quote: ETH_3000 }), String(balance));
    }
    assert.deepEqual(kindOf(333_333, { quote: ETH_3000, thresholdUsdMicros: 2_000_000, smallestTierUsdMicros: 1_000_000 }),
        { kind: 'dust', limitUnits: '333334' });
    // Present but malformed: off, never "default".
    for (const bad of [-1, 1.5, '1000000', NaN, {}]) {
        assert.equal(kindOf(1, { quote: ETH_3000, thresholdUsdMicros: bad }).kind, 'above', `threshold ${String(bad)}`);
        assert.equal(kindOf(1, { quote: ETH_3000, ceilingUnits: bad }).kind, 'above', `ceiling ${String(bad)}`);
    }
});

test('balances that are not plain non-negative integers are unknown, never dust', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, '1.5', '-1', '1e3', ' 1', '', 'abc', null, undefined, {}, [], true,
        Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) {
        assert.equal(kindOf(bad, { quote: ETH_3000 }).kind, 'unknown', String(JSON.stringify(bad)));
    }
    assert.equal(kindOf('120').kind, 'dust');
    assert.equal(kindOf(120n).kind, 'dust');
});

// ----------------------------------------------------------------- the status

const statusInput = (overrides = {}) => ({
    status: 'exit-only', supported: true, enabled: true, hasTarget: true, hasNote: true,
    balanceUnits: '120', chargeCapUnits: CAP, quote: null,
    inFlight: false, claimed: false, hasOpenWithdrawal: false, hasPreparedWithdrawal: false,
    hasPendingDeposit: false, hasUnsentPrepared: false, lockHeld: false, setAsideCount: 0, unresolvedRequests: 0,
    ...overrides
});

test('abandonStatus: available only when every fact the strict verdict refuses on is clear', () => {
    assert.deepEqual(abandonStatus(statusInput()), { available: true, kind: 'dust', blockedBy: null });
    assert.deepEqual(abandonStatus(statusInput({ balanceUnits: 0 })), { available: true, kind: 'zero', blockedBy: null });
    const refused = (overrides, blockedBy) => assert.deepEqual(abandonStatus(statusInput(overrides)),
        { available: false, kind: null, blockedBy }, JSON.stringify(overrides));

    refused({ status: 'active' }, 'not_applicable');
    refused({ status: 'retired' }, 'not_applicable');
    refused({ status: undefined }, 'not_applicable');
    refused({ hasTarget: false }, 'not_applicable');
    refused({ hasTarget: undefined }, 'not_applicable');
    refused({ supported: false }, 'not_applicable');
    refused({ supported: undefined }, 'not_applicable');
    refused({ enabled: false }, 'disabled');
    refused({ enabled: undefined }, 'disabled');
    refused({ configMismatch: true }, 'config_mismatch');
    refused({ reloadRequired: true }, 'reload_required');
    refused({ hasNote: false }, 'no_note');
    refused({ claimed: true }, 'claimed');
    refused({ inFlight: true }, 'in_flight');
    refused({ hasOpenWithdrawal: true }, 'open_withdrawal');
    refused({ hasPreparedWithdrawal: true }, 'open_withdrawal');
    refused({ setAsideCount: 1 }, 'open_withdrawal');
    refused({ hasPendingDeposit: true }, 'pending_deposit');
    refused({ hasUnsentPrepared: true }, 'pending_deposit');
    refused({ lockHeld: true }, 'exit_lock');
    refused({ unresolvedRequests: 1 }, 'unresolved_request');
    refused({ unresolvedRequests: NaN }, 'unresolved_request');
    refused({ setAsideCount: NaN }, 'open_withdrawal');
    refused({ balanceUnits: 50_000 }, 'price_unknown');
    refused({ balanceUnits: 50_000, quote: quote('2500000000000') }, 'not_dust');
    refused({ balanceUnits: 'x' }, 'unknown_state');
    refused({ balanceUnits: undefined }, 'unknown_state');
    refused({ chargeCapUnits: undefined }, 'not_dust');
});

test('abandonStatus: the first refusal in a fixed order wins, and a quote near its end is judged at the given instant', () => {
    assert.equal(abandonStatus(statusInput({ status: 'active', enabled: false, hasNote: false })).blockedBy, 'not_applicable');
    assert.equal(abandonStatus(statusInput({ enabled: false, hasNote: false })).blockedBy, 'disabled');
    assert.equal(abandonStatus(statusInput({ inFlight: true, lockHeld: true, balanceUnits: 'x' })).blockedBy, 'in_flight');
    // At NOW the quote has expired, so a balance past the cap cannot be valued.
    const stale = quote('300000000000', { updatedAt: NOW - 9000, ttl: 4500 });
    assert.equal(abandonStatus(statusInput({ balanceUnits: 100_000, quote: stale, nowSeconds: NOW })).blockedBy, 'price_unknown');
    assert.equal(abandonStatus(statusInput({ balanceUnits: 100_000, quote: ETH_3000, nowSeconds: NOW })).kind, 'dust');
    // Nothing is carried through but the three fields, and the exact balance is not among them.
    assert.deepEqual(Object.keys(abandonStatus(statusInput())).sort(), ['available', 'blockedBy', 'kind']);
});

// ------------------------------------------------------------ the strict verdict

const slotOf = (overrides = {}, state = {}) => ({
    version: 1, deploymentId: DEPLOYMENT,
    state: { note_id: 7, current_balance: 120, deposit_amount: 500_000, expiry_ts: 1_900_000_000, secret: 'SECRET-NOTE-MARKER', ...state },
    journal: null, pendingDeposit: null, depositQuote: null, preparedWithdrawal: null, lease: null,
    lateWithdrawalAttempts: [], lateDepositAttempts: [], updatedAt: 5, ...overrides
});
const input = (overrides = {}) => ({
    supported: true, enabled: true,
    slot: slotOf(), withdrawals: [], deposits: [], activeLease: null, noteId: 7, balanceUnits: '120',
    deploymentId: DEPLOYMENT, quote: null, chargeCapUnits: CAP, nowSeconds: NOW, ...overrides
});
const refusedWith = (overrides, blockedBy, label = JSON.stringify(overrides)) =>
    assert.deepEqual(abandonVerdict(input(overrides)), { ok: false, blockedBy }, label);

test('abandonVerdict: a bare dust note and a bare empty note are given up, and only they', () => {
    assert.deepEqual(abandonVerdict(input()), { ok: true, kind: 'dust' });
    assert.deepEqual(abandonVerdict(input({ slot: slotOf({}, { current_balance: 0 }), balanceUnits: '0', chargeCapUnits: undefined })),
        { ok: true, kind: 'zero' });
    // Terminal late attempts hold nothing; the SDK's archive keeps them.
    assert.deepEqual(abandonVerdict(input({ slot: slotOf({
        lateWithdrawalAttempts: [{ status: 'closed' }, { status: 'detached' }, { status: 'reverted' },
            { status: 'challenged' }, { status: 'superseded' }, { status: 'quarantined' }],
        lateDepositAttempts: [{ status: 'confirmed' }, { status: 'reverted' }, { status: 'superseded' }]
    }) })), { ok: true, kind: 'dust' });
    // A slot made of the metadata a newer SDK writes is still bare.
    assert.deepEqual(abandonVerdict(input({ slot: slotOf({ exitLock: null, billingAsset: 'native_eth', stateSeq: 3, exitKitExportedSeq: 2 }) })),
        { ok: true, kind: 'dust' });
    // The verdict names only what it decided; it carries no wallet data.
    assert.deepEqual(Object.keys(abandonVerdict(input())).sort(), ['kind', 'ok']);
});

test('abandonVerdict: the note and balance shown are the note and balance held', () => {
    refusedWith({ noteId: 8 }, 'changed');
    refusedWith({ balanceUnits: '121' }, 'changed');
    refusedWith({ balanceUnits: 121 }, 'changed');
    refusedWith({ slot: slotOf({}, { current_balance: 119 }) }, 'changed');
    refusedWith({ slot: slotOf({}, { note_id: 8 }) }, 'changed');
    refusedWith({ slot: null }, 'no_note');
    refusedWith({ slot: undefined }, 'no_note');
    refusedWith({ slot: slotOf({ state: null }) }, 'no_note');
    refusedWith({ slot: { version: 1, deploymentId: DEPLOYMENT } }, 'no_note');
    refusedWith({ deploymentId: 'zkapi-another' }, 'config_mismatch');
    refusedWith({ slot: slotOf({ deploymentId: 'zkapi-another' }) }, 'config_mismatch');
    refusedWith({ deploymentId: '' }, 'config_mismatch');
    refusedWith({ deploymentId: undefined }, 'config_mismatch');
});

test('abandonVerdict: a malformed note or balance is an unknown shape, never an amount', () => {
    for (const bad of [1.5, -1, '120', NaN, Infinity, null, undefined, 2 ** 60, {}, true]) {
        refusedWith({ slot: slotOf({}, { current_balance: bad }) }, 'unknown_state', `slot balance ${String(bad)}`);
    }
    for (const bad of [1.5, -1, '7', NaN, null, undefined, {}]) {
        refusedWith({ slot: slotOf({}, { note_id: bad }) }, 'unknown_state', `slot note id ${String(bad)}`);
    }
    for (const bad of ['1.5', '-1', 'x', '', null, undefined, 1.5, -1, {}]) {
        refusedWith({ balanceUnits: bad }, 'unknown_state', `shown balance ${String(bad)}`);
    }
    for (const bad of ['7', 7.5, -1, null, undefined, NaN]) {
        refusedWith({ noteId: bad }, 'unknown_state', `shown note id ${String(bad)}`);
    }
    refusedWith({ slot: 'a slot' }, 'unknown_state');
    refusedWith({ slot: slotOf({ state: 'a note' }) }, 'unknown_state');
    refusedWith({ slot: [slotOf()] }, 'unknown_state');
    refusedWith({ withdrawals: 'none' }, 'unknown_state');
    refusedWith({ withdrawals: undefined }, 'unknown_state');
    refusedWith({ deposits: 'none' }, 'unknown_state');
});

test('abandonVerdict: everything an archive would drop or strand refuses', () => {
    refusedWith({ slot: slotOf({ journal: { phase: 'prepared' } }) }, 'in_flight');
    refusedWith({ slot: slotOf({ lease: { sessionId: 's' } }) }, 'in_flight');
    refusedWith({ activeLease: { sessionId: 's', inFlight: 0 } }, 'in_flight');
    refusedWith({ activeLease: { inFlight: 2 } }, 'in_flight');
    refusedWith({ slot: slotOf({ preparedWithdrawal: { mode: 'mutual', phase: 'prepared' } }) }, 'open_withdrawal');
    refusedWith({ slot: slotOf({ lateWithdrawalAttempts: [{ status: 'submitted' }] }) }, 'open_withdrawal');
    refusedWith({ slot: slotOf({ lateWithdrawalAttempts: [{ status: 'closed' }, { status: undefined }] }) }, 'open_withdrawal');
    refusedWith({ slot: slotOf({ lateWithdrawalAttempts: 'pending' }) }, 'open_withdrawal');
    refusedWith({ slot: slotOf({ pendingDeposit: { operationId: 'op' } }) }, 'pending_deposit');
    refusedWith({ slot: slotOf({ depositQuote: { operationId: 'quote' } }) }, 'pending_deposit');
    refusedWith({ slot: slotOf({ lateDepositAttempts: [{ status: 'submitted' }] }) }, 'pending_deposit');
    refusedWith({ slot: slotOf({ exitLock: { noteId: 7, mode: 'escape' } }) }, 'exit_lock');
    refusedWith({ slot: slotOf({ exitLock: {} }) }, 'exit_lock');
    // A field this build has never heard of: held when it carries anything,
    // and a slot with any unrecognized key is not bare even when it is empty.
    refusedWith({ slot: slotOf({ futureRecoveryField: { held: true } }) }, 'unknown_state');
    refusedWith({ slot: slotOf({ futureField: 1 }) }, 'unknown_state');
    refusedWith({ slot: slotOf({ futureField: null }) }, 'unknown_state');
    refusedWith({ slot: slotOf({ futureField: [] }) }, 'unknown_state');
});

test('abandonVerdict: other records of this deployment, a treasury claim and unresolved requests refuse', () => {
    const open = { recordId: 'r', deploymentId: DEPLOYMENT, noteId: 9, mode: 'mutual', phase: 'parked' };
    refusedWith({ withdrawals: [open] }, 'open_withdrawal');
    // A record that names no deployment, or names one that is not an id, is
    // read as this deployment's: only a different, non-empty id is "another".
    for (const unnamed of [undefined, null, '', 0, 7, {}, false]) {
        refusedWith({ withdrawals: [{ ...open, deploymentId: unnamed }] }, 'open_withdrawal', `deploymentId ${JSON.stringify(unnamed)}`);
    }
    refusedWith({ withdrawals: [{ phase: 'closed', finalizeSubmissionId: 'claim', deploymentId: DEPLOYMENT }] }, 'open_withdrawal');
    refusedWith({ withdrawals: ['garbage'] }, 'open_withdrawal');
    // A finished close and a record of another deployment hold nothing here.
    assert.equal(abandonVerdict(input({ withdrawals: [{ recordId: 'r', deploymentId: DEPLOYMENT, phase: 'closed' }] })).ok, true);
    assert.equal(abandonVerdict(input({ withdrawals: [{ ...open, deploymentId: 'zkapi-another' }] })).ok, true);
    assert.equal(abandonVerdict(input({ withdrawals: [null] })).ok, true);

    refusedWith({ claimed: true }, 'claimed');
    const claimedRow = { status: 'confirmed', noteId: 7, deploymentId: DEPLOYMENT, expiryClaim: { transactionHash: `0x${'aa'.repeat(32)}` } };
    refusedWith({ deposits: [claimedRow] }, 'claimed');
    for (const unnamed of [undefined, null, '']) {
        refusedWith({ deposits: [{ ...claimedRow, deploymentId: unnamed }] }, 'claimed', `row deploymentId ${JSON.stringify(unnamed)}`);
    }
    // The client's own report: only an absent value or exactly false is "no claim".
    for (const claimed of [true, 1, 'yes', {}, null]) refusedWith({ claimed }, 'claimed', `claimed ${JSON.stringify(claimed)}`);
    for (const none of [undefined, false]) assert.equal(abandonVerdict(input({ claimed: none })).ok, true);
    assert.equal(abandonVerdict(input({ deposits: [{ ...claimedRow, noteId: 8 }] })).ok, true, 'another note\'s claim');
    assert.equal(abandonVerdict(input({ deposits: [{ ...claimedRow, deploymentId: 'zkapi-another' }] })).ok, true);
    assert.equal(abandonVerdict(input({ deposits: [{ ...claimedRow, expiryClaim: undefined }] })).ok, true);

    refusedWith({ unresolvedRequests: 1 }, 'unresolved_request');
    refusedWith({ unresolvedRequests: [{}] }, 'unresolved_request');
    refusedWith({ unresolvedRequests: 'some' }, 'unresolved_request');
    refusedWith({ unresolvedRequests: NaN }, 'unresolved_request');
    refusedWith({ requestArchive: [{ requestId: 'r' }] }, 'unresolved_request');
    refusedWith({ requestArchive: { requestId: 'r' } }, 'unresolved_request');
    refusedWith({ requestArchive: 'archive' }, 'unresolved_request');
    // Unresolved requests: only an absent value (a protocol that keeps no
    // list), zero and an empty list are none. null, a number that is not a
    // count and every other shape are unknown and refuse.
    for (const none of [0, [], undefined]) {
        assert.equal(abandonVerdict(input({ unresolvedRequests: none })).ok, true, JSON.stringify(none));
    }
    for (const unknown of [null, -1, Infinity, '0', '', {}, true, false]) {
        refusedWith({ unresolvedRequests: unknown }, 'unresolved_request', `unresolvedRequests ${JSON.stringify(unknown)}`);
    }
    // A request archive is "none" when the protocol has no such archive
    // (undefined or null) or it is empty.
    for (const none of [[], null, undefined]) {
        assert.equal(abandonVerdict(input({ requestArchive: none })).ok, true, JSON.stringify(none));
    }
});

test('abandonVerdict: an expired but unclaimed note may be given up', () => {
    assert.equal(abandonVerdict(input({ slot: slotOf({}, { expiry_ts: 1 }) })).ok, true);
});

test('abandonVerdict fails closed on the protocol family and the operator switch', () => {
    // The family must be named as reviewed, exactly true. An omitted value, or
    // anything that is merely truthy, is not an opt-in.
    for (const supported of [undefined, null, false, 0, 1, 'true', 'yes', {}, []]) {
        refusedWith({ supported }, 'not_applicable', `supported ${JSON.stringify(supported)}`);
    }
    assert.deepEqual(abandonVerdict({ ...input(), supported: undefined }), { ok: false, blockedBy: 'not_applicable' });
    // The operator's switch is read the same way: only a stated true is on.
    // The registry's default (on) is applied by the caller that reads the
    // registry, so a caller that drops the switch is refused here.
    for (const enabled of [false, undefined, null, 0, 1, 'true', 'on', {}, []]) {
        refusedWith({ enabled }, 'disabled', `enabled ${JSON.stringify(enabled)}`);
    }
    assert.deepEqual(abandonVerdict({ ...input(), enabled: undefined }), { ok: false, blockedBy: 'disabled' });
    assert.equal(abandonVerdict(input({ enabled: true })).ok, true);
    // The family is judged before the switch and before the wallet itself.
    assert.deepEqual(abandonVerdict(input({ supported: false, enabled: false, slot: null })),
        { ok: false, blockedBy: 'not_applicable' });
});

test('the verdicts are total: always an object, never a throw, whatever they are handed', () => {
    const hostile = {
        get status() { throw new Error('getter'); },
        get slot() { throw new Error('getter'); }
    };
    for (const bad of [undefined, null, 'slot', 42, true, [], () => {}, Symbol('x'), hostile]) {
        for (const verdict of [abandonStatus(bad), abandonVerdict(bad)]) {
            assert.equal(typeof verdict, 'object');
            assert.notEqual(verdict, null);
            assert.equal(verdict.available === true || verdict.ok === true, false);
            assert.ok(ABANDON_BLOCKED_BY.includes(verdict.blockedBy), `${String(verdict.blockedBy)} is a contract code`);
        }
        assert.deepEqual(classifyBalance(bad), { kind: 'unknown', limitUnits: null });
    }
    assert.deepEqual(abandonStatus(undefined), { available: false, kind: null, blockedBy: 'not_applicable' });
    assert.deepEqual(abandonStatus(null), { available: false, kind: null, blockedBy: 'not_applicable' });
    assert.deepEqual(abandonVerdict(null), { ok: false, blockedBy: 'not_applicable' });
    // A value that throws when it is read after the switches pass is an unknown.
    const thrower = new Proxy({}, { get() { throw new Error('trap'); }, has() { throw new Error('trap'); } });
    assert.deepEqual(abandonVerdict(input({ slot: thrower })), { ok: false, blockedBy: 'unknown_state' });
    assert.deepEqual(abandonVerdict(input({ withdrawals: [thrower] })), { ok: false, blockedBy: 'unknown_state' });
    assert.equal(abandonStatus({ ...statusInput(), get hasNote() { throw new Error('getter'); } }).blockedBy, 'unknown_state');
});

test('abandonVerdict: the amount rule is the same one the status shows, evaluated on the fresh slot', () => {
    // At $3000 the line is 333,334 gwei.
    const at = balance => input({ slot: slotOf({}, { current_balance: balance }), balanceUnits: String(balance), quote: ETH_3000 });
    assert.deepEqual(abandonVerdict(at(333_333)), { ok: true, kind: 'dust' });
    assert.deepEqual(abandonVerdict(at(333_334)), { ok: false, blockedBy: 'not_dust' });
    assert.deepEqual(abandonVerdict(at(5_000_000)), { ok: false, blockedBy: 'not_dust' });
    // No price: below the cap is dust, at or above it is not guessed.
    const bare = balance => input({ slot: slotOf({}, { current_balance: balance }), balanceUnits: String(balance) });
    assert.deepEqual(abandonVerdict(bare(49_999)), { ok: true, kind: 'dust' });
    assert.deepEqual(abandonVerdict(bare(50_000)), { ok: false, blockedBy: 'price_unknown' });
    // A quote the lock-time instant has outlived is no price.
    const expired = quote('300000000000', { updatedAt: NOW - 9000, ttl: 4500 });
    assert.deepEqual(abandonVerdict({ ...at(100_000), quote: expired }), { ok: false, blockedBy: 'price_unknown' });
    // A higher ETH price between display and click: a dollar is fewer gwei, so
    // the same note is no longer dust. A lower price keeps it dust.
    assert.deepEqual(abandonVerdict({ ...at(200_000), quote: quote('1000000000000') }), { ok: false, blockedBy: 'not_dust' });
    assert.deepEqual(abandonVerdict({ ...at(200_000), quote: quote('100000000000') }), { ok: true, kind: 'dust' });
});

test('a balance given up as dust is below the ceiling for any quote, cap and threshold (property)', () => {
    const random = sequence(77);
    const pick = list => list[Math.floor(random() * list.length)];
    const big = () => String(BigInt(Math.floor(random() * 9) + 1) * 10n ** BigInt(Math.floor(random() * 19)));
    let dust = 0;
    let zero = 0;
    for (let index = 0; index < 4000; index += 1) {
        const ceilingUnits = pick([undefined, 0, 1_000, 5_000_000, 50_000_000]);
        const ceiling = ceilingUnits === undefined ? DEFAULT_DUST_CEILING_UNITS : ceilingUnits;
        const balance = pick([0, 1, 49_999, 50_000, 333_333, 333_334, 4_999_999, 5_000_000, 5_000_001, 49_999_999,
            Math.floor(random() * 1e8), Math.floor(random() * 1e15)]);
        const q = pick([null, quote(big(), { decimals: pick([0, 8, 8, 18]) }), { answer: big() }, quote('0'),
            quote(big(), { updatedAt: NOW - 9000 })]);
        const cap = pick([undefined, 0, 1, 50_000, 200_000, big()]);
        const verdict = classifyBalance({ balanceUnits: balance, chargeCapUnits: cap, quote: q,
            thresholdUsdMicros: pick([undefined, 0, 500_000, 1_000_000, 9_000_000]), ceilingUnits, nowSeconds: NOW });
        if (verdict.kind === 'zero') { assert.equal(balance, 0); zero += 1; }
        if (verdict.kind === 'dust') {
            dust += 1;
            assert.ok(BigInt(balance) < BigInt(ceiling), `${balance} is below the ceiling ${ceiling}`);
            assert.ok(BigInt(balance) < BigInt(verdict.limitUnits));
            assert.ok(BigInt(verdict.limitUnits) <= BigInt(ceiling));
            // Never above the cap unless a current quote values the smallest key higher.
            const priced = nativeUnitsForUsdMicros(1_000_000, q, NOW);
            const capUnits = BigInt(cap ?? 0);
            const bound = priced !== null && priced > capUnits ? priced : capUnits;
            assert.ok(BigInt(verdict.limitUnits) <= bound, 'the line is the cap or the priced smallest key');
        }
        if (verdict.kind === 'price_unknown') assert.equal(verdict.limitUnits, null);
    }
    assert.ok(dust > 100 && zero > 100, `the property was exercised: ${dust} dust, ${zero} zero`);
});

test('every blockedBy code of the contract is produced by the status or the verdict, and nothing else is', () => {
    const produced = new Set();
    const note = (verdict) => { if (verdict.blockedBy) produced.add(verdict.blockedBy); };
    for (const overrides of [
        { status: 'active' }, { enabled: false }, { configMismatch: true }, { reloadRequired: true }, { hasNote: false },
        { claimed: true }, { inFlight: true }, { hasOpenWithdrawal: true }, { hasPendingDeposit: true }, { lockHeld: true },
        { unresolvedRequests: 1 }, { balanceUnits: 50_000 }, { balanceUnits: 50_000, quote: quote('2500000000000') },
        { balanceUnits: 'x' }
    ]) note(abandonStatus(statusInput(overrides)));
    for (const overrides of [
        { noteId: 8 }, { slot: null }, { deploymentId: 'x' }, { slot: slotOf({ journal: { a: 1 } }) },
        { slot: slotOf({ preparedWithdrawal: { a: 1 } }) }, { slot: slotOf({ pendingDeposit: { a: 1 } }) },
        { slot: slotOf({ exitLock: { a: 1 } }) }, { claimed: true }, { unresolvedRequests: 1 },
        { slot: slotOf({ future: 1 }) }, { supported: false }, { enabled: false }
    ]) note(abandonVerdict(input(overrides)));
    for (const code of ABANDON_BLOCKED_BY) assert.ok(produced.has(code), `${code} is never produced`);
    for (const code of produced) assert.ok(ABANDON_BLOCKED_BY.includes(code), `${code} is not in the contract`);
    assert.ok(Object.isFrozen(ABANDON_BLOCKED_BY));
    assert.equal(new Set(ABANDON_BLOCKED_BY).size, ABANDON_BLOCKED_BY.length);
});

// ------------------------------------------------------------------ bare notes

test('isBareNote: held keys are exactly the note, and describeSlot cannot say that much', () => {
    const cases = [
        [slotOf(), true],
        [{ state: { note_id: 1 } }, true],
        [slotOf({ lateWithdrawalAttempts: [{ status: 'closed' }] }), true],
        [slotOf({ billingAsset: 'native_eth', stateSeq: 9, exitKitExportedSeq: 8, exitLock: null }), true],
        [slotOf({ journal: { a: 1 } }), false],
        [slotOf({ lease: { a: 1 } }), false],
        [slotOf({ exitLock: { a: 1 } }), false],
        [slotOf({ pendingDeposit: { a: 1 } }), false],
        [slotOf({ depositQuote: { a: 1 } }), false],
        [slotOf({ preparedWithdrawal: { a: 1 } }), false],
        [slotOf({ lateWithdrawalAttempts: [{ status: 'pending' }] }), false],
        [slotOf({ lateDepositAttempts: [{ status: 'submitted' }] }), false],
        [slotOf({ unknownKey: 'x' }), false],
        [slotOf({ unknownKey: null }), false],
        [slotOf({ state: null }), false],
        [{ version: 1, deploymentId: DEPLOYMENT }, false],
        [null, false], [undefined, false], ['slot', false], [[], false], [42, false]
    ];
    for (const [slot, bare] of cases) assert.equal(isBareNote(slot), bare, JSON.stringify(slot));
    // describeSlot calls every slot with a note a note, bare or not.
    assert.equal(describeSlot(slotOf()), 'note');
    assert.equal(describeSlot(slotOf({ journal: { a: 1 } })), 'note');
    assert.equal(describeSlot(slotOf({ pendingDeposit: { a: 1 } })), 'note');
});
