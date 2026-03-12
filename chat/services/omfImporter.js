/**
 * OMF Importer — Imports Open Memory Format (OMF) v1.0 JSON into the memory filesystem.
 *
 * Supports two modes:
 * - Preview: dry-run returning counts without writing
 * - Import: merges memories into existing files with deduplication
 */

import memoryFileSystem from './memoryFileSystem.js';
import {
    parseMemoryBullets,
    ensureBulletMetadata,
    compactBullets,
    renderCompactedMemoryDocument,
    todayIsoDate,
    normalizeFactText,
} from './memoryBulletUtils.js';
import memoryBulletIndex from './memoryBulletIndex.js';

const SUPPORTED_VERSIONS = ['1.0'];

/**
 * Validate an OMF document structure.
 * @param {Object} doc - Parsed JSON
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateOmf(doc) {
    if (!doc || typeof doc !== 'object') {
        return { valid: false, error: 'Not a valid JSON object' };
    }
    if (!doc.omf) {
        return { valid: false, error: 'Missing "omf" version field. Is this an OMF file?' };
    }
    if (!SUPPORTED_VERSIONS.includes(doc.omf)) {
        return { valid: false, error: `Unsupported OMF version "${doc.omf}". Supported: ${SUPPORTED_VERSIONS.join(', ')}` };
    }
    if (!Array.isArray(doc.memories)) {
        return { valid: false, error: 'Missing or invalid "memories" array' };
    }
    for (let i = 0; i < doc.memories.length; i++) {
        const m = doc.memories[i];
        if (!m || typeof m !== 'object') {
            return { valid: false, error: `Memory item at index ${i} is not an object` };
        }
        if (!m.content || typeof m.content !== 'string' || !m.content.trim()) {
            return { valid: false, error: `Memory item at index ${i} has empty or missing "content"` };
        }
    }
    return { valid: true };
}

/**
 * Derive the target file path for an OMF memory item.
 * Uses oa-chat extension for round-trips, otherwise maps category to path.
 */
function targetPathForItem(item) {
    // Round-trip: use exact file_path from oa-chat extensions
    const oaChatExt = item.extensions?.['oa-chat'];
    if (oaChatExt?.file_path) {
        return oaChatExt.file_path;
    }

    // Map category to file path
    if (item.category) {
        const cat = item.category.replace(/^\/+|\/+$/g, '').trim();
        if (cat) {
            // If category already looks like a file path (has segments), use it
            if (cat.includes('/')) {
                return cat + '.md';
            }
            return cat + '/about.md';
        }
    }

    // Default bucket for uncategorized items
    return 'personal/imported.md';
}

/**
 * Check if a memory item is a document (long-form content, not a single fact).
 */
function isDocumentItem(item) {
    const ext = item.extensions?.['oa-chat'];
    if (ext?.document) return true;
    // Heuristic: long content with multiple lines
    return item.content.length > 500 && item.content.includes('\n');
}

/**
 * Map OMF status to bullet section.
 */
function statusToSection(status) {
    if (status === 'archived' || status === 'expired') return 'archive';
    return 'active';
}

/**
 * Preview an OMF import without writing anything.
 * @param {Object} doc - Validated OMF document
 * @param {{ includeArchived?: boolean }} options
 * @returns {Promise<{ total: number, toImport: number, duplicates: number, newFiles: number, existingFiles: number, byFile: Object }>}
 */
