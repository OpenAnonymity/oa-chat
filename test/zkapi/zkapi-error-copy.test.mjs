import test from 'node:test';
import assert from 'node:assert/strict';
import { explainZkapiError, isIndexerLag, pendingDepositMessage, zkapiErrorMessage, INDEXER_LAG_MESSAGE } from '../../chat/zkapi/services/zkapiErrorCopy.mjs';

test('indexer lag is recognised by code or by the SDK wording, and told plainly', () => {
    const byCode = Object.assign(new Error('The zkAPI indexer is still catching up with the latest vault root. Try again in a few seconds.'), { code: 'indexer_root_lag' });
    const byText = new Error('The zkAPI indexer is still catching up with the latest vault root. Try again in a few seconds.');
    assert.ok(isIndexerLag(byCode));
    assert.ok(isIndexerLag(byText));
    assert.equal(zkapiErrorMessage(byText), INDEXER_LAG_MESSAGE);
    assert.match(INDEXER_LAG_MESSAGE, /Nothing was lost/);
    assert.match(INDEXER_LAG_MESSAGE, /within a minute/);
    assert.doesNotMatch(INDEXER_LAG_MESSAGE, /—/);

    explainZkapiError(byText);
    assert.equal(byText.message, INDEXER_LAG_MESSAGE);
    assert.equal(byText.code, 'indexer_root_lag');
});

test('other errors pass through untouched', () => {
    const error = Object.assign(new Error('insufficient funds'), { shortMessage: 'insufficient funds' });
    assert.equal(explainZkapiError(error), error);
    assert.equal(error.message, 'insufficient funds');
    assert.equal(zkapiErrorMessage(null, 'fallback'), 'fallback');
});

test('only saved, possibly submitted deposits turn a confirmation interruption into recovery copy', () => {
    const failure = Object.assign(new Error('RPC connection lost'), { broadcastPossible: true, transactionStage: 'receipt' });
    for (const phase of ['submitted', 'dropped_or_pending', 'awaiting_wallet', 'ambiguous']) {
        assert.match(pendingDepositMessage(failure, { phase }), /Check payment status before trying again/);
    }
    assert.equal(pendingDepositMessage(failure, null), null);
    assert.equal(pendingDepositMessage(failure, { phase: 'prepared' }), null);
    assert.equal(pendingDepositMessage(new Error('The mined deposit did not match this browser’s durable private note.'), { phase: 'submitted' }), null);
    assert.equal(pendingDepositMessage({ ...failure, broadcastPossible: false }, { phase: 'submitted' }), null);
    assert.equal(pendingDepositMessage({ ...failure, transactionReceipt: { status: '0x0' } }, { phase: 'submitted' }), null);
    assert.match(pendingDepositMessage(new Error('Timed out waiting for transaction 0xabc.'), { phase: 'submitted' }), /not yet confirmed/);
});
