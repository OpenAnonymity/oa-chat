const DEFAULT_MAX_ATTACHED_IMAGES = 2;

function decodeBase64(base64Data) {
    if (typeof atob === 'function') {
        return atob(base64Data);
    }
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(base64Data, 'base64').toString('utf8');
    }
    throw new Error('No base64 decoder available.');
}

export function getMessageTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (!part) return '';
                if (typeof part.text === 'string') return part.text;
                if (typeof part.content === 'string') return part.content;
                return '';
            })
            .filter(Boolean)
            .join('');
    }
    if (content && typeof content.text === 'string') return content.text;
    return '';
}

export function isImageModel(modelId) {
    return !!modelId && /image/i.test(modelId);
}

export function processMessagesForApi(messages, currentModelId, options = {}) {
    const {
        apiOverrideContent = null,
        maxAttachedImages = DEFAULT_MAX_ATTACHED_IMAGES,
        decodeTextFile = decodeBase64,
        onTextFileDecodeError = null
    } = options;

    const filteredMessages = Array.isArray(messages)
        ? messages.filter(msg => !msg.isLocalOnly)
        : [];
    const result = [];
    const normalizedOverride = typeof apiOverrideContent === 'string' && apiOverrideContent.trim().length > 0
        ? apiOverrideContent
        : null;

    const shouldAttachImages = !isImageModel(currentModelId);
    let imagesToAttach = [];
    if (shouldAttachImages) {
        for (const msg of filteredMessages) {
            if (msg.role === 'assistant' && msg.images?.length > 0 && isImageModel(msg.model)) {
                imagesToAttach.push(...msg.images);
            }
        }
        imagesToAttach = imagesToAttach.slice(-maxAttachedImages);
    }

    const lastUserIndex = filteredMessages.map(m => m.role).lastIndexOf('user');

    for (let i = 0; i < filteredMessages.length; i += 1) {
        const msg = filteredMessages[i];
        const isLastUserMessage = i === lastUserIndex;

        if (msg.role === 'assistant') {
            result.push({
                role: 'assistant',
                content: msg.content || (msg.images?.length ? '[Generated image]' : '')
            });
            continue;
        }

        if (msg.role === 'user') {
            let textContent = msg.content || '';
            const mediaContent = [];

            if (isLastUserMessage && normalizedOverride) {
                textContent = normalizedOverride;
            }

            if (isLastUserMessage && imagesToAttach.length > 0) {
                mediaContent.push(...imagesToAttach);
            }

            if (Array.isArray(msg.files) && msg.files.length > 0) {
                msg.files.forEach(file => {
                    const isText = file.detectedType === 'text';
                    if (isText) {
                        try {
                            const base64Data = file.dataUrl.split(',')[1];
                            const decodedContent = decodeTextFile(base64Data);
                            textContent += `\n\n--- File: ${file.name} ---\n${decodedContent}`;
                        } catch (error) {
                            if (typeof onTextFileDecodeError === 'function') {
                                onTextFileDecodeError(error, file);
                            }
                            textContent += `\n\n--- File: ${file.name} ---\n[Error reading file content]`;
                        }
                    } else if ((file.type || '').startsWith('image/') || file.detectedType === 'image') {
                        mediaContent.push({
                            type: 'image_url',
                            image_url: { url: file.dataUrl }
                        });
                    } else {
                        mediaContent.push({
                            type: 'file',
                            file: { filename: file.name, file_data: file.dataUrl }
                        });
                    }
                });
            }

            if (mediaContent.length > 0) {
                result.push({
                    role: 'user',
                    content: [{ type: 'text', text: textContent }, ...mediaContent]
                });
            } else {
                result.push({ role: 'user', content: textContent });
            }
            continue;
        }

        result.push({ role: msg.role, content: msg.content });
    }

    return result;
}
