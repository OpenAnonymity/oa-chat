// Local-only draft: never sends the previous answer, or its later turns, to a retry.
export class MessageReplacement {
    constructor(sessionId, messageId, baseline) {
        const index = baseline.findIndex(message => message.id === messageId && message.role === 'assistant');
        if (index < 0) throw new Error('The original response is no longer available.');
        this.sessionId = sessionId;
        this.messageId = messageId;
        this.baseline = structuredClone(baseline);
        this.originalIds = new Set(baseline.map(message => message.id));
        this.retainedIds = new Set(baseline.slice(0, index).map(message => message.id));
        this.createdIds = new Set();
        this.rows = new Map(structuredClone(baseline.slice(0, index)).map(message => [message.id, message]));
    }
    messages() { return structuredClone([...this.rows.values()].sort((a, b) => a.timestamp - b.timestamp)); }
    matches(messages) { return JSON.stringify(messages) === JSON.stringify(this.baseline); }
    has(id) { return this.originalIds.has(id) || this.createdIds.has(id); }
    save(message) {
        if (message.sessionId !== this.sessionId) throw new Error('Replacement belongs to another chat.');
        // An enrichment started before regeneration can finish later. It must
        // not put the old answer or its later turns back into the retry context.
        if (this.originalIds.has(message.id) && !this.retainedIds.has(message.id)) return;
        if (!this.originalIds.has(message.id)) this.createdIds.add(message.id);
        this.rows.set(message.id, structuredClone(message));
    }
    delete(id) { this.rows.delete(id); }
}
