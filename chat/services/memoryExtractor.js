/**
 * MemoryExtractor — Write path for agentic memory.
 *
 * After each assistant response, uses tool-calling via the agentic loop
 * to examine the conversation and decide whether to create/append/update
 * memory files.
 */
import memoryFileSystem from './memoryFileSystem.js';
import { localInferenceService } from '../../local_inference/index.js';
import { chatDB } from '../db.js';
import { TINFOIL_API_KEY } from '../config.js';
import ticketClient from './ticketClient.js';
import { runAgenticToolLoop } from './agenticToolLoop.js';
import { createExtractionExecutors } from './memoryStorageBackend.js';
import {
    compactBullets,
    ensureBulletMetadata,
    inferTopicFromPath,
    parseMemoryBullets,
    renderCompactedMemoryDocument,
    todayIsoDate
} from './memoryBulletUtils.js';
import memoryBulletIndex from './memoryBulletIndex.js';

const TINFOIL_BASE_URL = 'https://inference.tinfoil.sh';
const TINFOIL_BACKEND_ID = 'tinfoil';
const TINFOIL_MODEL = 'gpt-oss-120b';
const TINFOIL_KEY_TICKETS_REQUIRED = 2;
const MAX_CONVERSATION_CHARS = 8000;

const EXTRACTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the content of an existing memory file to inspect before writing.',
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
            name: 'create_new_file',
            description: 'Create a new memory file. Use for an entirely new topic that does not fit any existing file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path (e.g. projects/recipe-app.md)' },
                    content: { type: 'string', description: 'Bullet-point content to write' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_new_folder',
            description: 'Create a new folder in the memory filesystem.',
            parameters: {
                type: 'object',
                properties: {
                    folder_path: { type: 'string', description: 'Folder path to create (e.g. projects)' }
                },
                required: ['folder_path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'append_memory',
            description: 'Append new bullet points to an existing memory file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to append to' },
                    content: { type: 'string', description: 'Bullet-point content to append' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_memory',
            description: 'Overwrite an existing memory file with new content. Use when existing content is stale or contradicted.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to update' },
                    content: { type: 'string', description: 'Complete new content for the file' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'archive_memory',
            description: 'Remove a specific bullet point or item from a memory file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path containing the item' },
                    item_text: { type: 'string', description: 'The exact text of the item to remove' }
                },
                required: ['path', 'item_text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_memory',
            description: 'Delete an entire memory file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to delete' }
                },
                required: ['path']
            }
        }
    }
];

const EXTRACTION_SYSTEM_PROMPT = `You are a memory manager. After reading a conversation, decide if any concrete, reusable facts should be saved to the user's memory files.

Only save information useful in a **future** conversation — personal facts, preferences, project context, interests, constraints, recurring topics. Default to doing nothing if nothing new is worth remembering.

Do NOT save:
- Information already present in existing files (use read_file to check first)
- Vague or transient details (e.g. "help me with this", "thanks")
- The assistant's own reasoning or suggestions — only facts grounded in what the user said
- Sensitive secrets (passwords, auth tokens, private keys, full payment data, government IDs)

Current memory index:
\`\`\`
{INDEX}
\`\`\`

Directory structure:
- personal/about.md — All personal facts: background, preferences, interests, career, education, location
- projects/<project-name>.md — One file per project/app/task (lowercase, hyphenated)
- Preferred namespaces: personal/, preferences/, projects/, temporary/

Instructions:
1. Read the conversation below and decide if anything new should be saved.
2. If so, use read_file first to check existing content (avoid duplicates).
3. Use append_memory to add to existing files, or create_new_file for new topics.
4. Format content as bullet points with metadata: "- Fact text | topic=topic-name | updated_at=YYYY-MM-DD"
5. Time-sensitive facts must include date context (e.g. "As of 2026-03-05: ...").
6. If nothing new is worth remembering, simply stop without calling any write tools.

Rules:
- Prefer append_memory to existing files over creating new ones. One file per topic.
- Use update_memory only if a fact is now stale or contradicted.
- Content should be raw facts only — no filler commentary.`;


class MemoryExtractor {
    constructor() {
        this._tinfoilKey = null;
        this._tinfoilKeyInfo = null;
        this._processingSet = new Set();
    }

