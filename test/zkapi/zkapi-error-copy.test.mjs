import test from 'node:test';
import assert from 'node:assert/strict';
import { explainZkapiError, isIndexerLag, zkapiErrorMessage, INDEXER_LAG_MESSAGE } from '../../chat/zkapi/services/zkapiErrorCopy.mjs';

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
