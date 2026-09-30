import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFundingProgress } from '../../chat/zkapi/components/FundingProgress.js';

const defaults = { availableWei: '0', depositWei: '100', requiredFeeWei: '50', feeBufferWei: '50', renderAmount: wei => `<b>${wei} wei</b>` };
const render = props => renderFundingProgress({ ...defaults, ...props });
const balanceFills = html => [...html.matchAll(/class="zkapi-funding-progress-received" style="width:([\d.]+)%"/g)].map(match => match[1]);

test('empty address shows the parts of the total under one unfilled balance bar', () => {
    const html = render();
    assert.match(html, /Deposit<\/dt><dd><b>100 wei<\/b>/);
    assert.match(html, /Network fee<\/dt><dd><b>50 wei<\/b>/);
    assert.match(html, /Optional buffer<button [^>]*class="settings-info-button zkapi-cost-info"[^>]*><svg[\s\S]*?<\/button><\/dt><dd><b>50 wei<\/b>/);
    assert.doesNotMatch(html, /Already at this address/, 'nothing to subtract yet');
    assert.match(html, /data-required-covered="false"/);
    assert.match(html, /--funding-required-position:75%/);
    assert.match(html, /aria-valuenow="0"/);
    assert.match(html, /150 wei|0\.00000000000000015 ETH required/);
    assert.deepEqual(balanceFills(html), ['0']);
    assert.doesNotMatch(html, /% of total including buffer|Required total|Total including buffer/, 'no second list of totals');
});

test('the expected fee sits beside its allowance', () => {
    assert.match(render({ expectedFeeWei: '30' }), /Network fee<small>about <b>30 wei<\/b> expected<\/small><\/dt>/);
});

test('leftover balance is one continuous fill rather than separate deposit or fee allocations', () => {
    const html = render({
        availableWei: '4828443948050336', depositWei: '1863593000000000',
        requiredFeeWei: '10353014106584378', feeBufferWei: '1149422918453294'
    });
    assert.match(html, /Already at this address<\/dt><dd>−<b>4828443948050336 wei<\/b>/);
    assert.match(html, /0\.013366030025037672 ETH total including buffer/);
    assert.deepEqual(balanceFills(html), ['36.1247']);
    assert.match(html, /including any ETH left from earlier deposits/);
    assert.doesNotMatch(html, /data-funding-part|segment-label|funding-progress-key|Filled areas show funds received/);
    assert.match(html, /data-required-covered="false"/);
});

test('required boundary and optional tail are separate from the balance fill', () => {
    const html = render({ availableWei: '125' });
    assert.deepEqual(balanceFills(html), ['62.5']);
    assert.match(html, /zkapi-funding-progress-optional" style="left:75%;width:25%"/);
    assert.match(html, /zkapi-funding-progress-required"/);
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
    assert.match(html, /Already at this address<\/dt><dd>−<b>120000000000000000001 wei<\/b>/);
    assert.match(html, /aria-valuenow="100"/);
    assert.match(html, /120\.000000000000000001 ETH already at this address/);
    assert.deepEqual(balanceFills(html), ['100']);
});

test('no buffer places the required boundary at the full target without an optional visual range', () => {
    const html = render({ availableWei: '1', depositWei: '1', requiredFeeWei: '2', feeBufferWei: '0' });
    assert.match(html, /--funding-required-position:100%/);
    assert.doesNotMatch(html, /class="zkapi-funding-progress-optional"/);
    assert.deepEqual(balanceFills(html), ['33.3333']);
    assert.doesNotMatch(html, /Optional buffer<\/dt>/, 'a zero buffer is not listed');
    assert.match(html, /0\.000000000000000003 ETH total including buffer/);
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
        '100000000000000001', '900000000000000009', '10000000000000000', '990000000000000009'
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
    assert.match(html, /Already at this address<\/dt><dd>−<b>1 wei<\/b>/, 'one wei is still shown as present');
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
            if (key === 'availableWei' && value === null) continue;
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

test('an unknown balance keeps the costs but draws no bar and no credit', () => {
    const html = render({ availableWei: null });
    assert.match(html, /Deposit/);
    assert.match(html, /Network fee/);
    assert.doesNotMatch(html, /role="progressbar"|Already at this address/);
    assert.match(html, /data-required-covered="false"/);
});

test('the optional buffer explains itself with the Settings info button and tooltip', () => {
    const html = render();
    const button = html.match(/<button [^>]*zkapi-cost-info[^>]*>/)[0];
    assert.match(button, /aria-label="About the optional buffer"/);
    assert.match(button, /data-info-toggle/);
    assert.match(button, /aria-expanded="false"/);
    assert.match(button, /data-info-tooltip="Extra ETH in case network fees rise before your deposit goes through\. You can deposit without it\. Whatever isn’t spent stays at this address, and you can return it\."/);
    assert.doesNotMatch(render({ feeBufferWei: '0' }), /zkapi-cost-info/, 'no buffer, no button');
});
