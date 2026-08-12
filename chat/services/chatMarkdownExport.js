function getMessageText(content) {
    if (typeof content === 'string') return content;
    if (!content) return '';

    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (typeof part?.text === 'string') return part.text;
                if (typeof part?.content === 'string') return part.content;
                return '';
            })
            .filter(Boolean)
            .join('');
    }

    if (typeof content.text === 'string') return content.text;
    return '';
}

function isImageAttachment(file) {
    const mimeType = file?.type || file?.mimeType || '';
    return file?.detectedType === 'image' || mimeType.startsWith('image/');
}

function cleanPlaceholderName(name) {
    return String(name || '')
        .replace(/[\r\n\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildPlaceholder(label, name = '') {
    const cleanName = cleanPlaceholderName(name);
    return cleanName ? `[${label}: ${cleanName}]` : `[${label}]`;
}

function getContentPlaceholders(content, role) {
    if (!Array.isArray(content)) return [];

    const imageLabel = role === 'assistant' ? 'Model response image' : 'User image';
    const attachmentLabel = role === 'assistant' ? 'Model response attachment' : 'User attachment';
    return content.flatMap(part => {
        if (part?.type === 'image_url' || part?.image_url) {
            return [buildPlaceholder(imageLabel)];
        }
        if (part?.type === 'file' || part?.file) {
            return [buildPlaceholder(attachmentLabel, part.file?.filename)];
        }
        return [];
    });
}

function getMessagePlaceholders(message) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const imageLabel = role === 'assistant' ? 'Model response image' : 'User image';
    const attachmentLabel = role === 'assistant' ? 'Model response attachment' : 'User attachment';
    const placeholders = getContentPlaceholders(message?.content, role);

    if (Array.isArray(message?.files)) {
        message.files.forEach(file => {
            placeholders.push(buildPlaceholder(
                isImageAttachment(file) ? imageLabel : attachmentLabel,
                file?.name
            ));
        });
    }

    if (Array.isArray(message?.images)) {
        message.images.forEach(() => placeholders.push(buildPlaceholder(imageLabel)));
    }

    return placeholders;
}

function getRoleLabel(role) {
    if (role === 'assistant') return 'Assistant';
    if (role === 'user') return 'User';
    if (role === 'system') return 'System';
    return 'Message';
}

function cleanTitle(title) {
    return String(title || 'Untitled Chat')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || 'Untitled Chat';
}

export function buildChatMarkdown(session, messages) {
    const sections = [`# ${cleanTitle(session?.title)}`];

    (Array.isArray(messages) ? messages : []).forEach(message => {
        const content = getMessageText(message?.content).trim();
        const placeholders = getMessagePlaceholders(message);
        const body = [content, ...placeholders].filter(Boolean).join('\n\n');

        sections.push(`## ${getRoleLabel(message?.role)}\n\n${body || '[No text content]'}`);
    });

    return `${sections.join('\n\n')}\n`;
}

export function getMarkdownFilename(title) {
    const safeTitle = cleanTitle(title)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/\s*-\s*/g, '-')
        .replace(/[-. ]+$/g, '')
        .slice(0, 80);
    return `${safeTitle || 'oa-chat'}.md`;
}

export function downloadChatAsMarkdown(session, messages, options = {}) {
    const documentRef = options.documentRef || document;
    const urlRef = options.urlRef || URL;
    const BlobCtor = options.BlobCtor || Blob;
    const markdown = buildChatMarkdown(session, messages);
    const filename = getMarkdownFilename(session?.title);
    const blob = new BlobCtor([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = urlRef.createObjectURL(blob);
    const anchor = documentRef.createElement('a');

    anchor.href = url;
    anchor.download = filename;
    documentRef.body.appendChild(anchor);
    anchor.click();
    documentRef.body.removeChild(anchor);
    urlRef.revokeObjectURL(url);

    return { filename, markdown };
}
