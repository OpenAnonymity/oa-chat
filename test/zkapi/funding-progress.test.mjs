import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFundingProgress } from '../../chat/zkapi/components/FundingProgress.js';

const defaults = { availableWei: '0', depositWei: '100', requiredFeeWei: '50', feeBufferWei: '50', renderAmount: wei => `<b>${wei} wei</b>` };
const render = props => renderFundingProgress({ ...defaults, ...props });
const balanceFills = html => [...html.matchAll(/class="zkapi-funding-progress-received" style="width:([\d.]+)%"/g)].map(match => match[1]);

test('empty address shows exact available and cost totals with one unfilled balance bar', () => {
    const html = render();
    assert.match(html, /Already at this address<\/span><strong><b>0 wei<\/b><\/strong>/);
    assert.match(html, /Required total<\/dt><dd><b>150 wei<\/b>/);
    assert.match(html, /Total including buffer<\/dt><dd><b>200 wei<\/b>/);
    assert.match(html, /data-required-covered="false"/);
    assert.match(html, /--funding-required-position:75%/);
    assert.match(html, /aria-valuenow="0"/);
    assert.match(html, />0% of total including buffer<\/p>/);
    assert.deepEqual(balanceFills(html), ['0']);
    for (const label of ['Deposit', 'Network fee', 'Optional buffer', 'Required allowance']) assert.ok(html.includes(label));
    assert.match(html, /The extra buffer is optional/);
});

test('leftover balance is one continuous fill rather than separate deposit or fee allocations', () => {
    const html = render({
        availableWei: '4828443948050336', depositWei: '1863593000000000',
        requiredFeeWei: '10353014106584378', feeBufferWei: '1149422918453294'
    });
    assert.match(html, /Already at this address<\/span><strong><b>4828443948050336 wei<\/b>/);
    assert.match(html, /Total including buffer<\/dt><dd><b>13366030025037672 wei<\/b>/);
    assert.deepEqual(balanceFills(html), ['36.1247']);
    assert.match(html, />36.1% of total including buffer<\/p>/);
    assert.match(html, /including any ETH left from earlier deposits/);
    assert.doesNotMatch(html, /data-funding-part|segment-label|funding-progress-key|Filled areas show funds received/);
    assert.match(html, /data-required-covered="false"/);
});

test('required boundary and optional tail are separate from the balance fill', () => {
    const html = render({ availableWei: '125' });
    assert.deepEqual(balanceFills(html), ['62.5']);
    assert.match(html, /zkapi-funding-progress-optional" style="left:75%;width:25%"/);
    assert.match(html, /zkapi-funding-progress-required-key/);
    assert.match(html, /zkapi-funding-progress-optional-key/);
    assert.match(html, /aria-valuenow="62.5"/);
    assert.match(html, /0\.000000000000000025 ETH still required/);
});

test('required coverage does not wait for the optional buffer', () => {
    const html = render({ availableWei: '150' });
    assert.deepEqual(balanceFills(html), ['75']);
    assert.match(html, /data-required-covered="true"/);
    assert.match(html, /Required amount covered/);
    assert.doesNotMatch(html, /still required/);
});

test('optional buffer can be partly or fully filled by the same balance fill', () => {
    assert.deepEqual(balanceFills(render({ availableWei: '175' })), ['87.5']);
    assert.deepEqual(balanceFills(render({ availableWei: '200' })), ['100']);
});

test('excess funds remain exact while accessible and visual progress is capped', () => {
    const html = render({ availableWei: '120000000000000000001' });
    assert.match(html, /<strong><b>120000000000000000001 wei<\/b><\/strong>/);
    assert.match(html, /aria-valuenow="100"/);
    assert.match(html, /120\.000000000000000001 ETH already at this address/);
    assert.deepEqual(balanceFills(html), ['100']);
    assert.match(html, />100% of total including buffer<\/p>/);
});

test('no buffer places the required boundary at the full target without an optional visual range', () => {
    const html = render({ availableWei: '1', depositWei: '1', requiredFeeWei: '2', feeBufferWei: '0' });
    assert.match(html, /--funding-required-position:100%/);
    assert.doesNotMatch(html, /class="zkapi-funding-progress-optional"|zkapi-funding-progress-optional-key/);
    assert.deepEqual(balanceFills(html), ['33.3333']);
    assert.match(html, /Optional buffer<\/dt>\s*<dd><b>0 wei<\/b>/);
    assert.match(html, /Total including buffer<\/dt><dd><b>3 wei<\/b>/);
    assert.doesNotMatch(render({ feeBufferWei: undefined }), /class="zkapi-funding-progress-optional"/);
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
    assert.match(html, /aria-valuenow="98.0198"/);
    assert.match(html, /data-required-covered="false"/);
    assert.doesNotMatch(html, /NaN|Infinity|e\+\d/);
});

test('one wei determines readiness even beyond Number integer precision', () => {
    const props = { depositWei: '9007199254740991001', requiredFeeWei: '999', feeBufferWei: '300' };
    assert.match(render({ ...props, availableWei: '9007199254740991999' }), /data-required-covered="false"/);
    assert.match(render({ ...props, availableWei: '9007199254740992000' }), /data-required-covered="true"/);
});

test('one wei remains visible as a nonzero balance even below percentage precision', () => {
    const html = render({ availableWei: '1', depositWei: '1000000000000000000' });
    assert.deepEqual(balanceFills(html), ['0']);
    assert.match(html, /0\.000000000000000001 ETH already at this address/);
    assert.match(html, />&lt;0.1% of total including buffer<\/p>/);
});

test('zero-sized categories do not produce invalid visual widths', () => {
    const html = render({ depositWei: '0', requiredFeeWei: '100', feeBufferWei: '0' });
    assert.deepEqual(balanceFills(html), ['0']);
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
