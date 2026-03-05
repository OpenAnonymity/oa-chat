/**
 * Helpers for metadata-rich memory bullets.
 * Bullet format:
 * - Fact text | topic=foo | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD
 */

const BULLET_REGEX = /^\s*-\s+(.*)$/;
const HEADING_REGEX = /^\s{0,3}#{1,6}\s+(.*)$/;

function safeDateIso(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

export function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
}

export function inferTopicFromPath(path) {
    if (!path || typeof path !== 'string') return 'general';
    const first = path.split('/')[0]?.trim().toLowerCase();
    return first || 'general';
}

export function normalizeTopic(value, fallback = 'general') {
    const source = String(value || '').trim().toLowerCase();
    const normalized = source
        .replace(/[^a-z0-9/_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-/]+|[-/]+$/g, '');
    return normalized || fallback;
}

export function normalizeFactText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function parseMemoryBullets(content) {
    const lines = String(content || '').split('\n');
    const bullets = [];
    let currentHeading = 'General';
    let section = 'active';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = line.match(HEADING_REGEX);
        if (headingMatch) {
            currentHeading = headingMatch[1].trim() || currentHeading;
            if (/archive/i.test(currentHeading)) {
                section = 'archive';
            } else if (/active/i.test(currentHeading)) {
                section = 'active';
            }
            continue;
        }

        const bulletMatch = line.match(BULLET_REGEX);
        if (!bulletMatch) continue;

        const raw = bulletMatch[1].trim();
        const parts = raw.split('|').map((part) => part.trim()).filter(Boolean);
        if (parts.length === 0) continue;

        const text = parts.shift() || '';
        let topic = null;
        let updatedAt = null;
        let expiresAt = null;

        for (const part of parts) {
            const kv = part.match(/^([a-z_]+)\s*=\s*(.+)$/i);
            if (!kv) continue;
            const key = kv[1].toLowerCase();
            const value = kv[2].trim();
            if (key === 'topic') topic = value;
            if (key === 'updated_at') updatedAt = safeDateIso(value);
            if (key === 'expires_at') expiresAt = safeDateIso(value);
        }

        bullets.push({
            text,
            topic: topic ? normalizeTopic(topic) : null,
            updatedAt,
            expiresAt,
            heading: currentHeading,
            section,
            lineIndex: i
        });
    }

    return bullets;
}

export function ensureBulletMetadata(bullet, options = {}) {
    const fallbackTopic = normalizeTopic(options.defaultTopic || 'general');
    const fallbackUpdatedAt = options.updatedAt || todayIsoDate();
    return {
        text: String(bullet?.text || '').trim(),
        topic: normalizeTopic(bullet?.topic || fallbackTopic, fallbackTopic),
        updatedAt: safeDateIso(bullet?.updatedAt) || fallbackUpdatedAt,
        expiresAt: safeDateIso(bullet?.expiresAt),
        section: bullet?.section === 'archive' ? 'archive' : 'active'
    };
}

export function renderMemoryBullet(bullet) {
    const clean = ensureBulletMetadata(bullet);
    const metadata = [
        `topic=${clean.topic}`,
        `updated_at=${clean.updatedAt}`
    ];
    if (clean.expiresAt) metadata.push(`expires_at=${clean.expiresAt}`);
    return `- ${clean.text} | ${metadata.join(' | ')}`;
}

export function scoreMemoryBullet(bullet, queryTerms = []) {
    const text = String(bullet?.text || '').toLowerCase();
    const topic = String(bullet?.topic || '').toLowerCase();
    if (!text) return 0;

    let score = 0;
    for (const term of queryTerms) {
        if (!term) continue;
        if (text.includes(term)) score += 2;
        if (topic.includes(term)) score += 1;
    }
    return score;
}

export function tokenizeQuery(query) {
    return String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3);
}

export function isExpiredBullet(bullet, today = todayIsoDate()) {
    if (!bullet?.expiresAt) return false;
    return String(bullet.expiresAt) < String(today);
}

export function compactBullets(bullets, options = {}) {
    const today = options.today || todayIsoDate();
    const maxActivePerTopic = Number.isFinite(options.maxActivePerTopic)
        ? Math.max(1, options.maxActivePerTopic)
        : 24;
    const defaultTopic = normalizeTopic(options.defaultTopic || 'general');

    // Deduplicate by normalized fact text; keep newest by updatedAt.
    const dedup = new Map();
    for (const original of bullets) {
        const normalized = ensureBulletMetadata(original, { defaultTopic, updatedAt: today });
        const key = normalizeFactText(normalized.text);
        if (!key) continue;

        const existing = dedup.get(key);
        if (!existing) {
            dedup.set(key, normalized);
            continue;
        }

        const existingDate = existing.updatedAt || '0000-00-00';
        const incomingDate = normalized.updatedAt || '0000-00-00';
        if (incomingDate >= existingDate) {
            dedup.set(key, normalized);
        }
    }

    const active = [];
    const archive = [];

    const byTopic = new Map();
    for (const bullet of dedup.values()) {
        if (bullet.section === 'archive' || isExpiredBullet(bullet, today)) {
            archive.push(bullet);
            continue;
        }
        const topic = bullet.topic || defaultTopic;
        const list = byTopic.get(topic) || [];
        list.push(bullet);
        byTopic.set(topic, list);
    }

    for (const [topic, list] of byTopic.entries()) {
        list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        const keep = list.slice(0, maxActivePerTopic);
        const extra = list.slice(maxActivePerTopic);
        keep.forEach((item) => active.push({ ...item, topic }));
        extra.forEach((item) => archive.push({ ...item, topic }));
    }

    archive.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    active.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    return { active, archive };
}

function topicHeading(topic) {
    const clean = String(topic || 'general').trim();
    if (!clean) return 'General';
    return clean
        .split(/[\/_-]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export function renderCompactedMemoryDocument(active, archive) {
    const lines = [];
    lines.push('## Active');

    if (!active || active.length === 0) {
        lines.push('_No active facts yet._');
    } else {
        const byTopic = new Map();
        for (const bullet of active) {
            const topic = bullet.topic || 'general';
            const list = byTopic.get(topic) || [];
            list.push(bullet);
            byTopic.set(topic, list);
        }

        for (const topic of [...byTopic.keys()].sort()) {
            lines.push('');
            lines.push(`### ${topicHeading(topic)}`);
            for (const bullet of byTopic.get(topic)) {
                lines.push(renderMemoryBullet(bullet));
            }
        }
    }

    if (archive && archive.length > 0) {
        lines.push('');
        lines.push('## Archive');
        const byTopic = new Map();
        for (const bullet of archive) {
            const topic = bullet.topic || 'general';
            const list = byTopic.get(topic) || [];
            list.push(bullet);
            byTopic.set(topic, list);
        }

        for (const topic of [...byTopic.keys()].sort()) {
            lines.push('');
            lines.push(`### ${topicHeading(topic)}`);
            for (const bullet of byTopic.get(topic)) {
                lines.push(renderMemoryBullet({ ...bullet, section: 'archive' }));
            }
        }
    }

    return lines.join('\n').trim();
}
