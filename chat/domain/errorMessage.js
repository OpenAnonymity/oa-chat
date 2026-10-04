// Error responses are not always strings (for example FastAPI detail objects
// and validation arrays). Read only message fields: serializing the whole
// response can expose credentials, request input or wallet data in chat history.
export function getErrorMessage(value, fallback = 'The request failed. Please try again.') {
    const seen = new Set();
    function read(candidate, depth = 0) {
        if (typeof candidate === 'string') return candidate.trim();
        if (!candidate || typeof candidate !== 'object' || depth > 6 || seen.has(candidate)) return '';
        seen.add(candidate);
        if (Array.isArray(candidate)) {
            return candidate.slice(0, 5).map(item => read(item, depth + 1)).filter(Boolean).join('; ');
        }
        for (const key of ['message', 'detail', 'error', 'msg']) {
            let field;
            try { field = candidate[key]; } catch { continue; }
            const message = read(field, depth + 1);
            if (message) return message;
        }
        return '';
    }
    return read(value) || (typeof fallback === 'string' ? fallback : 'The request failed. Please try again.');
}
