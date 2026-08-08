import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const shareServiceSource = fs.readFileSync(
    path.resolve(process.cwd(), 'chat/services/shareService.js'),
    'utf8'
);
const shareModalsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'chat/components/ShareModals.js'),
    'utf8'
);

test('share metadata and UI reflect only access that entered the payload', () => {
    assert.match(
        shareServiceSource,
        /const apiKeyShared = Boolean\(payload\.sharedAccess\)/,
        'shareInfo must derive API-key state from the actual payload'
    );
    assert.match(
        shareModalsSource,
        /this\.shareService\.hasShareableAccess\(session\)/,
        'the API-key checkbox must be hidden when access is not shareable'
    );
    assert.match(
        shareModalsSource,
        /apiKeyShared: newShareInfo\?\.apiKeyShared \|\| false/,
        'success UI must use the resulting shareInfo instead of checkbox intent'
    );
});
