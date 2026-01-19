// File utility functions for multimodal content handling

// File size limits (in bytes) - Unified 10MB limit
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB for all files

// Supported file types
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const SUPPORTED_PDF_TYPES = ['application/pdf'];
const SUPPORTED_AUDIO_TYPES = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/webm'];

// NOTE: Microsoft Office formats (.docx, .xlsx) are not currently supported.
// Future implementation would require client-side parsing (e.g., mammoth.js)
// to extract text content before sending to the AI, as most models don't support
// these binary formats directly.

/**
 * Attempts to detect if a file is text-based by reading a sample of its content.
 * @param {File} file - The file to check
 * @returns {Promise<boolean>} True if the file appears to be text
 */
async function isTextFile(file) {
    // If browser provides a text/* MIME type, trust it
    if (file.type.startsWith('text/')) {
        return true;
    }

    // Common text-based MIME types
    const textMimeTypes = [
        'application/json',
        'application/javascript',
        'application/xml',
        'application/x-sh',
        'application/x-yaml',
        'application/toml',
        'application/x-toml'
    ];

    if (textMimeTypes.includes(file.type)) {
        return true;
    }

    // If MIME type is empty or generic, try to detect by reading content
    if (!file.type || file.type === 'application/octet-stream' || file.type === '') {
        try {
            // Read first 8KB to check if it's text (more generous sample)
            const sampleSize = Math.min(8192, file.size);
            const slice = file.slice(0, sampleSize);
            const buffer = await slice.arrayBuffer();
            const bytes = new Uint8Array(buffer);

            // Check for null bytes (strong indicator of binary file)
            // But allow a few nulls in case of UTF-16 or similar
            let nullCount = 0;
            for (let i = 0; i < bytes.length; i++) {
                if (bytes[i] === 0) {
                    nullCount++;
                    // If more than 1% nulls, likely binary
                    if (nullCount > bytes.length * 0.01) {
                        return false;
                    }
                }
            }

            // Check if most bytes are in printable ASCII or common UTF-8 ranges
            let textLikeCount = 0;
            for (let i = 0; i < bytes.length; i++) {
                const byte = bytes[i];
                // Printable ASCII (32-126), newline (10), carriage return (13), tab (9)
                // or UTF-8 continuation bytes (128-255)
                if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9 || byte >= 128) {
                    textLikeCount++;
                }
            }

            // If more than 70% of bytes look like text, consider it text (more liberal)
            return (textLikeCount / bytes.length) > 0.70;
        } catch (e) {
            console.warn('Failed to detect file type:', e);
            // On error, be permissive and allow it
            return true;
        }
    }

    return false;
}

export async function getFileType(file) {
    if (SUPPORTED_IMAGE_TYPES.includes(file.type)) return 'image';
    if (SUPPORTED_PDF_TYPES.includes(file.type)) return 'pdf';
    if (SUPPORTED_AUDIO_TYPES.includes(file.type)) return 'audio';

    // Try to detect text files
    if (await isTextFile(file)) {
        return 'text';
    }

    return 'unknown';
}

/**
 * Returns an SVG icon string based on file type/mime type.
 * @param {string} fileType - One of 'image', 'pdf', 'audio', 'text', 'unknown'
 * @param {string} mimeType - The detailed mime type
 * @param {string} className - CSS classes for the SVG
 * @returns {string} SVG HTML string
 */
export function getFileIconSvg(fileType, mimeType, className = "w-8 h-8") {
    if (fileType === 'image') {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="${className} text-primary">
                <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
        `;
    } else if (fileType === 'pdf') {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="${className} text-destructive">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
        `;
    } else if (fileType === 'audio') {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="${className} text-green-600">
                <path stroke-linecap="round" stroke-linejoin="round" d="m9 9 10.5-3m0 6.553v3.75a2.25 2.25 0 0 1-1.632 2.163l-1.32.377a1.803 1.803 0 1 1-.99-3.467l2.31-.66a2.25 2.25 0 0 0 1.632-2.163Zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 0 1-1.632 2.163l-1.32.377a1.803 1.803 0 0 1-.99-3.467l2.31-.66A2.25 2.25 0 0 0 9 15.553Z" />
            </svg>
        `;
    } else if (fileType === 'text' || mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('xml')) {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="${className} text-blue-500">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
        `;
    }

    // Generic file icon
    return `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="${className} text-muted-foreground">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
    `;
}

