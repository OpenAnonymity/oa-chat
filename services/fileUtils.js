// File utility functions for multimodal content handling

// File size limits (in bytes) - Unified 10MB limit
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB for all files

// Supported file types
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const SUPPORTED_PDF_TYPES = ['application/pdf'];
const SUPPORTED_AUDIO_TYPES = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/webm'];

export function getFileType(file) {
    if (SUPPORTED_IMAGE_TYPES.includes(file.type)) return 'image';
    if (SUPPORTED_PDF_TYPES.includes(file.type)) return 'pdf';
    if (SUPPORTED_AUDIO_TYPES.includes(file.type)) return 'audio';
    return 'unknown';
}

export function validateFile(file) {
    const fileType = getFileType(file);
    
    if (fileType === 'unknown') {
        return {
            valid: false,
            error: `Unsupported file type: ${file.type}. Supported types: images (JPEG, PNG, WebP, GIF), PDFs, and audio files.`
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
    const validation = validateFile(file);
    
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
        // OpenRouter PDF format: type: 'file' with filename and file_data
        return {
            type: 'file',
            file: {
                filename: file.name,
                file_data: base64Data
            }
        };
    }
    
    if (fileType === 'audio') {
        // OpenRouter audio format: type: 'file' with filename and file_data
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

