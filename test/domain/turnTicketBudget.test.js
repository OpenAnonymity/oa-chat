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
    const sendSource = source.slice(source.indexOf('async sendMessage()'));

    assert.ok(sendSource.indexOf('preflightTurnTicketBudget(session, content)') >= 0);
    assert.ok(
        sendSource.indexOf('preflightTurnTicketBudget(session, content)')
        < sendSource.indexOf("addMessage('user'")
    );
});