export function getExtensionFromMimeType(mimeType) {
    const typeMap = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'application/pdf': 'pdf',
        'audio/wav': 'wav',
        'audio/mp3': 'mp3',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg',
        'audio/webm': 'webm',
        // Text types
        'text/plain': 'txt',
        'text/markdown': 'md',
        'text/csv': 'csv',
        'application/json': 'json',
        'text/json': 'json',
        'text/javascript': 'js',
        'application/javascript': 'js',
        'text/html': 'html',
        'text/css': 'css',
        'text/xml': 'xml',
        'application/xml': 'xml',
        'text/x-python': 'py',
        'text/x-tex': 'tex',
        'application/x-tex': 'tex',
        'application/x-yaml': 'yaml',
        'application/toml': 'toml',
        'application/x-toml': 'toml',
        'application/x-sh': 'sh'
    };

    // If exact match found, return it
    if (typeMap[mimeType]) {
        return typeMap[mimeType];
    }

    // If it starts with text/, assume txt
    if (mimeType.startsWith('text/')) {
        return 'txt';
    }

    return null;
}

export async function validateFile(file) {
    const fileType = await getFileType(file);

    if (fileType === 'unknown') {
        return {
            valid: false,
            error: `Unsupported file type: ${file.type}. Supported types: images, PDFs, audio, and text files (Markdown, JSON, CSV, Code, etc.).`
        };
    }

    if (file.size > MAX_FILE_SIZE) {
        return {
            valid: false,
            error: `File "${file.name}" exceeds the 10MB size limit (${formatFileSize(file.size)}). Please use a smaller file.`
        };
    }

    return { valid: true, fileType };
}

export function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(new Error(`Failed to read file: ${error.message}`));
        reader.readAsDataURL(file);
    });
}

function getAudioFormat(mimeType) {
    const formatMap = {
        'audio/wav': 'wav',
        'audio/mp3': 'mp3',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg',
        'audio/webm': 'webm'
    };
    return formatMap[mimeType] || 'wav';
}

export async function fileToMultimodalContent(file) {
    const validation = await validateFile(file);

    if (!validation.valid) {
        throw new Error(validation.error);
    }

    const base64Data = await fileToBase64(file);
    const fileType = validation.fileType;

    if (fileType === 'image') {
        return {
            type: 'image_url',
            image_url: { url: base64Data }
        };
    }

    if (fileType === 'pdf') {
        // Default file format for inference backends (OpenRouter-compatible).
        return {
            type: 'file',
            file: {
                filename: file.name,
                file_data: base64Data
            }
        };
    }

    if (fileType === 'audio') {
        // Default file format for inference backends (OpenRouter-compatible).
        return {
            type: 'file',
            file: {
                filename: file.name,
                file_data: base64Data
            }
        };
    }

    throw new Error(`Unsupported file type: ${fileType}`);
}

export async function filesToMultimodalContent(files) {
    const contentPromises = files.map(file => fileToMultimodalContent(file));
    return await Promise.all(contentPromises);
}

export function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Exports all chat sessions and messages as a downloadable JSON file.
 * @deprecated Use exportChats from globalExport.js instead.
 * This function is kept for backward compatibility and delegates to exportChats.
 */
export async function downloadAllChats() {
    const { exportChats } = await import('./globalExport.js');
    return exportChats();
}

/**
 * Exports all inference tickets from persistent storage as a downloadable JSON file.
 * @deprecated Use exportTickets from globalExport.js instead.
 * This function is kept for backward compatibility and delegates to exportTickets.
 */
export async function downloadInferenceTickets() {
    const { exportTickets } = await import('./globalExport.js');
    return exportTickets();
}
