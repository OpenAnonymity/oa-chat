/**
 * MemoryExtractor — Write path for agentic memory.
 *
 * After each assistant response, examines the conversation and decides
 * whether to create/append/update a memory file. Uses the same Tinfoil
 * inference pattern as keywordsGenerator.
 */
import memoryFileSystem from './memoryFileSystem.js';
import { localInferenceService } from '../../local_inference/index.js';
import { chatDB } from '../db.js';
import { TINFOIL_API_KEY } from '../config.js';
import ticketClient from './ticketClient.js';

const TINFOIL_BASE_URL = 'https://inference.tinfoil.sh';
const TINFOIL_BACKEND_ID = 'tinfoil';
const TINFOIL_MODEL = 'gpt-oss-120b';
const TINFOIL_KEY_TICKETS_REQUIRED = 2;
const MAX_CONVERSATION_CHARS = 8000;

const EXTRACTION_PROMPT = `You are a memory manager. Given a conversation and the current memory index, decide if a **concrete, reusable fact** should be saved.

Only save information that would be useful to recall in a **future** conversation — personal facts, preferences, project context, interests, or recurring topics. Return "none" if the conversation doesn't reveal anything new worth remembering.

Do NOT save:
- Information already present in existing files (check the file contents carefully — do not duplicate facts)
- Vague or transient details (e.g. "help me with this", "thanks")
- The assistant's own reasoning or suggestions — only facts grounded in what the user said or asked about

Current memory index:
\`\`\`
{INDEX}
\`\`\`

Existing file contents:
\`\`\`
{FILE_CONTENTS}
\`\`\`

Conversation:
\`\`\`
{CONVERSATION}
\`\`\`

Respond with a single JSON object (no markdown fences):
{
  "action": "create" | "append" | "update" | "none",
  "path": "directory/filename.md",
  "content": "markdown content to write",
  "reason": "brief explanation"
}

Rules:
- Default to "none" if nothing new is worth remembering.
- Prefer "append" to existing files over creating new ones. One file per topic (e.g. one personal/background.md, not separate files for education, hobbies, etc).
- Content format: headers and bullet points with raw facts only. No filler commentary like "this helps tailor future conversations" or "noted for future reference".
  Good: "## Background\\n- Software engineer at Acme Corp\\n- Hobbies: hiking, cooking"
  Bad: "# User Background\\n\\nThese details can help tailor future recommendations..."
- For "none", path and content can be empty strings.`;

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

            // Build truncated conversation text
            const conversationText = this._buildConversationText(filtered);
            if (!conversationText) return;

            // Load current memory index and file contents (budget-capped)
            const index = await memoryFileSystem.getIndex() || '';
            const fileContentsText = await this._buildFileContentsText();

            // Ensure we have an API key
            const apiKey = await this._ensureTinfoilKey();
            if (!apiKey) {
                console.log('[MemoryExtractor] No Tinfoil key available, skipping');
                return;
            }

            const prompt = EXTRACTION_PROMPT
                .replace('{INDEX}', index)
                .replace('{FILE_CONTENTS}', fileContentsText)
                .replace('{CONVERSATION}', conversationText);

            console.log('[MemoryExtractor] Processing session:', sessionId);

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
                max_output_tokens: 500,
                temperature: 0,
                stream: false
            }, { backendId: TINFOIL_BACKEND_ID });

            const responseText = this._extractOutputText(response);
            if (!responseText) {
                console.warn('[MemoryExtractor] Empty response');
                return;
            }

            const parsed = this._parseResponse(responseText);
            if (!parsed) return;

            await this._executeAction(parsed);

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

    async _buildFileContentsText() {
        const MAX_TOTAL_CHARS = 4000;
        const MAX_PER_FILE_CHARS = 800;
        const allFiles = await memoryFileSystem.exportAll();
        const realFiles = allFiles.filter(f => !f.path.endsWith('_index.md'));
        if (realFiles.length === 0) return '(no files yet)';

        let total = 0;
        const parts = [];
        for (const f of realFiles) {
            const content = (f.content || '').length > MAX_PER_FILE_CHARS
                ? f.content.slice(0, MAX_PER_FILE_CHARS) + '...(truncated)'
                : f.content;
            const entry = `--- ${f.path} ---\n${content}`;
            if (total + entry.length > MAX_TOTAL_CHARS) break;
            parts.push(entry);
            total += entry.length;
        }
        return parts.join('\n\n');
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

    _parseResponse(text) {
        try {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            const parsed = JSON.parse(jsonMatch[0]);

            if (!parsed.action || parsed.action === 'none') {
                console.log('[MemoryExtractor] No memory action needed');
                return null;
            }

            if (!parsed.path || !parsed.content) {
                console.warn('[MemoryExtractor] Missing path or content in response');
                return null;
            }

            // Ensure path ends with .md
            if (!parsed.path.endsWith('.md')) {
                parsed.path += '.md';
            }

            return parsed;
        } catch (err) {
            console.error('[MemoryExtractor] Parse error:', err);
            console.log('[MemoryExtractor] Raw response:', text);
            return null;
        }
    }

    async _executeAction(parsed) {
        const { action, path, content, reason } = parsed;
        console.log(`[MemoryExtractor] ${action} → ${path} (${reason})`);

        switch (action) {
            case 'create':
            case 'update':
                await memoryFileSystem.write(path, content);
                break;
            case 'append': {
                const existing = await memoryFileSystem.read(path);
                const newContent = existing
                    ? existing + '\n\n' + content
                    : content;
                await memoryFileSystem.write(path, newContent);
                break;
            }
            default:
                console.warn('[MemoryExtractor] Unknown action:', action);
        }
    }

    /**
     * Ensure a valid Tinfoil API key (same pattern as keywordsGenerator).
     */
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
