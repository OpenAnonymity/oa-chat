import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toExtensionTicketShortage } from '../../chat/extensions/extensionTicketShortage.js';

test('ticket shortage payload contains only normalized aggregate counts', () => {
    const payload = toExtensionTicketShortage({
        availableTickets: 1,
        requiredTickets: 5,
        inferenceTickets: 4,
        memoryTickets: 1,
        modelLabel: 'private-model-name',
        message: 'private UI copy',
        prompt: 'private prompt'
    });

    assert.deepEqual(payload, { availableTickets: 1, requiredTickets: 5 });
    assert.equal(Object.isFrozen(payload), true);
});

test('insufficient preflight notifies the optional shortage handler before aborting the request', () => {
    const source = fs.readFileSync('chat/app.js', 'utf8');
    const start = source.indexOf('async preflightTurnTicketBudget(');
    const end = source.indexOf('\n    async ', start + 20);
    const method = source.slice(start, end);

    assert.match(method, /await this\.notifyTicketShortage\(budget\)/);
    assert.ok(method.indexOf('notifyTicketShortage') < method.lastIndexOf('return false'));
    assert.match(source, /registerShortageHandler: handler => this\.registerTicketShortageHandler\(handler\)/);
    assert.match(source, /toExtensionTicketShortage\(budget\)/);
});

test('signed-in preflight defers shortages until account tickets are synchronized', () => {
    const source = fs.readFileSync('chat/app.js', 'utf8');
    const start = source.indexOf('async preflightTurnTicketBudget(');
    const end = source.indexOf('\n    async ', start + 20);
    const method = source.slice(start, end);
    const syncGuard = method.indexOf("accountState.ticketSyncReady !== true");
    const shortageNotification = method.indexOf('notifyTicketShortage');

    assert.ok(syncGuard >= 0);
    assert.ok(syncGuard < shortageNotification);
    assert.match(method, /Your inference tickets are still loading\. Try again shortly\./);
    assert.match(method, /Unlock your account to load your inference tickets\./);
});
