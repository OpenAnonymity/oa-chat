/**
 * AgenticRetrieval — Read path for agentic memory.
 *
 * Uses tool-calling via the agentic loop to let the LLM search, read,
 * and assemble relevant memory context. Falls back to brute-force text
 * search if no confidential model key is available.
 */
import memoryFileSystem from './memoryFileSystem.js';
import { runAgenticToolLoop } from './agenticToolLoop.js';
import { createRetrievalExecutors } from './memoryStorageBackend.js';
import {
    normalizeFactText,
    parseMemoryBullets,
    renderMemoryBullet,
    scoreMemoryBullet,
    tokenizeQuery
} from './memoryBulletUtils.js';
import memoryBulletIndex from './memoryBulletIndex.js';
import { ensureConfidentialKey, invalidateConfidentialKey } from './confidentialKeyService.js';

const TINFOIL_BACKEND_ID = 'tinfoil';
const TINFOIL_MODEL = 'kimi-k2-5';
const MAX_FILES_TO_LOAD = 5;
const MAX_TOTAL_CONTEXT_CHARS = 4000;
const MAX_SNIPPETS = 18;

const RETRIEVAL_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'retrieve_file',
            description: 'Search memory files by keyword. Returns paths of files whose content or path matches the query. Use read_file instead if you already know the file path.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keyword to search for in file contents (e.g. "cooking", "Stanford", "project")' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the content of a memory file by its path.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read (e.g. personal/about.md)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'append_mem_to_query',
            description: 'Assemble the final memory context to attach to the user query. Call this when done selecting and reading files. The content you provide will be used as context for answering the user message.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'The assembled memory context to attach to the query. Include relevant excerpts from the files you read.' }
                },
                required: ['content']
            }
        }
    }
];

const RETRIEVAL_SYSTEM_PROMPT = `You are a memory retrieval assistant. Your job is to find and assemble relevant personal context from the user's memory files to help answer their query.

You have access to a memory filesystem. The index below shows all available files:

\`\`\`
{INDEX}
\`\`\`

Instructions:
1. Look at the index above. If you can already see relevant file paths, use read_file directly to read them.
2. Use retrieve_file only when you need to search by keyword (e.g. "cooking", "Stanford") — it searches file contents, not paths.
3. Read at most ${MAX_FILES_TO_LOAD} files.
4. When you've found relevant context, call append_mem_to_query with curated excerpts.
5. If nothing is relevant, call append_mem_to_query with an empty string.

Be selective — only include content that genuinely helps answer this specific query. Do not include everything you find.`;


class AgenticRetrieval {
    constructor() {
    }

    /**
     * Retrieve relevant memory context for a user query.
     * @param {string} query — the user's message text
     * @param {Function} [onProgress]
     * @param {Object} [options]
     * @param {string} [options.conversationText] — current session text to filter out redundant facts
     * @returns {Promise<{files: {path: string, content: string}[], paths: string[], assembledContext: string|null}|null>}
     */
    async retrieveForQuery(query, onProgress = null, options = {}) {
        if (!query || !query.trim()) return null;

        const conversationText = options.conversationText || null;
        const onModelText = options.onModelText || null;

        try {
            onProgress?.({ stage: 'init', message: 'Reading memory index...' });
            await memoryFileSystem.init();
            const index = await memoryFileSystem.getIndex();

            if (!index || await this._isTrivialIndex(index)) {
                return null;
            }

            // Try LLM-driven retrieval first
            const apiKey = await ensureConfidentialKey('memory-retrieval');

            let result;
            if (apiKey) {
                onProgress?.({ stage: 'retrieval', message: 'Selecting relevant memory files with confidential model...' });
                result = await this._toolCallingRetrieval(query, index, onProgress, conversationText, onModelText);
            } else {
                // Fallback: brute-force text search
                console.log('[AgenticRetrieval] No confidential model key, falling back to text search');
                onProgress?.({ stage: 'retrieval', message: 'Confidential model unavailable, using fallback text search...' });
                result = await this._textSearchFallbackWithLoad(query, onProgress, conversationText);
            }

            // Post-filter assembled context to remove facts already in the conversation
            if (result?.assembledContext && conversationText) {
                result.assembledContext = this._filterRedundantContext(result.assembledContext, conversationText);
            }

            return result;

        } catch (error) {
            console.error('[AgenticRetrieval] Error:', error);
            if (error.message?.includes('401') || error.message?.includes('403')) {
                invalidateConfidentialKey();
            }
            return null;
        }
    }

