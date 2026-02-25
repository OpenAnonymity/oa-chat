/**
 * AgenticRetrieval — Read path for agentic memory.
 *
 * Before sending a message, reads the memory index and uses the LLM
 * to decide which files are relevant. Falls back to brute-force text
 * search if no Tinfoil key is available.
 */
import memoryFileSystem from './memoryFileSystem.js';
import { localInferenceService } from '../../local_inference/index.js';
import { TINFOIL_API_KEY } from '../config.js';
import ticketClient from './ticketClient.js';

const TINFOIL_BASE_URL = 'https://inference.tinfoil.sh';
const TINFOIL_BACKEND_ID = 'tinfoil';
const TINFOIL_MODEL = 'gpt-oss-120b';
const TINFOIL_KEY_TICKETS_REQUIRED = 2;
const MAX_FILES_TO_LOAD = 5;

const RETRIEVAL_PROMPT = `You are a memory retrieval system. Given a user's query and the index of their memory filesystem, decide which files (if any) contain relevant context.

Memory index:
\`\`\`
{INDEX}
\`\`\`

User query: {QUERY}

Respond with a single JSON object (no markdown fences, no extra text):
{
  "paths": ["path/to/file1.md", "path/to/file2.md"],
  "reason": "brief explanation"
}

Rules:
- Return only files listed in the index (not _index.md files themselves).
- Return an empty paths array if nothing is relevant.
- Maximum ${MAX_FILES_TO_LOAD} files.
- Only include files whose content would genuinely help answer this specific query.`;


class AgenticRetrieval {
    constructor() {
        this._tinfoilKey = null;
        this._tinfoilKeyInfo = null;
    }

    /**
     * Retrieve relevant memory context for a user query.
     * @param {string} query — the user's message text
     * @returns {Promise<{content: string, paths: string[]}|null>}
     */
    async retrieveForQuery(query) {
        if (!query || !query.trim()) return null;

        try {
            await memoryFileSystem.init();
            const index = await memoryFileSystem.getIndex();

            if (!index || await this._isTrivialIndex(index)) {
                return null;
            }

            // Try LLM-driven retrieval first
            const apiKey = await this._ensureTinfoilKey();
            let paths;

            if (apiKey) {
                paths = await this._llmRetrieval(query, index);
            } else {
                // Fallback: brute-force text search
                console.log('[AgenticRetrieval] No Tinfoil key, falling back to text search');
                paths = await this._textSearchFallback(query);
            }

            if (!paths || paths.length === 0) return null;

            // Load the selected files (budget-capped)
            const MAX_TOTAL_CHARS = 4000;
            const MAX_PER_FILE_CHARS = 1500;
            const fileContents = [];
            let total = 0;
            for (const path of paths.slice(0, MAX_FILES_TO_LOAD)) {
                const raw = await memoryFileSystem.read(path);
                if (!raw) continue;
                const content = raw.length > MAX_PER_FILE_CHARS
                    ? raw.slice(0, MAX_PER_FILE_CHARS) + '...(truncated)'
                    : raw;
                const entry = `### ${path}\n${content}`;
                if (total + entry.length > MAX_TOTAL_CHARS) break;
                fileContents.push(entry);
                total += entry.length;
            }

            if (fileContents.length === 0) return null;

            const assembled = fileContents.join('\n\n');
            console.log(`[AgenticRetrieval] Retrieved ${fileContents.length} memory files for query`);

            return { content: assembled, paths };

        } catch (error) {
            console.error('[AgenticRetrieval] Error:', error);
            if (error.message?.includes('401') || error.message?.includes('403')) {
                this._tinfoilKey = null;
                this._tinfoilKeyInfo = null;
            }
            return null;
        }
    }

    async _llmRetrieval(query, index) {
        const prompt = RETRIEVAL_PROMPT
            .replace('{INDEX}', index)
            .replace('{QUERY}', query);

        const response = await localInferenceService.createResponse({
            model: TINFOIL_MODEL,
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: prompt }
                    ]
                }
            ],
            max_output_tokens: 300,
            temperature: 0,
            stream: false
        }, { backendId: TINFOIL_BACKEND_ID });

        const responseText = this._extractOutputText(response);
        if (!responseText) return null;

        try {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            const parsed = JSON.parse(jsonMatch[0]);

            if (!Array.isArray(parsed.paths)) return null;

            console.log(`[AgenticRetrieval] LLM selected: ${parsed.paths.join(', ')} (${parsed.reason})`);
            return parsed.paths.filter(p => typeof p === 'string' && p.endsWith('.md'));
        } catch (err) {
            console.error('[AgenticRetrieval] Parse error:', err);
            return null;
        }
    }

    async _textSearchFallback(query) {
        const words = query.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
        const allPaths = new Set();

        for (const word of words) {
            const results = await memoryFileSystem.search(word);
            for (const r of results) {
                allPaths.add(r.path);
            }
        }

        return [...allPaths].slice(0, MAX_FILES_TO_LOAD);
    }

    async _isTrivialIndex(index) {
        // Check if there are any actual (non-index) files in the filesystem
        const all = await memoryFileSystem.exportAll();
        const realFiles = all.filter(f => !f.path.endsWith('_index.md'));
        return realFiles.length === 0;
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

    async _ensureTinfoilKey() {
        const envKey = TINFOIL_API_KEY;
        if (envKey) {
            localInferenceService.configureBackend(TINFOIL_BACKEND_ID, {
                baseUrl: TINFOIL_BASE_URL,
                apiKey: envKey
            });
            return envKey;
        }

        if (this._isTinfoilKeyValid()) {
            return this._tinfoilKey;
        }

        const ticketCount = ticketClient.getTicketCount();
        if (ticketCount < TINFOIL_KEY_TICKETS_REQUIRED) {
            return null;
        }

        try {
            const keyData = await ticketClient.requestConfidentialApiKey('memory-retrieval', TINFOIL_KEY_TICKETS_REQUIRED);
            this._tinfoilKey = keyData.key;
            this._tinfoilKeyInfo = keyData;

            localInferenceService.configureBackend(TINFOIL_BACKEND_ID, {
                baseUrl: TINFOIL_BASE_URL,
                apiKey: keyData.key
            });

            console.log('[AgenticRetrieval] Acquired Tinfoil key');
            return keyData.key;
        } catch (error) {
            console.warn('[AgenticRetrieval] Failed to acquire Tinfoil key:', error);
            return null;
        }
    }

    _isTinfoilKeyValid() {
        if (!this._tinfoilKey || !this._tinfoilKeyInfo) return false;
        const expiresAt = this._tinfoilKeyInfo.expiresAt || this._tinfoilKeyInfo.expires_at;
        if (!expiresAt) return false;
        const expiry = typeof expiresAt === 'number'
            ? new Date(expiresAt * 1000)
            : new Date(expiresAt);
        return expiry > new Date(Date.now() + 60000);
    }
}

const agenticRetrieval = new AgenticRetrieval();
export default agenticRetrieval;
