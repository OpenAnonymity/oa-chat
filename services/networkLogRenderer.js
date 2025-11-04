/**
 * Network Log Renderer
 * Shared rendering logic for network logs
 */

export function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

export function getStatusDotClass(status) {
    if (status >= 200 && status < 300) {
        return 'bg-green-500';
    } else if (status === 0) {
        return 'bg-red-500';
    } else if (status >= 400) {
        return 'bg-orange-500';
    }
    return 'bg-gray-500';
}

/**
 * Get user-friendly activity description based on log type and endpoint
 */
export function getActivityDescription(log, detailed = false) {
    const { type, url, method, status, response, request } = log;
    
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        
        // Ticket registration
        if (type === 'ticket' && path.includes('alpha-register')) {
            if (!detailed) {
                if (status >= 200 && status < 300) {
                    return 'Privacy tickets registered successfully';
                } else if (status === 0) {
                    return 'Failed to register privacy tickets';
                }
                return 'Registering privacy tickets';
            } else {
                if (status >= 200 && status < 300) {
                    const ticketCount = response?.signed_responses?.length || 0;
                    return `Successfully registered ${ticketCount} privacy-preserving inference tickets. These tickets allow you to request anonymous API keys without revealing your identity.`;
                } else if (status === 0) {
                    return 'Failed to register privacy tickets. The registration server may be unavailable or your invitation code may be invalid.';
                }
                return 'Attempting to register privacy tickets with the anonymization server...';
            }
        }
        
        // API key request
        if (type === 'api-key' && path.includes('request_key')) {
            if (!detailed) {
                if (status >= 200 && status < 300) {
                    return 'Anonymous API access granted';
                } else if (status === 0) {
                    return 'Failed to obtain API access';
                }
                return 'Requesting anonymous API access';
            } else {
                if (status >= 200 && status < 300) {
                    const duration = response?.duration_minutes || 60;
                    return `Successfully obtained an anonymous API key valid for ${duration} minutes. This key allows you to access AI models without linking requests to your identity.`;
                } else if (status === 0) {
                    return 'Failed to obtain API access. The anonymization server may be unavailable or your ticket may have already been used.';
                }
                return 'Exchanging privacy ticket for anonymous API access...';
            }
        }
        
        // OpenRouter API calls
        if (type === 'openrouter') {
            // Models fetch
            if (path.includes('/models')) {
                if (!detailed) {
                    if (status >= 200 && status < 300) {
                        return 'AI models catalog loaded';
                    } else if (status === 0) {
                        return 'Failed to fetch AI models';
                    }
                    return 'Fetching AI models catalog';
                } else {
                    if (status >= 200 && status < 300) {
                        const modelCount = response?.data?.length || 0;
                        return `Successfully loaded catalog of ${modelCount} available AI models including GPT, Claude, and open-source alternatives.`;
                    } else if (status === 0) {
                        return 'Failed to fetch AI model catalog. Check your internet connection or API key validity.';
                    }
                    return 'Retrieving list of available AI models from OpenRouter...';
                }
            }
            
            // Chat completions
            if (path.includes('/chat/completions')) {
                if (!detailed) {
                    if (status >= 200 && status < 300) {
                        return 'AI response received';
                    } else if (status === 0) {
                        return 'AI inference request failed';
                    }
                    return 'Processing AI inference request';
                } else {
                    if (status >= 200 && status < 300) {
                        const model = request?.body?.model || 'Unknown model';
                        return `AI successfully processed your request using ${model}. Response received and displayed in chat.`;
                    } else if (status === 0) {
                        return 'AI inference request failed. This may be due to network issues, invalid API key, or model availability.';
                    }
                    const model = request?.body?.model || 'AI model';
                    return `Sending your message to ${model} for processing through the anonymized inference service...`;
                }
            }
        }
        
        // Fallback descriptions
        if (!detailed) {
            if (status >= 200 && status < 300) {
                return `${method} request completed`;
            } else if (status === 0) {
                return `${method} request failed`;
            }
            return `${method} request in progress`;
        } else {
            if (status >= 200 && status < 300) {
                return `Successfully completed ${method} request to ${urlObj.host}`;
            } else if (status === 0) {
                return `Failed to complete ${method} request to ${urlObj.host}. Check network connectivity.`;
            }
            return `Processing ${method} request to ${urlObj.host}...`;
        }
        
    } catch {
        return detailed ? `Processing ${method} ${type} request...` : `${method} ${type} request`;
    }
}

