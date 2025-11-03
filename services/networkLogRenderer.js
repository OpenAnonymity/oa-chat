/**
 * Network Log Renderer
 * Shared rendering logic for network logs
 */

export function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false });
}

export function getHostFromUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.host;
    } catch {
        return 'unknown';
    }
}

export function getStatusIcon(status) {
    if (status >= 200 && status < 300) {
        return '✓';
    } else if (status === 0) {
        return '✗';
    } else if (status >= 400) {
        return '!';
    }
    return '•';
}

export function getStatusClass(status) {
    if (status >= 200 && status < 300) {
        return 'text-green-600';
    } else if (status === 0) {
        return 'text-red-600';
    } else if (status >= 400) {
        return 'text-orange-600';
    }
    return 'text-gray-600';
}

export function renderNetworkLog(log, isExpanded = false, isMinimal = false) {
    const statusIcon = getStatusIcon(log.status);
    const statusClass = getStatusClass(log.status);
    
    if (isMinimal && !isExpanded) {
        // Compact one-line view for floating panel
        return `
            <div class="p-2 flex items-center gap-2 hover:bg-muted/10 transition-colors text-xs">
                <span class="${statusClass} flex-shrink-0">${statusIcon}</span>
                <span class="text-muted-foreground font-mono flex-shrink-0">${formatTimestamp(log.timestamp)}</span>
                <span class="font-medium flex-shrink-0">${log.method}</span>
                <span class="text-muted-foreground truncate">${getHostFromUrl(log.url)}</span>
                <button id="close-floating-btn" class="text-muted-foreground hover:text-foreground p-0.5 ml-auto flex-shrink-0" onclick="event.stopPropagation();">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
        `;
    } else if (isMinimal && isExpanded) {
        // Expanded view for floating panel
        return `
            <div class="flex flex-col">
                <div class="p-3 border-b border-border flex items-center justify-between gap-2 hover:bg-muted/10 transition-colors">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                        <div class="w-2 h-2 rounded-full bg-green-500 flex-shrink-0"></div>
                        <span class="text-xs text-muted-foreground font-mono">${formatTimestamp(log.timestamp)}</span>
                        <span class="${statusClass}">${statusIcon}</span>
                    </div>
                    <button id="close-floating-btn" class="text-muted-foreground hover:text-foreground p-1 flex-shrink-0" onclick="event.stopPropagation();">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                <div class="p-3 space-y-2 text-xs max-h-64 overflow-y-auto">
                    <div class="space-y-1">
                        <div class="flex items-center gap-1 text-muted-foreground">
                            <span class="font-semibold">Request</span>
                        </div>
                        <div class="pl-4 space-y-1">
                            <div><span class="text-muted-foreground">Method:</span> <span class="font-medium">${log.method}</span></div>
                            <div><span class="text-muted-foreground">Host:</span> <span class="font-mono text-[10px]">${getHostFromUrl(log.url)}</span></div>
                        </div>
                    </div>
                    
                    <div class="space-y-1">
                        <div class="flex items-center gap-1 text-muted-foreground">
                            <span class="font-semibold">Response</span>
                        </div>
                        <div class="pl-4 space-y-1">
                            <div><span class="text-muted-foreground">Status:</span> <span class="font-medium ${getStatusClass(log.status)}">${log.status}</span></div>
                            ${log.error ? 
                                `<div class="text-red-600">Error: ${log.error}</div>` : 
                                `<div><span class="text-muted-foreground">Summary:</span> <span class="font-mono text-[10px]">OK</span></div>`
                            }
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    
    // Return empty string for non-minimal rendering (handled by RightPanel)
    return '';
}
