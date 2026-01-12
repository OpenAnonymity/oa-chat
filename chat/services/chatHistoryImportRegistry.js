const importers = [];

function normalizeImporter(importer) {
    if (!importer || typeof importer !== 'object') {
        throw new Error('Invalid importer registration.');
    }
    if (!importer.id || !importer.label || typeof importer.canImport !== 'function' || typeof importer.parse !== 'function') {
        throw new Error('Importer must define id, label, canImport, and parse.');
    }
    return {
        ...importer,
        enabled: importer.enabled !== false,
        showInList: importer.showInList !== false,
        source: importer.source || importer.id
    };
}

export function registerChatHistoryImporter(importer) {
    const normalized = normalizeImporter(importer);
    const exists = importers.some(entry => entry.id === normalized.id);
    if (exists) {
        throw new Error(`Importer with id "${normalized.id}" already registered.`);
    }
    importers.push(normalized);
}

export function getChatHistoryImporters() {
    return [...importers];
}

function parseAcceptValue(accept) {
    if (!accept) return [];
    if (Array.isArray(accept)) {
        return accept.flatMap(item => parseAcceptValue(item));
    }
    if (typeof accept !== 'string') return [];
    return accept.split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

export function getChatHistoryImportAccept() {
    const accepts = new Set();
    importers.filter(importer => importer.enabled !== false).forEach(importer => {
        parseAcceptValue(importer.accept).forEach(value => accepts.add(value));
    });
    if (accepts.size === 0) {
        return '.json,application/json';
    }
    return Array.from(accepts).join(',');
}

async function readFileSample(file, size = 2048) {
    const slice = file.slice(0, size);
    return slice.text();
}

function formatImporterHint(importer) {
    if (importer.fileHint) return importer.fileHint;
    if (typeof importer.accept === 'string') return importer.accept;
    return importer.label;
}

function buildUnsupportedMessage() {
    const enabledImporters = importers.filter(importer => importer.enabled !== false);
    if (enabledImporters.length === 0) {
        return 'Unsupported file.';
    }
    const hints = enabledImporters.map(formatImporterHint).join(', ');
    return `Unsupported file. Supported formats: ${hints}.`;
}

export async function parseChatHistoryFile(file, options = {}) {
    if (!file) {
        throw new Error('No file provided.');
    }

    const sample = await readFileSample(file);
    const importer = importers.find(entry => entry.canImport(file, sample));
    if (!importer) {
        throw new Error(buildUnsupportedMessage());
    }
    if (importer.enabled === false) {
        throw new Error(importer.disabledReason || 'This import format is not supported yet.');
    }

    const parsed = await importer.parse(file, options);
    return {
        importer,
        parsed
    };
}

function defaultBuildSessionTitle(session) {
    const normalizedTitle = (session.title || '').trim();
    if (normalizedTitle && normalizedTitle.toLowerCase() !== 'new chat') {
        return normalizedTitle;
    }
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const firstUser = messages.find(message => message.role === 'user' && (message.hasText || (message.content && message.content.trim())))
        || messages.find(message => message.role === 'user');
    if (firstUser?.content) {
        const snippet = firstUser.content.replace(/\s+/g, ' ').trim();
        return snippet.length > 50 ? `${snippet.slice(0, 50)}...` : snippet;
    }
    return 'Imported Chat';
}

export function buildImportPlan(parsedSessions, importer = null) {
    const buildTitle = importer?.buildSessionTitle || defaultBuildSessionTitle;
    const filterSession = importer?.filterSession || ((session) =>
        Array.isArray(session.messages) &&
        session.messages.length > 0 &&
        session.messages.some(message => message.hasText || (message.content && message.content.trim()))
    );

    const sessions = (parsedSessions || [])
        .map(session => ({
            ...session,
            title: buildTitle(session)
        }))
        .filter(filterSession)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return sessions;
}
