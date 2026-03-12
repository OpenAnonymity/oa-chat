import memoryFileSystem from './memoryFileSystem.js';
import { localInferenceService } from '../../local_inference/index.js';
import { ensureConfidentialKey, invalidateConfidentialKey } from './confidentialKeyService.js';
import memoryBulletIndex from './memoryBulletIndex.js';

const COMPACT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TINFOIL_BACKEND_ID = 'tinfoil';
const TINFOIL_MODEL = 'kimi-k2-5';
const MAX_FILE_CHARS = 8000;

const COMPACTION_PROMPT = `You are compacting a markdown memory file into a stable long-term format.

Input is one memory file. Rewrite it into:

## Active
### <Topic>
- fact | topic=<topic> | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD(optional)

## Archive
### <Topic>
- fact | topic=<topic> | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD(optional)

Rules:
- Keep only concrete reusable facts.
- Merge semantic duplicates and keep the most recent/best phrasing.
- Resolve contradictions by keeping the most recently updated fact; older conflicting facts go to Archive.
- Expired facts (expires_at in the past) go to Archive.
- Keep Active concise. Move stale/low-priority/older overflow facts to Archive.
- Preserve meaning; do not invent facts.
- Output markdown only (no fences, no explanations).

Today: {TODAY}
Path: {PATH}

File content:
\`\`\`
{CONTENT}
\`\`\``;

class MemoryCompactor {
    constructor() {
        this._lastRunAt = 0;
        this._running = false;
    }

    async maybeCompact() {
        if (this._running) return;
        const now = Date.now();
        if (now - this._lastRunAt < COMPACT_INTERVAL_MS) return;
        await this.compactAll();
    }

    async compactAll() {
        if (this._running) return;
        this._running = true;
        try {
            await memoryFileSystem.init();
            const allFiles = await memoryFileSystem.exportAll();
            const realFiles = allFiles.filter((file) => !file.path.endsWith('_index.md'));
            let changed = 0;

            for (const file of realFiles) {
                const compacted = await this._compactFileWithLlm(file.path, file.content || '');
                if (!compacted) continue;
                const original = String(file.content || '').trim();
                if (compacted.trim() === original) continue;
                await memoryFileSystem.write(file.path, compacted);
                await memoryBulletIndex.refreshPath(file.path);
                changed += 1;
            }

            this._lastRunAt = Date.now();
            if (changed > 0) {
                console.log(`[MemoryCompactor] Compacted ${changed} memory files`);
            }
        } catch (error) {
            console.warn('[MemoryCompactor] Compaction failed:', error);
            if (error.message?.includes('401') || error.message?.includes('403')) {
                invalidateConfidentialKey();
            }
        } finally {
            this._running = false;
        }
    }

    async _compactFileWithLlm(path, content) {
        const raw = String(content || '').trim();
        if (!raw) return null;

        const apiKey = await ensureConfidentialKey('memory-compaction');
        if (!apiKey) {
            throw new Error('No confidential model key available for memory compaction');
        }

        const prompt = COMPACTION_PROMPT
            .replace('{TODAY}', new Date().toISOString().slice(0, 10))
            .replace('{PATH}', path)
            .replace('{CONTENT}', raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(truncated)' : raw);

        const response = await localInferenceService.createResponse({
            model: TINFOIL_MODEL,
            input: [
                {
                    role: 'user',
                    content: [{ type: 'input_text', text: prompt }]
                }
            ],
            max_output_tokens: 1800,
            temperature: 0,
            stream: false
        }, { backendId: TINFOIL_BACKEND_ID });

        const text = this._extractOutputText(response).trim();
        if (!text) return null;
        return text;
    }

    _extractOutputText(response) {
        if (!response) return '';
        if (typeof response.output_text === 'string') return response.output_text;
        const output = Array.isArray(response.output) ? response.output : [];
        for (const item of output) {
            const content = Array.isArray(item?.content) ? item.content : [];
            for (const part of content) {
                if (part?.type === 'output_text' && typeof part.text === 'string') {
                    return part.text;
                }
            }
        }
        return '';
    }

}

const memoryCompactor = new MemoryCompactor();
export default memoryCompactor;
