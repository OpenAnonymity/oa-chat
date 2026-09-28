import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFundingProgress } from '../../chat/zkapi/components/FundingProgress.js';

const defaults = { availableWei: '0', depositWei: '100', requiredFeeWei: '50', feeBufferWei: '50', renderAmount: wei => `<b>${wei} wei</b>` };
const render = props => renderFundingProgress({ ...defaults, ...props });
const percentages = html => [...html.matchAll(/style="width:([\d.]+)%"/g)].map(match => match[1]);

test('empty address shows the exact available, required and optional totals', () => {
    const html = render();
    assert.match(html, /Available at this address<\/span><strong><b>0 wei<\/b><\/strong>/);
    assert.match(html, /Required total<\/dt><dd><b>150 wei<\/b>/);
    assert.match(html, /With optional buffer<\/dt><dd><b>200 wei<\/b>/);
    assert.match(html, /data-required-covered="false"/);
    assert.match(html, /--funding-required-position:75%/);
    assert.match(html, /aria-valuenow="0"/);
    assert.match(html, /0\.00000000000000015 ETH still required/);
    assert.deepEqual(percentages(html), ['50', '0', '25', '0', '25', '0']);
    for (const label of ['Deposit', 'Network fee', 'Optional buffer', 'Required allowance']) assert.ok(html.includes(label));
    assert.match(html, /The extra buffer is optional/);
});

test('partial funding fills each category only after the preceding amount is covered', () => {
    const html = render({ availableWei: '125' });
    assert.deepEqual(percentages(html), ['50', '100', '25', '50', '25', '0']);
    assert.match(html, /data-required-covered="false"/);
    assert.match(html, /aria-valuenow="62\.5"/);
    assert.match(html, /0\.000000000000000025 ETH still required/);
});

test('bar numbers match the legend while small segments retain exact proportions', () => {
    const segmentKeys = html => [...html.matchAll(/class="zkapi-funding-progress-segment-label">(\d)<\/span>/g)].map(match => match[1]);
    assert.deepEqual(segmentKeys(render()), ['1', '2', '3']);
    const tinyDeposit = render({ depositWei: '1', requiredFeeWei: '99', feeBufferWei: '100' });
    assert.deepEqual(segmentKeys(tinyDeposit), ['2', '3']);
    assert.deepEqual(percentages(tinyDeposit), ['0.5', '0', '49.5', '0', '50', '0']);
    assert.match(tinyDeposit, /zkapi-funding-progress-key zkapi-funding-progress-deposit" aria-hidden="true">1<\/span><span>Deposit/);
    const threshold = render({ depositWei: '8', requiredFeeWei: '84', feeBufferWei: '8' });
    assert.deepEqual(segmentKeys(threshold), ['1', '2', '3']);
    assert.deepEqual(percentages(threshold), ['8', '0', '84', '0', '8', '0']);
});

test('required coverage does not wait for the optional buffer', () => {
    const html = render({ availableWei: '150' });
    assert.deepEqual(percentages(html), ['50', '100', '25', '100', '25', '0']);
    assert.match(html, /data-required-covered="true"/);
    assert.match(html, /aria-valuenow="75"/);
    assert.match(html, /Required amount covered/);
    assert.doesNotMatch(html, /still required/);
});

test('optional buffer can be partly or fully filled', () => {
    assert.deepEqual(percentages(render({ availableWei: '175' })), ['50', '100', '25', '100', '25', '50']);
    assert.deepEqual(percentages(render({ availableWei: '200' })), ['50', '100', '25', '100', '25', '100']);
});

test('excess funds remain exact while accessible and visual progress is capped', () => {
    const html = render({ availableWei: '120000000000000000001' });
    assert.match(html, /<strong><b>120000000000000000001 wei<\/b><\/strong>/);
    assert.match(html, /aria-valuenow="100"/);
    assert.match(html, /120\.000000000000000001 ETH available/);
    assert.deepEqual(percentages(html), ['50', '100', '25', '100', '25', '100']);
});

test('no buffer places the required boundary at the full target', () => {
    const html = render({ availableWei: '1', depositWei: '1', requiredFeeWei: '2', feeBufferWei: '0' });
    assert.match(html, /--funding-required-position:100%/);
    assert.match(html, /zkapi-funding-progress-required-end/);
    assert.doesNotMatch(html, /data-funding-part="buffer"/);
    assert.deepEqual(percentages(html), ['33.3333', '100', '66.6667', '0']);
    assert.match(html, /Optional buffer<\/span><\/dt>\s*<dd><b>0 wei<\/b>/);
    assert.match(html, /With optional buffer<\/dt><dd><b>3 wei<\/b>/);
    assert.doesNotMatch(render({ feeBufferWei: undefined }), /data-funding-part="buffer"/);
});

test('large network fees remain proportional and exact at sub-gwei precision', () => {
    const values = [];
    const html = render({
        availableWei: '990000000000000009', depositWei: '100000000000000001',
        requiredFeeWei: '900000000000000009', feeBufferWei: '10000000000000000',
        renderAmount: wei => { values.push(wei); return wei; }
    });
    assert.deepEqual(values, [
        '100000000000000001', '900000000000000009', '10000000000000000',
        '990000000000000009', '1000000000000000010', '1010000000000000010'
    ]);
    assert.match(html, /0\.010000000000000001 ETH still required/);
    assert.match(html, /aria-valuenow="98\.0198"/);
    assert.match(html, /data-required-covered="false"/);
    assert.doesNotMatch(html, /NaN|Infinity|e\+\d/);
});

test('one wei determines readiness even beyond Number integer precision', () => {
    const props = { depositWei: '9007199254740991001', requiredFeeWei: '999', feeBufferWei: '300' };
    assert.match(render({ ...props, availableWei: '9007199254740991999' }), /data-required-covered="false"/);
    assert.match(render({ ...props, availableWei: '9007199254740992000' }), /data-required-covered="true"/);
});

test('zero-sized categories do not produce invalid visual widths', () => {
    const html = render({ depositWei: '0', requiredFeeWei: '100', feeBufferWei: '0' });
    assert.deepEqual(percentages(html), ['100', '0']);
    assert.equal(render({ depositWei: '0', requiredFeeWei: '0', feeBufferWei: '100' }), '');
});

test('invalid amounts fail closed without calling the formatter or interpolating input', () => {
    const invalid = [undefined, null, true, 123, 123n, {}, [], '', ' ', '-1', '+1', '1.1', '1e18', '0x12', '01', '1\n', '<svg onload="alert(1)">', String(2n ** 256n), '9'.repeat(79)];
    for (const key of ['availableWei', 'depositWei', 'requiredFeeWei', 'feeBufferWei']) {
        for (const value of invalid) {
            if (key === 'feeBufferWei' && value === undefined) continue;
            let called = false;
            const html = render({ [key]: value, renderAmount: () => { called = true; return ''; } });
            assert.equal(html, '', `${key}: ${String(value)}`);
            assert.equal(called, false);
        }
    }
    assert.equal(renderFundingProgress(), '');
    assert.equal(render({ renderAmount: null }), '');
    assert.equal(render({ depositWei: String(2n ** 256n - 1n) }), '');
});
