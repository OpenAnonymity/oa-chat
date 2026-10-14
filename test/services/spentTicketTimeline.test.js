import test from 'node:test';
import assert from 'node:assert/strict';
import { groupActivityTimeline, groupSpentTicketChecks } from '../../chat/services/activityTimeline.js';
import RightPanel from '../../chat/components/RightPanel.js';
import { getActivityDescription } from '../../chat/services/networkLogRenderer.js';

const select = (id, overrides = {}) => ({ id: `select-${id}`, timestamp: id * 1000, sessionId: 'chat-a', type: 'local', method: 'LOCAL', action: 'ticket-select', status: 200, response: { tickets_selected: 3 }, ...overrides });
const refusal = (id, overrides = {}) => ({ id: `refusal-${id}`, timestamp: id * 1000 + 1, sessionId: 'chat-a', type: 'api-key', method: 'POST', url: 'https://org.example/api/request_key', status: 401, response: { error_code: 'TICKET_ALREADY_SPENT', failed_ticket: { index: 1 } }, ...overrides });
const pair = id => [select(id), refusal(id)];

test('100 repeated select/refusal pairs become one stable row; raw records are untouched', () => {
    const raw = Array.from({ length: 100 }, (_, i) => pair(i)).flat().reverse();
    const snapshot = structuredClone(raw);
    const rows = groupActivityTimeline(raw);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'select-0');
    assert.equal(rows[0].spentTicketChecks, 100);
    assert.equal(rows[0].timestamp, 0);
    assert.equal(rows[0].lastCheckTimestamp, 99001);
    assert.equal(getActivityDescription(rows[0]), 'Used tickets · 100 checks');
    assert.match(getActivityDescription(rows[0], true), /not a count of tickets spent or removed/);
    assert.deepEqual(raw, snapshot);
    assert.deepEqual(rows[0].request, {});
});

test('successful request, pending selection, other errors and intervening activity remain visible', () => {
    const events = [
        refusal(2, { status: 200, response: {} }), refusal(2, { status: 503 }),
        refusal(2, { response: { error_code: 'INVALID_SIGNATURE' } }),
        refusal(2, { isAborted: true }), { id: 'other', type: 'openrouter', status: 200 }
    ];
    for (const event of events) {
        const raw = [...pair(1), select(2), event, ...pair(3)].reverse();
        const rows = groupSpentTicketChecks(raw).reverse();
        assert.equal(rows.length, 4);
        assert.equal(rows[0].spentTicketChecks, 1);
        assert.deepEqual(rows[1], select(2));
        assert.deepEqual(rows[2], event);
        assert.equal(rows[3].spentTicketChecks, 1);
    }
    assert.equal(groupSpentTicketChecks([...pair(1), select(2)].reverse()).length, 2);
});

test('different chats/origins and non-key paths do not merge or absorb unrelated selections', () => {
    for (const changes of [{sessionId:'chat-b'}, {url:'https://other.example/api/request_key'}]) {
        const raw = [...pair(1), select(2, { sessionId: changes.sessionId || 'chat-a' }), refusal(2, changes)].reverse();
        assert.equal(groupSpentTicketChecks(raw).length, 2);
    }
    for (const changes of [{sessionId:'chat-b'}, {url:'https://org.example/api/other'}, {method:'GET'}, {error:'failed'}]) {
        assert.equal(groupSpentTicketChecks([refusal(1, changes),select(1)]).length, 2);
    }
    assert.equal(groupSpentTicketChecks([refusal(1)]).length, 1);
});

test('legacy refusals use the existing classifier and one check uses singular copy', () => {
    const [row] = groupActivityTimeline([refusal(1, {response:{detail:'Ticket already spent'}}),select(1)]);
    assert.equal(getActivityDescription(row), 'Used tickets · 1 check');
});


test('long sweeps keep one expanded summary as the 200-entry log rolls over', () => {
    let raw = Array.from({ length: 100 }, (_, i) => pair(i)).flat().reverse();
    let rows = groupActivityTimeline(raw);
    const id = rows[0].id;
    for (let i = 100; i < 120; i++) {
        raw = [select(i), ...raw].slice(0, 200);
        rows = groupActivityTimeline(raw, rows);
        assert.equal(rows.length, 2, 'one summary plus the pending selection');
        assert.equal(rows[1].id, id);
        raw = [refusal(i), ...raw].slice(0, 200);
        rows = groupActivityTimeline(raw, rows);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, id);
        assert.equal(rows[0].spentTicketChecks, 100, 'count describes retained checks only');
    }
    const panel = Object.create(RightPanel.prototype);
    panel.escapeHtml = value => String(value);
    const details = panel.generateExpandedDetailsHTML(rows[0]);
    assert.match(details, /100 key requests were refused/);
    assert.match(details, /retained in this tab/);
    assert.doesNotMatch(details, /Status|Method|200|Response Summary/);
    const unrelated = [refusal(200), select(200), {id:'success',type:'api-key',status:200}, ...raw];
    assert.notEqual(groupActivityTimeline(unrelated, rows)[0].id, id, 'success ends the previous run');
});
