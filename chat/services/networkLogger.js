/**
 * Network Logger Service
 * Tracks and stores network requests for debugging and monitoring
 */

import { chatDB } from '../db.js';

class NetworkLogger {
    constructor() {
        this.logs = [];
        this.maxLogs = 200; // Keep last 200 requests across all sessions
        this.listeners = [];
        this.currentSessionId = null; // Track current session for logging
    }

    /**
     * Set the current session ID for tagging requests
     */
    setCurrentSession(sessionId) {
        this.currentSessionId = sessionId;
    }

    /**
     * Log a network request or local event
     * @param {Object} details - Event details
     * @param {string} details.type - Type of event (ticket, api-key, openrouter, inference, local)
     * @param {string} details.method - HTTP method or 'LOCAL' for local events
     * @param {string} details.url - Request URL (optional for local events)
     * @param {number} details.status - HTTP status code or event status
     * @param {Object} details.request - Request details (headers, body)
     * @param {Object} details.response - Response details
     * @param {Error} details.error - Error if request failed
     * @param {string} details.sessionId - Optional session ID (uses current if not provided)
     * @param {string} details.message - Human-readable message for local events
     * @param {string} details.detail - Optional detail code for UI descriptions
     * @param {string} details.action - Specific action type for local events
     */
    logRequest(details) {
        const logEntry = {
            id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            sessionId: details.sessionId || this.currentSessionId,
            type: details.type || 'unknown',
            method: details.method || 'GET',
            url: details.url || '',
            status: details.status || 0,
            request: details.request || {},
            response: details.response || {},
            error: details.error || null,
            message: details.message || '',
            detail: details.detail || '',
            action: details.action || '',
            isAborted: details.isAborted || false,
        };

        // Add to beginning of array (most recent first)
        this.logs.unshift(logEntry);

        // Trim to max size
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(0, this.maxLogs);
        }

        // Save to database - DISABLED (logs are now memory-only, ephemeral per tab)
        // if (typeof chatDB !== 'undefined' && chatDB.db) {
        //     chatDB.saveNetworkLog(logEntry).catch(err => console.error('Failed to save log:', err));
        //     chatDB.clearOldNetworkLogs(this.maxLogs).catch(err => console.error('Failed to clear old logs:', err));
        // }

        // Notify listeners
        this.notifyListeners();

