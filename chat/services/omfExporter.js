/**
 * OMF Exporter — Exports memory as Open Memory Format (OMF) v1.0 JSON.
 *
 * Reads all memory files from the virtual filesystem, parses bullets,
 * and maps each fact to a portable OMF memory item.
 */

import memoryFileSystem from './memoryFileSystem.js';
import {
    parseMemoryBullets,
    inferTopicFromPath,
    isExpiredBullet,
    todayIsoDate,
} from './memoryBulletUtils.js';
import { saveWithConfirmation } from './globalExport.js';

const OMF_VERSION = '1.0';
const APP_NAME = 'oa-chat';

/**
 * Derive a category string from a file path.
 * "personal/about.md" → "personal"
 * "health/thyroid.md" → "health/thyroid"
 * "projects/recipe-app.md" → "projects/recipe-app"
 */
function categoryFromPath(filePath) {
    if (!filePath) return null;
    // Strip .md extension
    let cat = filePath.replace(/\.md$/i, '');
    // Strip trailing "/about" since that's a generic filename
    cat = cat.replace(/\/about$/, '');
    return cat || null;
}

/**
 * Build the OMF JSON object from all memory files.
 * @returns {Object} The OMF document
 */
export async function buildOmfExport() {
    await memoryFileSystem.init();
    const allFiles = await memoryFileSystem.exportAll();
    const today = todayIsoDate();

    const memories = [];

    for (const file of allFiles) {
        // Skip index files
        if (file.path.endsWith('_index.md')) continue;
        // Skip empty files
        if (!file.content?.trim()) continue;

        const category = categoryFromPath(file.path);
        const bullets = parseMemoryBullets(file.content);

        if (bullets.length > 0) {
            // Bullet-based file: one OMF item per bullet
            for (const bullet of bullets) {
                if (!bullet.text?.trim()) continue;

                const item = { content: bullet.text };

                if (category) item.category = category;

                // Add topic as a tag if it differs from the inferred category
                const inferredTopic = inferTopicFromPath(file.path);
                if (bullet.topic && bullet.topic !== inferredTopic) {
                    item.tags = [bullet.topic];
                }

                // Status
                if (isExpiredBullet(bullet, today)) {
                    item.status = 'expired';
                } else if (bullet.section === 'archive') {
                    item.status = 'archived';
                }
                // 'active' is the default — omit for brevity

                // Timestamps
                if (file.createdAt) {
                    item.created_at = new Date(file.createdAt).toISOString().slice(0, 10);
                }
                if (bullet.updatedAt) item.updated_at = bullet.updatedAt;
                if (bullet.expiresAt) item.expires_at = bullet.expiresAt;

                // oa-chat extensions for round-trip fidelity
                item.extensions = {
                    'oa-chat': {
                        file_path: file.path,
                        heading: bullet.heading || null,
                    },
                };

                memories.push(item);
            }
        } else {
            // Freeform / document-style file: export as a single item
            const item = { content: file.content.trim() };
            if (category) item.category = category;
            if (file.createdAt) {
                item.created_at = new Date(file.createdAt).toISOString().slice(0, 10);
            }
            if (file.updatedAt) {
                item.updated_at = new Date(file.updatedAt).toISOString().slice(0, 10);
            }
            item.extensions = {
                'oa-chat': {
                    file_path: file.path,
                    document: true,
                },
            };
            memories.push(item);
        }
    }

    return {
        omf: OMF_VERSION,
        exported_at: new Date().toISOString(),
        source: { app: APP_NAME },
        memories,
    };
}

/**
 * Export memories as an OMF JSON file download.
 * @returns {Promise<{ saved: boolean }>}
 */
export async function exportMemoriesAsOmf() {
    const omfDoc = await buildOmfExport();
    const jsonString = JSON.stringify(omfDoc, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const filename = `memories-${new Date().toISOString().replace(/[:.]/g, '-')}.omf.json`;
    return saveWithConfirmation(blob, filename);
}