export async function previewOmfImport(doc, options = {}) {
    const { includeArchived = true } = options;
    await memoryFileSystem.init();

    let total = doc.memories.length;
    let filtered = 0;
    let duplicates = 0;
    const byFile = {};

    for (const item of doc.memories) {
        // Filter archived/expired if requested
        if (!includeArchived && (item.status === 'archived' || item.status === 'expired')) {
            filtered++;
            continue;
        }

        // Skip document items for dedup counting (they write as-is)
        if (isDocumentItem(item)) {
            const path = targetPathForItem(item);
            byFile[path] = byFile[path] || { new: 0, duplicate: 0, document: true };
            byFile[path].new++;
            continue;
        }

        const path = targetPathForItem(item);
        byFile[path] = byFile[path] || { new: 0, duplicate: 0 };

        // Check for duplicates against existing content
        const existing = await memoryFileSystem.read(path);
        if (existing) {
            const existingBullets = parseMemoryBullets(existing);
            const normalizedNew = normalizeFactText(item.content);
            const isDuplicate = existingBullets.some(
                b => normalizeFactText(b.text) === normalizedNew
            );
            if (isDuplicate) {
                duplicates++;
                byFile[path].duplicate++;
            } else {
                byFile[path].new++;
            }
        } else {
            byFile[path].new++;
        }
    }

    const toImport = total - filtered - duplicates;
    const existingFiles = new Set();
    const newFiles = new Set();
    for (const path of Object.keys(byFile)) {
        if (await memoryFileSystem.exists(path)) {
            existingFiles.add(path);
        } else {
            newFiles.add(path);
        }
    }

    return {
        total,
        filtered,
        toImport,
        duplicates,
        newFiles: newFiles.size,
        existingFiles: existingFiles.size,
        byFile,
    };
}

/**
 * Import an OMF document into the memory filesystem.
 * @param {Object} doc - Validated OMF document
 * @param {{ includeArchived?: boolean }} options
 * @returns {Promise<{ total: number, imported: number, duplicates: number, skipped: number, filesWritten: number, errors: string[] }>}
 */
export async function importOmf(doc, options = {}) {
    const { includeArchived = true } = options;
    await memoryFileSystem.init();
    const today = todayIsoDate();

    const errors = [];
    let skipped = 0;

    // Group items by target file path
    const groups = new Map();

    for (const item of doc.memories) {
        // Filter archived/expired if requested
        if (!includeArchived && (item.status === 'archived' || item.status === 'expired')) {
            skipped++;
            continue;
        }

        const path = targetPathForItem(item);
        if (!groups.has(path)) groups.set(path, []);
        groups.get(path).push(item);
    }

    let imported = 0;
    let duplicates = 0;
    let filesWritten = 0;

    for (const [path, items] of groups.entries()) {
        try {
            // Check if any item is a document-style
            const docItems = items.filter(isDocumentItem);
            const bulletItems = items.filter(i => !isDocumentItem(i));

            if (docItems.length > 0 && bulletItems.length === 0) {
                // Pure document write — use last document item
                const docItem = docItems[docItems.length - 1];
                await memoryFileSystem.write(path, docItem.content);
                imported += docItems.length;
                filesWritten++;
                await memoryBulletIndex.refreshPath(path);
                continue;
            }

            // Bullet-based merge
            const existing = await memoryFileSystem.read(path);
            const existingBullets = existing ? parseMemoryBullets(existing) : [];

            // Convert OMF items to bullet objects
            const incomingBullets = bulletItems.map(item => {
                const topic = item.tags?.[0] || null;
                return ensureBulletMetadata({
                    text: item.content,
                    topic,
                    updatedAt: item.updated_at || today,
                    expiresAt: item.expires_at || null,
                    section: statusToSection(item.status),
                }, { updatedAt: today });
            });

            // Count duplicates before compaction
            const existingNormalized = new Set(
                existingBullets.map(b => normalizeFactText(b.text))
            );
            let itemDupes = 0;
            for (const b of incomingBullets) {
                if (existingNormalized.has(normalizeFactText(b.text))) {
                    itemDupes++;
                }
            }
            duplicates += itemDupes;

            // Compact (deduplicates and merges)
            const allBullets = [...existingBullets, ...incomingBullets];
            const { active, archive } = compactBullets(allBullets, { today });
            const markdown = renderCompactedMemoryDocument(active, archive);

            await memoryFileSystem.write(path, markdown);
            imported += bulletItems.length - itemDupes;
            filesWritten++;

            // Also count any document items in this mixed group
            if (docItems.length > 0) {
                imported += docItems.length;
            }

            await memoryBulletIndex.refreshPath(path);
        } catch (err) {
            errors.push(`Error writing ${path}: ${err.message}`);
            console.warn('[OMF Import] Error processing file:', path, err);
        }
    }

    return {
        total: doc.memories.length,
        imported,
        duplicates,
        skipped,
        filesWritten,
        errors,
    };
}

/**
 * Read and parse a JSON file from a File object.
 * @param {File} file
 * @returns {Promise<Object>}
 */
export async function readOmfFile(file) {
    const text = await file.text();
    return JSON.parse(text);
}