        return logEntry;
    }

    /**
     * Load logs from database - DISABLED (logs are now memory-only, ephemeral per tab)
     */
    async loadLogs() {
        // Database persistence disabled - logs start fresh on each tab/app startup
        // if (typeof chatDB !== 'undefined' && chatDB.db) {
        //     try {
        //         this.logs = await chatDB.getAllNetworkLogs();
        //     } catch (err) {
        //         console.error('Failed to load logs:', err);
        //     }
        // }
    }

    /**
     * Get recent logs
     * @param {number} limit - Maximum number of logs to return
     */
    getRecentLogs(limit = 10) {
        return this.logs.slice(0, limit);
    }

    /**
     * Get all logs
     */
    getAllLogs() {
        return [...this.logs];
    }

    /**
     * Get logs for a specific session
     * @param {string} sessionId - Session ID to filter by
     */
    getLogsBySession(sessionId) {
        if (!sessionId) return [];
        return this.logs.filter(log => log.sessionId === sessionId);
    }

    /**
     * Clear all logs (memory only)
     */
    clearLogs() {
        this.logs = [];
        this.notifyListeners();
    }

    /**
     * Clear all logs (memory-only, database persistence disabled)
     */
    async clearAllLogs() {
        this.logs = [];
        this.notifyListeners();

        // Clear from database - DISABLED (logs are now memory-only, ephemeral per tab)
        // if (typeof chatDB !== 'undefined' && chatDB.db) {
        //     try {
        //         await chatDB.clearAllNetworkLogs();
        //     } catch (err) {
        //         console.error('Failed to clear logs from database:', err);
        //     }
        // }
    }

    /**
     * Subscribe to log updates
     * @param {Function} callback - Called when logs are updated
     */
    subscribe(callback) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(cb => cb !== callback);
        };
    }

    /**
     * Notify all listeners
     */
    notifyListeners() {
        this.listeners.forEach(callback => callback(this.logs));
    }

    /**
     * Format URL for display (show only path and query)
     */
    formatUrl(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.pathname + urlObj.search;
        } catch {
            return url;
        }
    }

    /**
     * Get endpoint name from URL
     */
    getEndpointName(url) {
        try {
            const urlObj = new URL(url);
            const path = urlObj.pathname;
            // Return last part of path
            const parts = path.split('/').filter(p => p);
            return parts[parts.length - 1] || '/';
        } catch {
            return url;
        }
    }

    /**
     * Sanitize headers (remove sensitive data)
     */
    sanitizeHeaders(headers) {
        const sanitized = { ...headers };

        // Mask authorization headers
        if (sanitized.Authorization) {
            const auth = sanitized.Authorization;
            if (auth.includes('Bearer')) {
                const token = auth.split('Bearer ')[1];
                if (token && token.length > 20) {
                    sanitized.Authorization = `Bearer ${token.slice(0, 12)}...${token.slice(-8)}`;
                }
            }
            // InferenceTicket tokens are single-use and already consumed, so no need to mask them
        }

        return sanitized;
    }

    /**
     * Get summary of request data
     */
    getRequestSummary(request) {
        if (!request) return '';

        const parts = [];

        if (request.body) {
            try {
                const body = typeof request.body === 'string'
                    ? JSON.parse(request.body)
                    : request.body;

                if (body.messages) {
                    parts.push(`${body.messages.length} messages`);
                }
                if (body.model) {
                    parts.push(`model: ${body.model}`);
                }
            } catch {
                parts.push('body: [data]');
            }
        }

        return parts.join(', ');
    }

    /**
     * Get summary of response data
     */
    getResponseSummary(response, status) {
        if (!response) return status ? `Status: ${status}` : '';

        try {
            const data = typeof response === 'string'
                ? JSON.parse(response)
                : response;

            if (data.choices && data.choices.length > 0) {
                const content = data.choices[0].message?.content || '';
                return content.substring(0, 100) + (content.length > 100 ? '...' : '');
            }

            if (data.code || data.invitation_code || data.credential) {
                return 'Ticket code received';
            }

            if (data.key) {
                return 'API key received';
            }

            if (data.data && Array.isArray(data.data)) {
                return `${data.data.length} items`;
            }

            if (data.error) {
                return `Error: ${data.error.message || data.error}`;
            }

            return JSON.stringify(data).substring(0, 100);
        } catch {
            return String(response).substring(0, 100);
        }
    }

    /**
     * Log full details to browser console
     */
    logToConsole(logEntry) {
        console.groupCollapsed(
            `%c[Network Log] ${logEntry.method} ${this.getEndpointName(logEntry.url)} (${logEntry.status})`,
            `color: ${logEntry.status >= 200 && logEntry.status < 300 ? '#22c55e' : '#ef4444'}; font-weight: bold;`
        );

        console.log('Timestamp:', new Date(logEntry.timestamp).toLocaleString());
        console.log('Type:', logEntry.type);
        console.log('Method:', logEntry.method);
        console.log('URL:', logEntry.url);
        console.log('Status:', logEntry.status);

        if (logEntry.request) {
            console.group('Request');
            console.log('Headers:', logEntry.request.headers);
            console.log('Body:', logEntry.request.body);
            console.groupEnd();
        }

        if (logEntry.response) {
            console.group('Response');
            console.log('Data:', logEntry.response);
            console.groupEnd();
        }

        if (logEntry.error) {
            console.group('Error');
            console.error(logEntry.error);
            console.groupEnd();
        }

        console.groupEnd();
    }
}

// Export singleton instance
const networkLogger = new NetworkLogger();

// Make available globally for non-module scripts
if (typeof window !== 'undefined') {
    window.networkLogger = networkLogger;
}

export default networkLogger;