    /**
     * Process a session and extract memory if warranted.
     * @param {string} sessionId
     */
    async processSession(sessionId) {
        if (this._processingSet.has(sessionId)) return;
        this._processingSet.add(sessionId);

        try {
            await memoryFileSystem.init();

            const messages = await chatDB.getSessionMessages(sessionId);
            if (!messages || messages.length < 2) return;

            const filtered = messages.filter(m => !m.isLocalOnly);
            if (filtered.length < 2) return;

            const conversationText = this._buildConversationText(filtered);
            if (!conversationText) return;

            const index = await memoryFileSystem.getIndex() || '';

            const apiKey = await this._ensureTinfoilKey();
            if (!apiKey) {
                console.log('[MemoryExtractor] No Tinfoil key available, skipping');
                return;
            }

            console.log('[MemoryExtractor] Processing session:', sessionId);

            const systemPrompt = EXTRACTION_SYSTEM_PROMPT.replace('{INDEX}', index);
            const toolExecutors = createExtractionExecutors(memoryFileSystem, {
                normalizeContent: (content, path) => this._normalizeGeneratedContent(content, path),
                mergeWithExisting: (existing, incoming, path) => this._mergeWithExisting(existing, incoming, path),
                refreshIndex: (path) => memoryBulletIndex.refreshPath(path)
            });

            const { toolCallLog, iterations } = await runAgenticToolLoop({
                model: TINFOIL_MODEL,
                backendId: TINFOIL_BACKEND_ID,
                tools: EXTRACTION_TOOLS,
                toolExecutors,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Conversation:\n\`\`\`\n${conversationText}\n\`\`\`` }
                ],
                maxIterations: 6,
                maxOutputTokens: 500,
                temperature: 0,
                onToolCall: (name, args, result) => {
                    console.log(`[MemoryExtractor] Tool: ${name}`, args);
                }
            });

            const writeTools = ['create_new_file', 'append_memory', 'update_memory', 'archive_memory', 'delete_memory'];
            const writeCalls = toolCallLog.filter(e => writeTools.includes(e.name));

            if (writeCalls.length > 0) {
                console.log(`[MemoryExtractor] Completed: ${writeCalls.length} write operations in ${iterations} iterations`);
            } else {
                console.log('[MemoryExtractor] No memory actions needed');
            }

        } catch (error) {
            console.error('[MemoryExtractor] Error:', error);
            if (error.message?.includes('401') || error.message?.includes('403')) {
                this._tinfoilKey = null;
                this._tinfoilKeyInfo = null;
            }
        } finally {
            this._processingSet.delete(sessionId);
        }
    }

    _buildConversationText(messages) {
        const recent = messages.slice(-10);
        let text = '';
        for (const msg of recent) {
            const role = msg.role === 'user' ? 'User' : 'Assistant';
            const content = msg.content?.length > 500
                ? msg.content.substring(0, 500) + '...'
                : (msg.content || '');
            text += `${role}: ${content}\n\n`;
            if (text.length > MAX_CONVERSATION_CHARS) break;
        }
        return text.trim();
    }

    _normalizeGeneratedContent(content, path) {
        const incomingBullets = parseMemoryBullets(content);
        if (incomingBullets.length === 0) {
            return content;
        }

        const defaultTopic = inferTopicFromPath(path);
        const normalized = incomingBullets.map((bullet) =>
            ensureBulletMetadata(bullet, { defaultTopic, updatedAt: todayIsoDate() })
        );
        const compacted = compactBullets(normalized, { defaultTopic, maxActivePerTopic: 1000 });
        return renderCompactedMemoryDocument(compacted.active, compacted.archive);
    }

    _mergeWithExisting(existing, incoming, path) {
        const existingText = String(existing || '');
        const incomingText = String(incoming || '');
        const defaultTopic = inferTopicFromPath(path);
        const today = todayIsoDate();

        const existingBullets = parseMemoryBullets(existingText)
            .map((bullet) => ensureBulletMetadata(bullet, { defaultTopic, updatedAt: today }));
        const incomingBullets = parseMemoryBullets(incomingText)
            .map((bullet) => ensureBulletMetadata(bullet, { defaultTopic, updatedAt: today }));

        if (incomingBullets.length === 0) {
            return existingText
                ? `${existingText}\n\n${incomingText}`
                : incomingText;
        }

        if (existingBullets.length === 0) {
            const compacted = compactBullets(incomingBullets, { defaultTopic, maxActivePerTopic: 1000 });
            return renderCompactedMemoryDocument(compacted.active, compacted.archive);
        }

        const merged = [...existingBullets, ...incomingBullets];
        const compacted = compactBullets(merged, { defaultTopic, maxActivePerTopic: 1000 });
        return renderCompactedMemoryDocument(compacted.active, compacted.archive);
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
            const keyData = await ticketClient.requestConfidentialApiKey('memory', TINFOIL_KEY_TICKETS_REQUIRED);
            this._tinfoilKey = keyData.key;
            this._tinfoilKeyInfo = keyData;

            localInferenceService.configureBackend(TINFOIL_BACKEND_ID, {
                baseUrl: TINFOIL_BASE_URL,
                apiKey: keyData.key
            });

            console.log('[MemoryExtractor] Acquired Tinfoil key');
            return keyData.key;
        } catch (error) {
            console.warn('[MemoryExtractor] Failed to acquire Tinfoil key:', error);
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

const memoryExtractor = new MemoryExtractor();
export default memoryExtractor;