/**
 * Get activity type icon
 */
export function getActivityIcon(log) {
    const { type, url } = log;
    
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        
        // Ticket registration - ticket icon
        if (type === 'ticket') {
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"></path>
            </svg>`;
        }
        
        // API key - key icon
        if (type === 'api-key') {
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
            </svg>`;
        }
        
        // OpenRouter - models
        if (type === 'openrouter' && path.includes('/models')) {
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"></path>
            </svg>`;
        }
        
        // OpenRouter - chat (AI brain icon)
        if (type === 'openrouter') {
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"></path>
            </svg>`;
        }
        
    } catch {}
    
    // Default icon
    return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
    </svg>`;
}

export function renderNetworkLog(log, isExpanded = false, isMinimal = false) {
    const statusIcon = getStatusIcon(log.status);
    const statusClass = getStatusClass(log.status);
    const description = getActivityDescription(log);
    const icon = getActivityIcon(log);
    
    if (isMinimal && !isExpanded) {
        // Compact one-line view for floating panel - matches right panel
        return `
            <div class="px-3 py-1.5 border-b border-transparent flex items-center gap-1.5 hover:bg-muted/10 transition-colors text-xs">
                <span class="flex-shrink-0 text-muted-foreground">
                    ${icon}
                </span>
                <span class="truncate flex-1 font-medium" title="${description}">
                    ${description}
                </span>
                <span class="text-muted-foreground font-mono ml-auto" style="font-size: 10px;">
                    ${formatTimestamp(log.timestamp)}
                </span>
                <button id="close-floating-btn" class="text-muted-foreground hover:text-foreground p-0.5 ml-2 flex-shrink-0" onclick="event.stopPropagation();">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
        `;
    } else if (isMinimal && isExpanded) {
        // Expanded view for floating panel - matches right panel
        return `
            <div class="flex flex-col">
                <div class="px-3 py-1.5 border-b border-border flex items-center gap-1.5 hover:bg-muted/10 transition-colors text-xs">
                    <span class="flex-shrink-0 text-muted-foreground">
                        ${icon}
                    </span>
                    <span class="truncate flex-1 font-medium" title="${description}">
                        ${description}
                    </span>
                    <span class="text-muted-foreground font-mono ml-auto" style="font-size: 10px;">
                        ${formatTimestamp(log.timestamp)}
                    </span>
                    <button id="close-floating-btn" class="text-muted-foreground hover:text-foreground p-0.5 ml-2 flex-shrink-0" onclick="event.stopPropagation();">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                <!-- Detailed description -->
                <div class="px-3 pt-3 pb-2 border-b border-border/50">
                    <div class="text-xs text-foreground leading-relaxed">${getActivityDescription(log, true)}</div>
                </div>
                
                <!-- Technical Summary -->
                <div class="px-3 py-3 space-y-2 text-xs">
                    <div class="flex items-center gap-2 text-[10px]">
                        <div class="flex items-center gap-1">
                            <span class="text-muted-foreground">Status:</span>
                            <span class="font-medium px-1 py-0.5 rounded text-[10px] ${
                                log.status >= 200 && log.status < 300 ? 'bg-green-100 text-green-700' : 
                                log.status === 0 ? 'bg-red-100 text-red-700' : 
                                'bg-orange-100 text-orange-700'
                            }">
                                ${log.status || 'ERROR'}
                            </span>
                        </div>
                        <div class="flex items-center gap-1">
                            <span class="text-muted-foreground">Method:</span>
                            <span class="font-medium">${log.method}</span>
                        </div>
                    </div>
                    
                    <div class="text-[10px] text-muted-foreground">
                        <div class="font-medium mb-0.5">Destination:</div>
                        <div class="font-mono break-all">${log.url}</div>
                    </div>
                    
                    ${log.error ? `
                        <div class="text-[10px] text-red-600 bg-red-50/50 p-1.5 rounded">
                            ${log.error}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }
    
    // Return empty string for non-minimal rendering (handled by RightPanel)
    return '';
}
