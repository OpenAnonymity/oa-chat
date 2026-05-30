export const RESPONSE_MODE_SINGLE = 'single';
export const RESPONSE_MODE_COUNCIL = 'council';

const MAX_COUNCIL_MEMBERS = 2;

export function normalizeResponseMode(mode) {
    return mode === RESPONSE_MODE_COUNCIL ? RESPONSE_MODE_COUNCIL : RESPONSE_MODE_SINGLE;
}

function normalizeModelNameValue(modelName) {
    return typeof modelName === 'string' && modelName.trim() ? modelName.trim() : null;
}

function normalizeMembers(members, fallbackModelName = null) {
    const normalized = [];
    const seen = new Set();

    const candidates = Array.isArray(members) && members.length > 0
        ? members
        : [fallbackModelName].filter(Boolean);

    for (const candidate of candidates) {
        const modelName = normalizeModelNameValue(candidate);
        if (!modelName || seen.has(modelName)) continue;
        seen.add(modelName);
        normalized.push(modelName);
        if (normalized.length >= MAX_COUNCIL_MEMBERS) break;
    }

    const fallback = normalizeModelNameValue(fallbackModelName);
    if (normalized.length === 0 && fallback) {
        normalized.push(fallback);
    }

    return normalized;
}

export function buildDefaultCouncilConfig(fallbackModelName = null) {
    const members = normalizeMembers([fallbackModelName], fallbackModelName);
    return {
        enabled: false,
        members,
        chairmanModel: members[0] || null
    };
}

export function normalizeCouncilConfig(config = {}, fallbackModelName = null) {
    const fallback = normalizeModelNameValue(fallbackModelName);
    const requestedMembers = Array.isArray(config?.members) ? config.members : [];
    const members = normalizeMembers(requestedMembers, fallback);
    const chairmanModel = normalizeModelNameValue(config?.chairmanModel)
        || members[0]
        || fallback
        || null;

    return {
        enabled: config?.enabled === true,
        members,
        chairmanModel
    };
}

export function areCouncilConfigsEqual(left, right) {
    const a = normalizeCouncilConfig(left);
    const b = normalizeCouncilConfig(right);
    return a.enabled === b.enabled
        && a.chairmanModel === b.chairmanModel
        && a.members.length === b.members.length
        && a.members.every((member, index) => member === b.members[index]);
}

export function buildCouncilMembersForSession(session, fallbackModelName = null) {
    const config = normalizeCouncilConfig(session?.councilConfig, fallbackModelName || session?.model || null);
    return config.members.slice(0, MAX_COUNCIL_MEMBERS);
}
