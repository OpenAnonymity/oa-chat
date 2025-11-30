/**
 * PDF Export Service
 * Handles exporting chat sessions to PDF files using html2pdf.js
 * Library is lazy-loaded on first export to improve initial page load.
 */

let html2pdfLoaded = false;

/**
 * Lazy-loads the html2pdf library from CDN.
 * @returns {Promise<void>}
 */
async function ensureHtml2Pdf() {
    if (html2pdfLoaded || typeof html2pdf !== 'undefined') {
        html2pdfLoaded = true;
        return;
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
        script.onload = () => {
            html2pdfLoaded = true;
            resolve();
        };
        script.onerror = () => reject(new Error('Failed to load html2pdf library'));
        document.head.appendChild(script);
    });
}

/**
 * Converts an already-loaded image element to a base64 data URL.
 * @param {HTMLImageElement} img - The loaded image element
 * @returns {string|null} Base64 data URL or null if conversion fails
 */
function imageToBase64(img) {
    if (!img.complete || img.naturalWidth === 0) {
        return null;
    }
    try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 24;
        canvas.height = img.naturalHeight || 24;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return canvas.toDataURL('image/png');
    } catch (e) {
        return null;
    }
}

/**
 * Applies PDF-friendly styles to user message bubbles.
 * @param {HTMLElement} wrapper - The wrapper element containing messages
 */
function styleUserBubbles(wrapper) {
    wrapper.querySelectorAll('.message-user').forEach(el => {
        el.style.setProperty('background', '#dbeafe', 'important');
        el.style.setProperty('border', '1px solid #93c5fd', 'important');
        el.style.setProperty('border-radius', '12px', 'important');
        el.style.setProperty('padding', '12px 16px', 'important');
        el.style.setProperty('margin', '8px 0', 'important');
        el.style.setProperty('color', '#1e40af', 'important');
        el.querySelectorAll('*').forEach(child => {
            child.style.setProperty('color', '#1e40af', 'important');
        });
    });
}

/**
 * Applies PDF-friendly styles to assistant message bubbles.
 * @param {HTMLElement} wrapper - The wrapper element containing messages
 */
function styleAssistantBubbles(wrapper) {
    wrapper.querySelectorAll('.message-assistant').forEach(el => {
        el.style.setProperty('background', '#f9fafb', 'important');
        el.style.setProperty('border', '1px solid #e5e7eb', 'important');
        el.style.setProperty('border-radius', '8px', 'important');
        el.style.setProperty('padding', '12px 16px', 'important');
        el.style.setProperty('margin', '8px 0', 'important');
        el.style.setProperty('color', '#111827', 'important');
    });
}

/**
 * Converts avatar images to base64 for PDF rendering.
 * Falls back to provider initials if conversion fails.
 * @param {HTMLElement} originalContainer - Original DOM container with loaded images
 * @param {HTMLElement} cloneWrapper - Cloned wrapper to update
 */
function processAvatarImages(originalContainer, cloneWrapper) {
    const originalAvatars = originalContainer.querySelectorAll('.rounded-full img');
    const clonedAvatars = cloneWrapper.querySelectorAll('.rounded-full img');

    for (let i = 0; i < clonedAvatars.length && i < originalAvatars.length; i++) {
        const clonedImg = clonedAvatars[i];
        const originalImg = originalAvatars[i];

        const base64 = imageToBase64(originalImg);
        if (base64) {
            clonedImg.src = base64;
        } else {
            // Fallback to provider initial
            const providerName = clonedImg.alt || '';
            const initial = providerName.charAt(0) || 'A';
            const parent = clonedImg.parentElement;
            clonedImg.remove();
            const span = document.createElement('span');
            span.textContent = initial;
            span.style.cssText = 'font-size: 10px; font-weight: 600; color: #374151;';
            parent.appendChild(span);
        }
    }

    // Style avatar containers
    cloneWrapper.querySelectorAll('.rounded-full').forEach(el => {
        if (el.classList.contains('w-6') || el.classList.contains('h-6')) {
            el.style.cssText = 'display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: white; border: 1px solid #d1d5db; overflow: hidden;';
        }
    });
}

/**
 * Applies general text styling for PDF visibility.
 * @param {HTMLElement} wrapper - The wrapper element
 */
function styleTextElements(wrapper) {
    wrapper.querySelectorAll('.prose, .message-content').forEach(el => {
        el.style.setProperty('color', '#111827', 'important');
    });
    wrapper.querySelectorAll('.text-foreground, .text-muted-foreground').forEach(el => {
        el.style.setProperty('color', '#374151', 'important');
    });
}

/**
 * Generates PDF filename with current date.
 * @returns {string} Filename in format oa-chat-YYYYMMDD.pdf
 */
function generateFilename() {
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    return `oa-chat-${dateStr}.pdf`;
}

/**
 * Exports chat messages to a PDF file.
 * @param {HTMLElement} messagesContainer - The messages container element
 * @returns {Promise<boolean>} True if export succeeded
 */
export async function exportToPdf(messagesContainer) {
    if (!messagesContainer) {
        console.error('PDF export: Missing container');
        return false;
    }

    try {
        // Lazy-load html2pdf on first use
        await ensureHtml2Pdf();
        // Clone the messages container
        const clone = messagesContainer.cloneNode(true);

        // Remove interactive elements
        clone.querySelectorAll(
            '.copy-message-btn, .regenerate-message-btn, .edit-prompt-btn, ' +
            '.fork-conversation-btn, .copy-user-message-btn, .message-user-actions'
        ).forEach(el => el.remove());

        // Create styled wrapper
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'padding: 20px; background: white; color: black; font-family: system-ui, -apple-system, sans-serif;';
        wrapper.appendChild(clone);

        // Apply PDF styles
        styleUserBubbles(wrapper);
        styleAssistantBubbles(wrapper);
        processAvatarImages(messagesContainer, wrapper);
        styleTextElements(wrapper);

        // Configure and generate PDF
        const options = {
            margin: [10, 10, 10, 10],
            filename: generateFilename(),
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
        };

        await html2pdf().set(options).from(wrapper).save();
        return true;

    } catch (error) {
        console.error('PDF export failed:', error);
        return false;
    }
}

