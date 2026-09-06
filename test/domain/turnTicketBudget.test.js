import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildTurnTicketBudget } from '../../chat/domain/turnTicketBudget.js';

test('memory and model costs are reported together before either spends', () => {
    const budget = buildTurnTicketBudget({
        availableTickets: 1,
        inferenceTickets: 1,
        memoryTickets: 1,
        modelLabel: 'Gemini Flash'
    });

    assert.equal(budget.sufficient, false);
    assert.equal(budget.requiredTickets, 2);
    assert.equal(
        budget.message,
        'Memory is on: this request needs 2 tickets (1 for Memory and 1 for Gemini Flash). You have 1.'
    );
});

test('a valid memory key does not add a new memory ticket requirement', () => {
    const budget = buildTurnTicketBudget({
        availableTickets: 1,
        inferenceTickets: 1,
        memoryTickets: 0,
        modelLabel: 'Gemini Flash'
    });

    assert.equal(budget.sufficient, true);
    assert.equal(budget.requiredTickets, 1);
    assert.equal(budget.message, '');
});

test('send preflights the combined budget before adding the user message', () => {
    const source = fs.readFileSync('chat/app.js', 'utf8');
    const start = source.indexOf('async sendCapturedMessage(');
    assert.ok(start >= 0, 'the captured send implementation must exist');
    const sendSource = source.slice(start, source.indexOf('\n    async ', start + 20));

    assert.ok(sendSource.indexOf('preflightTurnTicketBudget(session, content,') >= 0);
    assert.ok(
        sendSource.indexOf('preflightTurnTicketBudget(session, content,')
        < sendSource.indexOf("addMessage('user'")
    );
});

test('Parallel lane regeneration preflights Memory with only that lane', () => {
    const source = fs.readFileSync('chat/app.js', 'utf8');
    const start = source.indexOf('async regenerateCouncilLane(');
    const end = source.indexOf('\n    async ', start + 20);
    const method = source.slice(start, end);
    assert.match(method, /preflightTurnTicketBudget\(session, regenerationContent, \{\s*councilStageEntry: stageEntry/);
    assert.ok(
        method.indexOf('preflightTurnTicketBudget') < method.indexOf('messagesToDelete'),
        'preflight must run before later messages are deleted'
    );
});

test('pricing readiness failures block the turn with actionable UI and preserve unexpected errors', () => {
    const source = fs.readFileSync('chat/app.js', 'utf8');
    const start = source.indexOf('async preflightTurnTicketBudget(');
    const end = source.indexOf('\n    async ', start + 20);
    const method = source.slice(start, end);

    assert.match(method, /error\?\.code !== 'MODEL_TIER_CONFIG_UNAVAILABLE'\) throw error/);
    assert.match(method, /Ticket pricing is temporarily unavailable\. Please try again\./);
    assert.match(method, /this\.showToast\(message, 'error', 7000\)/);
    assert.match(method, /this\.floatingPanel\?\.showMessage\?\.\(message, 'error', 7000\)/);
});
