import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(
    path.resolve(process.cwd(), 'chat/app.js'),
    'utf8'
);
const shareServiceSource = fs.readFileSync(
    path.resolve(process.cwd(), 'chat/services/shareService.js'),
    'utf8'
);
const shareModalsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'chat/components/ShareModals.js'),
    'utf8'
);

test('shared-session updates resolve access cancellation before destructive writes', () => {
    const methodStart = appSource.indexOf('async importSharedSessionWithData(');
    const methodEnd = appSource.indexOf('\n    async ', methodStart + 1);
    const methodSource = appSource.slice(
        methodStart,
        methodEnd === -1 ? appSource.length : methodEnd
    );

    const verification = methodSource.indexOf('await this.verifySharedAccess(sharedAccess)');
    const cancellation = methodSource.indexOf("verifiedAccess === 'cancel'");
    const firstDelete = methodSource.indexOf('await chatDB.deleteMessage(msg.id)');
    const firstSave = methodSource.indexOf('await chatDB.saveMessage(message)');

    assert.ok(verification >= 0, 'update import must verify shared access');
    assert.ok(cancellation > verification, 'update import must handle verification cancellation');
    assert.ok(firstDelete > cancellation, 'message deletion must happen after cancellation handling');
    assert.ok(firstSave > cancellation, 'message writes must happen after cancellation handling');
});

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
