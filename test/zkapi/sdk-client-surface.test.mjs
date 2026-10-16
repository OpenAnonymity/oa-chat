import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The withdrawal dialog quotes its network fee with zkapiClient
// .getWithdrawalFeeBudget(). Version 1's SDK gets it from a reviewed patch;
// version 2's SDK must carry it natively, or the dialog shows "Couldn't check
// fees" and Continue never enables.
test('the version 2 SDK client carries the withdrawal fee quote the dialog calls', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const client = fs.readFileSync(path.join(root, 'node_modules/zkapi-sdk-v2c/sdk/services/zkapiClient.js'), 'utf8');
    assert.match(client, /async getWithdrawalFeeBudget\(mode = 'mutual'\)/);
    const dialog = fs.readFileSync(path.join(root, 'chat/zkapi/components/WithdrawalFees.js'), 'utf8');
    assert.match(dialog, /zkapiClient\.getWithdrawalFeeBudget\(/);
});
