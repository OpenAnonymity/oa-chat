import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTokenAmount as sdkParse } from '@openanonymity/zkapi-browser-sdk/wallet';
import { parseTokenAmount } from '../../chat/zkapi/services/tokenAmount.mjs';

// The host owns this function because the revision 3 SDK removed it. It must
// behave exactly like the installed SDK's, including on bad input.

function outcome(fn, input) {
    try {
        return { value: fn(input) };
    } catch (error) {
        return { name: error?.name, message: error?.message };
    }
}

const PARSE_INPUTS = [
    '0', '1', '1.5', '1.500000', '0.000001', '0.0000001', '123456789.123456', '  2  ', '\t3\n', '2.', '.5', '1.1234567',
    '-1', '+1', '1e3', '0x10', '', ' ', 'abc', '1,5', '1 5', '00012.50', '9007199254740993', '99999999999999999999.999999',
    '1.0000001', '١', '１', 0, 1, 1.5, -1, 10n, null, undefined, {}, [], ['1.5'], true
];

test('parseTokenAmount matches the installed SDK for valid and invalid input', () => {
    for (const input of PARSE_INPUTS) {
        assert.deepEqual(outcome(parseTokenAmount, input), outcome(sdkParse, input), `parse(${String(input)})`);
    }
});

test('amounts have six decimals', () => {
    assert.equal(parseTokenAmount('1'), 1_000_000n);
    assert.equal(parseTokenAmount('0.000001'), 1n);
    assert.equal(parseTokenAmount('2.5'), 2_500_000n);
    assert.equal(parseTokenAmount('1234567.890123'), 1_234_567_890_123n);
    assert.throws(() => parseTokenAmount('1.1234567'), /no more than six decimal places/);
    assert.throws(() => parseTokenAmount('-1'), /Enter a positive amount/);
});
