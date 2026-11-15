import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageReplacement } from '../../chat/services/messageReplacement.js';
import { chatDB } from '../../chat/db.js';
const messages = () => [
    { id: 'u', sessionId: 's', role: 'user', content: 'Question', timestamp: 1 },
    { id: 'a', sessionId: 's', role: 'assistant', content: 'Original', timestamp: 2 },
    { id: 'u2', sessionId: 's', role: 'user', content: 'Follow-up', timestamp: 3 }
];
test('replacement draft excludes the old answer and later turns without mutating them', () => {
    const baseline = messages(), draft = new MessageReplacement('s', 'a', baseline);
    assert.deepEqual(draft.messages(), baseline.slice(0, 1));
    const candidate = { id: 'new', sessionId: 's', role: 'assistant', content: 'Partial', timestamp: 4 };
    draft.save(candidate); candidate.content = 'Later';
    const view = draft.messages(); view[0].content = 'Changed';
    assert.equal(draft.messages()[0].content, 'Question');
    assert.equal(draft.messages()[1].content, 'Partial');
    draft.delete('a'); draft.delete('new');
    assert.equal(draft.messages().length, 1);
    assert.deepEqual(baseline, messages());
    assert(draft.has('a')); assert(draft.createdIds.has('new'));
    assert.throws(() => draft.save({id:'x',sessionId:'other'}), /another chat/);
});
test('replacement rejects a vanished original and detects concurrent edit, append or deletion', () => {
    assert.throws(() => new MessageReplacement('s','missing',messages()), /no longer available/);
    const draft = new MessageReplacement('s','a',messages());
    assert(draft.matches(messages()));
    for (const changed of [messages().slice(0,2), [...messages(),{id:'extra'}], messages().map(m => m.id === 'a' ? {...m,content:'Edited'} : m)]) assert(!draft.matches(changed));
});
test('active draft writes never touch storage and aborted late writes cannot recreate a reply', async () => {
    const db = new chatDB.constructor();
    db.db = { transaction() { throw Error('Unexpected persistent write'); } };
    const draft = new MessageReplacement('s', 'a', messages()); db.messageReplacements.set('s',draft);
    await db.saveMessage({id:'new',sessionId:'s',role:'assistant',content:'Partial',timestamp:4});
    assert.equal((await db.getSessionMessages('s')).at(-1).content, 'Partial');
    await db.deleteMessage('new');
    assert.equal((await db.getSessionMessages('s')).length,1);
    db.messageReplacements.delete('s'); db.discardedReplacementIds.add('new');
    await db.saveMessage({id:'new',sessionId:'s',content:'Late enrichment'});
});

test('late original enrichment cannot reinsert discarded context', () => {
    const draft = new MessageReplacement('s', 'a', messages());
    draft.save({...messages()[1], citations:[{url:'https://example.invalid'}]});
    draft.save({...messages()[2], content:'LATE FOLLOW-UP'});
    assert.deepEqual(draft.messages(), messages().slice(0,1));
});