    async _toolCallingRetrieval(query, index, onProgress, conversationText, onModelText) {
        const systemPrompt = RETRIEVAL_SYSTEM_PROMPT.replace('{INDEX}', index);
        const toolExecutors = createRetrievalExecutors(memoryFileSystem);

        const { terminalToolResult, toolCallLog, iterations } = await runAgenticToolLoop({
            model: TINFOIL_MODEL,
            backendId: TINFOIL_BACKEND_ID,
            tools: RETRIEVAL_TOOLS,
            toolExecutors,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query }
            ],
            terminalTool: 'append_mem_to_query',
            maxIterations: 8,
            maxOutputTokens: 500,
            temperature: 0,
            onToolCall: (name, args, result) => {
                onProgress?.({ stage: 'tool_call', message: `Tool: ${name}`, tool: name, args, result });
            },
            onModelText
        });

        console.log(`[AgenticRetrieval] Completed in ${iterations} iterations, ${toolCallLog.length} tool calls`);

        // Build files list from read_file calls in the log
        const files = [];
        const seenPaths = new Set();
        for (const entry of toolCallLog) {
            if (entry.name === 'read_file' && entry.args?.path && entry.result) {
                const path = entry.args.path;
                if (seenPaths.has(path)) continue;
                try {
                    const parsed = JSON.parse(entry.result);
                    if (parsed.error) continue;
                } catch { /* not JSON, it's file content */ }
                seenPaths.add(path);
                files.push({ path, content: entry.result });
            }
        }

        const assembledContext = terminalToolResult?.arguments?.content || null;
        const paths = files.map(f => f.path);

        if (files.length === 0 && !assembledContext) return null;

        // Build snippet-level context using bullet index for the approval UI
        const snippetContext = await this._buildSnippetContext(paths, query, conversationText);

        console.log(`[AgenticRetrieval] Retrieved ${files.length} memory files, assembled context: ${assembledContext ? assembledContext.length + ' chars' : 'none'}`);
        onProgress?.({
            stage: 'complete',
            message: `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}.`,
            paths
        });

        return { files, paths, assembledContext: assembledContext || snippetContext };
    }

    async _textSearchFallbackWithLoad(query, onProgress, conversationText) {
        const paths = await this._textSearchFallback(query);
        if (!paths || paths.length === 0) return null;

        const MAX_TOTAL_CHARS = 4000;
        const MAX_PER_FILE_CHARS = 1500;
        const files = [];
        let total = 0;
        for (const path of paths.slice(0, MAX_FILES_TO_LOAD)) {
            onProgress?.({ stage: 'loading', message: `Loading ${path}...`, path });
            const raw = await memoryFileSystem.read(path);
            if (!raw) continue;
            const content = raw.length > MAX_PER_FILE_CHARS
                ? raw.slice(0, MAX_PER_FILE_CHARS) + '...(truncated)'
                : raw;
            if (total + content.length > MAX_TOTAL_CHARS) break;
            files.push({ path, content });
            total += content.length;
        }

        if (files.length === 0) return null;

        // Build snippet-level assembled context from fallback
        const assembled = await this._buildSnippetContext(files.map(f => f.path), query, conversationText);

        console.log(`[AgenticRetrieval] Fallback retrieved ${files.length} memory files`);
        onProgress?.({
            stage: 'complete',
            message: `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}.`,
            paths: files.map(f => f.path)
        });

        return { files, paths: files.map(f => f.path), assembledContext: assembled };
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

    async _buildSnippetContext(paths, query, conversationText) {
        const queryTerms = tokenizeQuery(query);
        let candidates = [];
        const convWords = conversationText
            ? new Set(normalizeFactText(conversationText).split(/\s+/).filter(w => w.length >= 3))
            : null;

        await memoryBulletIndex.init();
        const indexed = memoryBulletIndex.getBulletsForPaths(paths);

        // Keep a safe fallback for first-run races.
        if (indexed.length === 0) {
            for (const path of paths) {
                await memoryBulletIndex.refreshPath(path);
            }
        }

        const indexedAfterRefresh = memoryBulletIndex.getBulletsForPaths(paths);
        for (const item of indexedAfterRefresh) {
            const score = scoreMemoryBullet(item.bullet, queryTerms);
            candidates.push({
                path: item.path,
                score,
                text: renderMemoryBullet(item.bullet),
                updatedAt: item.bullet.updatedAt || '',
                fileUpdatedAt: item.fileUpdatedAt || 0
            });
        }

        // Legacy fallback if a path is still not indexable.
        if (candidates.length === 0) {
            for (const path of paths) {
                const raw = await memoryFileSystem.read(path);
                if (!raw) continue;
                const bullets = parseMemoryBullets(raw);
                if (bullets.length > 0) {
                    for (const bullet of bullets) {
                        const score = scoreMemoryBullet(bullet, queryTerms);
                        candidates.push({ path, score, text: renderMemoryBullet(bullet), updatedAt: bullet.updatedAt || '' });
                    }
                    continue;
                }
                for (const snippet of this._extractLegacySnippets(raw, queryTerms)) {
                    candidates.push({ path, score: snippet.score, text: `- ${snippet.text}`, updatedAt: '' });
                }
            }
        }

        // Filter out bullets whose content is already in the current conversation
        if (convWords && convWords.size > 0) {
            candidates = candidates.filter(c => {
                const factWords = normalizeFactText(c.text).split(/\s+/).filter(w => w.length >= 3);
                if (factWords.length < 2) return true; // Too short to judge
                const matchCount = factWords.filter(w => convWords.has(w)).length;
                return matchCount / factWords.length < 0.8;
            });
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        });

        const selected = candidates.slice(0, MAX_SNIPPETS);
        const grouped = new Map();
        for (const item of selected) {
            const list = grouped.get(item.path) || [];
            list.push(item.text);
            grouped.set(item.path, list);
        }

        let total = 0;
        const sections = [];
        for (const [path, lines] of grouped.entries()) {
            const section = `### ${path}\n${lines.join('\n')}`;
            if (total + section.length > MAX_TOTAL_CONTEXT_CHARS) break;
            sections.push(section);
            total += section.length;
        }

        return sections.join('\n\n').trim() || null;
    }

    /**
     * Remove lines from assembled context whose key terms already appear in the conversation.
     */
    _filterRedundantContext(assembledContext, conversationText) {
        const convWords = new Set(
            normalizeFactText(conversationText).split(/\s+/).filter(w => w.length >= 3)
        );
        if (convWords.size === 0) return assembledContext;

        const lines = assembledContext.split('\n');
        const filtered = lines.filter(line => {
            const trimmed = line.trim();
            // Keep headings, empty lines, and non-bullet lines
            if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('-')) return true;
            const factWords = normalizeFactText(trimmed).split(/\s+/).filter(w => w.length >= 3);
            if (factWords.length < 2) return true;
            const matchCount = factWords.filter(w => convWords.has(w)).length;
            return matchCount / factWords.length < 0.8;
        });

        const result = filtered.join('\n').trim();
        return result || null;
    }

    _extractLegacySnippets(content, queryTerms) {
        const lines = String(content || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !line.startsWith('#'));
        if (lines.length === 0) return [];

        const snippets = lines.map((line) => {
            const lower = line.toLowerCase();
            let score = 0;
            for (const term of queryTerms) {
                if (lower.includes(term)) score += 1;
            }
            return { text: line, score };
        });

        snippets.sort((a, b) => b.score - a.score);
        return snippets.slice(0, 5);
    }

    async _isTrivialIndex(index) {
        const all = await memoryFileSystem.exportAll();
        const realFiles = all.filter(f => !f.path.endsWith('_index.md'));
        if (realFiles.length === 0) return true;
        return !realFiles.some(f => (f.itemCount || 0) > 0);
    }

}

const agenticRetrieval = new AgenticRetrieval();
export default agenticRetrieval;
