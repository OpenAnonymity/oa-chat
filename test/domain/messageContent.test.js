import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getMessageTextContent,
    isImageModel,
    processMessagesForApi
} from '../../chat/domain/messageContent.js';

test('getMessageTextContent normalizes string, array, and object content', () => {
    assert.equal(getMessageTextContent('hello'), 'hello');
    assert.equal(getMessageTextContent([{ text: 'hello' }, { content: ' world' }, { type: 'image' }]), 'hello world');
    assert.equal(getMessageTextContent({ text: 'object text' }), 'object text');
    assert.equal(getMessageTextContent(null), '');
});

test('processMessagesForApi removes local-only rows and keeps assistant image fallback text', () => {
    const result = processMessagesForApi([
        { role: 'assistant', content: 'hidden', isLocalOnly: true },
        { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ], 'openai/gpt-5.2-chat');

    assert.deepEqual(result, [
        { role: 'assistant', content: '[Generated image]' }
    ]);
});

test('processMessagesForApi attaches prior image-model outputs to the final non-image user turn', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
    const result = processMessagesForApi([
        { role: 'user', content: 'make an image' },
        { role: 'assistant', content: '', model: 'openai/image-model', images: [image] },
        { role: 'user', content: 'describe it' }
    ], 'openai/gpt-5.2-chat');

    assert.equal(result[2].role, 'user');
    assert.deepEqual(result[2].content, [
        { type: 'text', text: 'describe it' },
        image
    ]);
});

test('processMessagesForApi skips image-output attachment for image models', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
    const result = processMessagesForApi([
        { role: 'assistant', content: '', model: 'openai/image-model', images: [image] },
        { role: 'user', content: 'vary it' }
    ], 'openai/image-model');

    assert.deepEqual(result[1], { role: 'user', content: 'vary it' });
});

test('processMessagesForApi applies memory override to only the last user message', () => {
    const result = processMessagesForApi([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' }
    ], 'openai/gpt-5.2-chat', { apiOverrideContent: 'second with approved memory' });

    assert.deepEqual(result.map(message => message.content), [
        'first',
        'ok',
        'second with approved memory'
    ]);
});

test('processMessagesForApi converts uploaded text, image, and generic files', () => {
    const result = processMessagesForApi([
        {
            role: 'user',
            content: 'read these',
            files: [
                {
                    name: 'note.txt',
                    detectedType: 'text',
                    type: 'text/plain',
                    dataUrl: 'data:text/plain;base64,aGVsbG8='
                },
                {
                    name: 'photo.png',
                    detectedType: 'image',
                    type: 'image/png',
                    dataUrl: 'data:image/png;base64,abc'
                },
                {
                    name: 'paper.pdf',
                    detectedType: 'pdf',
                    type: 'application/pdf',
                    dataUrl: 'data:application/pdf;base64,xyz'
                }
            ]
        }
    ], 'openai/gpt-5.2-chat');

    assert.deepEqual(result, [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'read these\n\n--- File: note.txt ---\nhello' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
                { type: 'file', file: { filename: 'paper.pdf', file_data: 'data:application/pdf;base64,xyz' } }
            ]
        }
    ]);
});

test('isImageModel follows existing image substring policy', () => {
    assert.equal(isImageModel('openai/image-model'), true);
    assert.equal(isImageModel('openai/gpt-5.2-chat'), false);
});
