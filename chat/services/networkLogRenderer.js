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

export function getStatusIcon(status, isAborted = false) {
    if (isAborted) {
        return '⊗'; // Interrupted/stopped icon
    } else if (status === 'queued' || status === 'pending') {
        return '◎'; // Queued/pending icon
    } else if (status >= 200 && status < 300) {
        return '✓';
    } else if (status === 0) {
        return '✗';
    } else if (status >= 400) {
        return '!';
    }
    return '•';
}

export function getStatusClass(status, isAborted = false) {
    if (isAborted) {
        return 'text-orange-600'; // Orange for user-interrupted
    } else if (status === 'queued' || status === 'pending') {
        return 'text-amber-600'; // Amber for queued/pending
    } else if (status >= 200 && status < 300) {
        return 'text-status-success'; // Success status color
    } else if (status === 0) {
        return 'text-red-600';
    } else if (status >= 400) {
        return 'text-orange-600';
    }
    return 'text-gray-600';
}

export function getStatusDotClass(status, isAborted = false, detail = '') {
    if (isAborted) {
        return 'bg-orange-500'; // Orange dot for user-interrupted
    } else if (status === 'queued' || status === 'pending') {
        return 'bg-amber-500'; // Amber dot for queued/pending
    } else if (detail === 'key_near_expiry') {
        return 'bg-amber-500'; // Amber dot for unverified policy case
    } else if (status >= 200 && status < 300) {
        return 'bg-status-success'; // Success status color
    } else if (status >= 400 || status === 0) {
        return 'bg-red-500'; // Red for errors (4xx, 5xx, network failures)
    }
    return 'bg-gray-500';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function escapeHtmlAttribute(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '&#10;');
}

/**
 * Get user-friendly activity description based on log type and endpoint
 */
export function getActivityDescription(log, detailed = false) {
    const { type, url, method, status, response, request, action, message } = log;

    // Handle local events (non-network operations)
    if (type === 'local' && method === 'LOCAL') {
        if (!detailed) {
            // Simple descriptions for local events
            if (action === 'ticket-select') {
                return 'Redeeming unblinded ticket';
            } else if (action === 'ticket-select-split') {
                return 'Selecting tickets for split';
            } else if (action === 'tickets-blind') {
                return `Blinded ${response?.ticket_count || 0} tickets locally`;
            } else if (action === 'tickets-signed') {
                return `Received ${response?.signed_tickets_received || 0} signed tickets`;
            } else if (action === 'tickets-unblind') {
                return `Unblinded ${response?.tickets_finalized || 0} tickets`;
            } else if (action === 'prompt-edit') {
                return 'Edited prompt and regenerated response';
            } else if (action === 'session-fork') {
                return 'Forked chat to new session';
            }
            return message || 'Local operation completed';
        } else {
            // Detailed descriptions for local events
            if (action === 'ticket-select') {
                const ticketIndex = response?.ticket_index || 0;
                const unusedTickets = response?.unused_tickets || 0;
                return `Selected inference ticket #${ticketIndex} from your local storage. You have ${unusedTickets} unused ticket${unusedTickets !== 1 ? 's' : ''} remaining. This ticket will be exchanged with a station for an unlinkable API key.`;
            } else if (action === 'ticket-select-split') {
                const ticketIndex = response?.ticket_index || 0;
                const selectedCount = response?.tickets_selected || 0;
                const unusedTickets = response?.unused_tickets || 0;
                return `Selected ${selectedCount} inference ticket${selectedCount !== 1 ? 's' : ''} starting at #${ticketIndex} from your local storage for split. You have ${unusedTickets} unused ticket${unusedTickets !== 1 ? 's' : ''} remaining.`;
            } else if (action === 'tickets-blind') {
                const count = response?.ticket_count || 0;
                return `Created ${count} blinded inference ticket${count !== 1 ? 's' : ''} locally using Privacy Pass cryptography. These blinded tokens hide your identity from the server while allowing it to sign them. The blinded tickets are now ready to be sent to the server for signing.`;
            } else if (action === 'tickets-signed') {
                const count = response?.signed_tickets_received || 0;
                return `Received ${count} signed ticket${count !== 1 ? 's' : ''} from the server. The server has signed your blinded tokens without learning anything about your identity. These signed tickets now need to be unblinded locally to become usable.`;
            } else if (action === 'tickets-unblind') {
                const count = response?.tickets_finalized || 0;
                const ready = response?.tickets_ready || 0;
                return `Successfully unblinded and finalized ${count} inference ticket${count !== 1 ? 's' : ''}. You now have ${ready} ready-to-use ticket${ready !== 1 ? 's' : ''} stored locally. Each ticket can be exchanged for one temporary unlinkable API key.`;
            } else if (action === 'prompt-edit') {
                const deletedCount = response?.messagesDeleted || 0;
                return `Edited a user prompt and truncated ${deletedCount} subsequent message${deletedCount !== 1 ? 's' : ''}. The conversation continues from this point with a fresh response.`;
            } else if (action === 'session-fork') {
                const messageCount = response?.messagesCopied || 0;
                const hasSharedKey = response?.sharedApiKey;
                return `Created a new conversation branch with ${messageCount} message${messageCount !== 1 ? 's' : ''} from the original session${hasSharedKey ? ', reusing the same ephemeral access key' : ''}.`;
            }
            return message || 'Local cryptographic operation completed successfully.';
        }
    }

    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;

        if (type === 'ticket' && path.includes('/chat/free_access')) {
            return 'Checking free access';
        }

        if (type === 'ticket' && path.includes('/api/waitlist/join')) {
            if (!detailed) {
                if (status >= 200 && status < 300) {
                    return 'Beta waitlist submitted';
                } else if (status === 0) {
                    return 'Failed to submit beta waitlist form';
                }
                return 'Submitting beta waitlist form';
            }

            if (status >= 200 && status < 300) {
                return "Successfully submitted your beta waitlist form. We'll be in touch soon.";
            } else if (status === 0) {
                return 'Failed to submit the beta waitlist form due to a network error.';
            }
            return 'Submitting your beta waitlist form to OA...';
        }

        // Ticket registration
        if (type === 'ticket' && path.includes('alpha-register')) {
            if (!detailed) {
                if (status >= 200 && status < 300) {
                    return 'Inference tickets registered successfully';
                } else if (status === 0) {
                    return 'Failed to register inference tickets';
                }
                return 'Registering inference tickets';
            } else {
                if (status >= 200 && status < 300) {
                    const ticketCount = response?.signed_responses?.length || 0;
                    return `Successfully registered ${ticketCount} inference tickets. These tickets allow you to request unlinkable ephemeral access keys.`;
                } else if (status === 0) {
                    return 'Failed to register inference tickets. The OA platform may be unavailable or your invitation code may be invalid.';
                }
                return 'Attempting to register inference tickets with OA platform...';
            }
        }

        // Ticket split (ticket code)
        if (type === 'ticket' && path.includes('/api/split_tickets')) {
            const count = response?.tickets_consumed || request?.body?.count || 0;
            if (!detailed) {
                if (status >= 200 && status < 300) {
                    return 'Ticket code created';
                } else if (status === 0) {
                    return 'Failed to split tickets';
                }
                return 'Splitting tickets into ticket code';
            } else {
                if (status >= 200 && status < 300) {
                    return `Successfully split ${count || 'your'} inference ticket${count === 1 ? '' : 's'} into a ticket code.`;
                } else if (status === 0) {
                    return 'Failed to split tickets. The server may be unavailable or your tickets may have already been used.';
                }
                return 'Splitting inference tickets into a ticket code...';
            }
        }

        // Confidential API key request
        if (type === 'api-key' && path.includes('request_confidential_key')) {
            if (!detailed) {
                if (status >= 200 && status < 300) {
                    return 'Confidential access key granted';
                } else if (status === 0) {
                    return 'Failed to obtain confidential key';
                }
                return 'Requesting confidential unlinkable key';
            } else {
                if (status >= 200 && status < 300) {
                    const duration = response?.duration_minutes || 60;
                    return `Successfully obtained a confidential API key valid for ${duration} minutes. This key allows privacy-preserving redaction without linking requests to your identity.`;
                } else if (status === 0) {
                    return 'Failed to obtain confidential API access. The anonymization server may be unavailable or your ticket may have already been used.';
                }
                return 'Exchanging privacy ticket for confidential unlinkable API access...';
            }
        }

        // API key request
        if (type === 'api-key' && path.includes('request_key')) {
            if (!detailed) {
                if (status >= 200 && status < 300) {
                    return 'Ephemeral access key granted';
                } else if (status === 0) {
                    return 'Failed to obtain ephemeral key';
                }
                return 'Requesting ephemeral access key';
            } else {
                if (status >= 200 && status < 300) {
                    const duration = response?.duration_minutes || 60;
                    return `Successfully obtained an ephemeral key valid for ${duration} minutes.`;
                } else if (status === 0) {
                    return 'Failed to obtain ephemeral key. The OA platform may be unavailable or your ticket may have already been used.';
                }
                return 'Exchanging privacy ticket for ephemeral access key...';
            }
        }

        // OpenRouter API calls
        if (type === 'openrouter') {
            // Models fetch - TEMPORARILY COMMENTED OUT
            // if (path.includes('/models')) {
            //     if (!detailed) {
            //         if (status >= 200 && status < 300) {
            //             return 'Model catalog loaded';
            //         } else if (status === 0) {
            //             return 'Failed to fetch models';
            //         }
            //         return 'Fetching model catalog';
            //     } else {
            //         if (status >= 200 && status < 300) {
            //             const modelCount = response?.data?.length || 0;
            //             return `Successfully loaded catalog of ${modelCount} available AI models including GPT, Claude, and open-source alternatives.`;
            //         } else if (status === 0) {
            //             return 'Failed to fetch AI model catalog. Check your internet connection or API key validity.';
            //         }
            //         return 'Retrieving list of available AI models from OpenRouter...';
            //     }
            // }

            // Chat completions
            if (path.includes('/chat/completions')) {
                // Check if this was a user-interrupted request
                if (log.isAborted) {
                    if (!detailed) {
                        return 'Response interrupted by user';
                    } else {
                        return 'The model response was stopped by the user. The partial response has been saved and can be continued or regenerated.';
                    }
                }

                if (!detailed) {
                    if (status >= 200 && status < 300) {
                        return 'Response received';
                    } else if (status === 0) {
                        return 'Inference request failed';
                    }
                    return 'Processing inference request';
                } else {
                    if (status >= 200 && status < 300) {
                        const model = request?.body?.model || 'Unknown model';
                        return `Successfully processed your request using ${model}. Response received and displayed in chat.`;
                    } else if (status === 0) {
                        return 'Inference request failed. This may be due to network issues, invalid API key, or model availability.';
                    }
                    const model = request?.body?.model || 'AI model';
                    return `Sending your message to ${model} for processing through the anonymized inference service...`;
                }
            }
        }

        // Generic inference backend calls (non-OpenRouter)
        if (type === 'inference') {
            const backendLabel = log.meta?.backendLabel || 'inference backend';
            if (path.includes('/chat/completions')) {
                if (log.isAborted) {
                    return detailed
                        ? 'The model response was stopped by the user. The partial response has been saved and can be continued or regenerated.'
                        : 'Response interrupted by user';
                }

                if (!detailed) {
                    if (status >= 200 && status < 300) {
                        return 'Response received';
                    } else if (status === 0) {
                        return 'Inference request failed';
                    }
                    return 'Processing inference request';
                }

                if (status >= 200 && status < 300) {
                    const model = request?.body?.model || 'Unknown model';
                    return `Successfully processed your request using ${model} via ${backendLabel}. Response received and displayed in chat.`;
                } else if (status === 0) {
                    return 'Inference request failed. This may be due to network issues, invalid credentials, or model availability.';
                }

                const model = request?.body?.model || 'AI model';
                return `Sending your message to ${model} for processing through ${backendLabel}...`;
            }
        }

        // Verifier endpoint - station integrity verification
        if (type === 'verification' || urlObj.host === 'verifier2.openanonymity.ai' || urlObj.host.includes('localhost')) {
            const verificationDetail = log.detail || response?.detail;
            const isAttestationRequest = path.includes('/attestation');
            if (!detailed) {
                if (isAttestationRequest) {
                    if (status === 'queued' || status === 'pending') {
                        return 'Attesting verifier';
                    } else if (status >= 200 && status < 300) {
                        return 'Verifier attested';
                    } else if (status >= 400 || status === 0) {
                        return 'Verifier attestation failed';
                    }
                    return 'Attesting verifier';
                }
                if (verificationDetail === 'verifier_unreachable_uncertified') {
                    return 'Verifier temporarily unreachable';
                } else if (verificationDetail === 'key_near_expiry') {
                    return 'Key expires too soon to verify';
                }
                if (status === 'queued' || status === 'pending') {
                    return 'Verifying station integrity';
                } else if (status >= 200 && status < 300) {
                    return 'Verified station integrity';
                } else if (status >= 400 || status === 0) {
                    return 'Station verification failed';
                }
                return 'Verifying station integrity';
            } else {
                if (isAttestationRequest) {
                    if (status === 'queued' || status === 'pending') {
                        return 'Requesting fresh hardware attestation proof from the verifier.';
                    } else if (status >= 200 && status < 300) {
                        return 'Successfully attested the verifier.';
                    } else if (status >= 400 || status === 0) {
                        return 'Verifier attestation failed. The verifier may be unavailable or returned an invalid attestation response.';
                    }
                    return 'Attesting verifier hardware and policy integrity.';
                }
                if (verificationDetail === 'verifier_unreachable_uncertified') {
                    return 'The verifier could not be <a href="https://verifier2.openanonymity.ai/health" target="_blank" rel="noopener noreferrer" class="underline hover:text-amber-700 dark:hover:text-amber-300">reached</a> to verify this station, the key is rejected.';
                } else if (verificationDetail === 'ownership_check_error') {
                    return 'Verification temporarily unavailable due to verifier networking issues. The webapp will automatically retry in the background.';
                } else if (verificationDetail === 'rate_limited') {
                    return 'Verifier rate limited this request. The webapp will automatically retry in the background.';
                } else if (verificationDetail === 'key_near_expiry') {
                    return 'The API key expires too soon to perform ownership verification. This is expected behavior for keys near their expiry time. This should not occur unless the app delays verification or has been modified.';
                }
                if (status === 'queued' || status === 'pending') {
                    return 'The verifier is currently unreachable. Station integrity will be attested as soon as verifier comes <a href="https://verifier2.openanonymity.ai/health" target="_blank" rel="noopener noreferrer" class="underline hover:text-amber-700 dark:hover:text-amber-300">online</a>. You can continue sending messages normally because this station was recently attested by other users.';
                } else if (status >= 200 && status < 300) {
                    return 'Successfully verified the integrity of the key issuing station.';
                } else if (status >= 400 || status === 0) {
                    return 'Station verification failed. The station may not be registered or was rejected.';
                }
                return 'Verifying the issuing station\'s integrity against its registration record...';
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
    const { type, url, action } = log;

    // Handle local events
    if (type === 'local') {
        if (action === 'ticket-select') {
            // Checkmark/select icon for ticket selection
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
            </svg>`;
        } else if (action === 'tickets-blind') {
            // Shield/encrypt icon for blinding
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
            </svg>`;
        } else if (action === 'tickets-signed') {
            // Signature/pen icon for signing
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
            </svg>`;
        } else if (action === 'tickets-unblind') {
            // Unlock/reveal icon for unblinding
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"></path>
            </svg>`;
        } else if (action === 'prompt-edit') {
            // Pencil/edit icon for prompt editing
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
            </svg>`;
        } else if (action === 'session-fork') {
            // Branch/fork icon for conversation forking
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M2 12h6c6 0 10-4 14-8m-4 0h4v4M8 12c6 0 10 4 14 8m-4 0h4v-4"></path>
            </svg>`;
        }
        // Default local event icon (processor/chip)
        return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path>
        </svg>`;
    }

    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;

        // Verifier - shield checkmark icon for integrity verification
        if (urlObj.host === 'verifier2.openanonymity.ai') {
            return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>
            </svg>`;
        }

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

        // OpenRouter - models - TEMPORARILY COMMENTED OUT
        // if (type === 'openrouter' && path.includes('/models')) {
        //     return `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        //         <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"></path>
        //     </svg>`;
        // }

        // OpenRouter - chat (AI brain icon)
        if (type === 'openrouter' || type === 'inference') {
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
    // Escape log-derived strings before injecting into HTML.
    const descriptionRaw = getActivityDescription(log);
    const description = escapeHtml(descriptionRaw);
    const descriptionAttr = escapeHtmlAttribute(descriptionRaw);
    const icon = getActivityIcon(log);

    if (isMinimal && !isExpanded) {
        // Compact one-line view for floating panel - matches right panel
        return `
            <div class="px-3 py-1.5 border-b border-transparent flex items-center gap-1.5 hover:bg-muted/10 transition-colors text-xs">
                <span class="flex-shrink-0 text-muted-foreground">
                    ${icon}
                </span>
                <span class="truncate flex-1 font-medium" title="${descriptionAttr}">
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
                    <span class="truncate flex-1 font-medium" title="${descriptionAttr}">
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
                    <div class="text-xs text-foreground leading-relaxed">${escapeHtml(getActivityDescription(log, true))}</div>
                </div>

                <!-- Technical Summary -->
                <div class="px-3 py-3 space-y-2 text-xs">
                    <div class="flex items-center gap-2 text-[10px]">
                        <div class="flex items-center gap-1">
                            <span class="text-muted-foreground">Status:</span>
                            <span class="font-medium px-1.5 py-0.5 rounded text-[10px] ${
                                log.isAborted ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                                (log.status === 'queued' || log.status === 'pending') ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400' :
                                log.status >= 200 && log.status < 300 ? 'badge-status-success' :
                                log.status === 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                            }">
                                ${log.isAborted ? 'INTERRUPTED' : (log.status === 'queued' || log.status === 'pending') ? 'PENDING' : (log.status || 'ERROR')}
                            </span>
                        </div>
                        <div class="flex items-center gap-1">
                            <span class="text-muted-foreground">Method:</span>
                            <span class="font-medium px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded text-[10px]">${log.method}</span>
                        </div>
                    </div>

                    <div class="text-[10px] text-muted-foreground">
                        <div class="font-medium mb-0.5">Destination:</div>
                        <div class="font-mono break-all">${log.url}</div>
                    </div>

                    ${(log.status === 'queued' || log.status === 'pending') && log.response?.message ? `
                        <div class="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-1.5 rounded border border-amber-200 dark:border-amber-800/50">
                            ${log.response.message}
                        </div>
                    ` : log.error ? `
                        <div class="text-[10px] text-red-600 dark:text-red-400 bg-red-50/50 dark:bg-red-900/30 p-1.5 rounded border border-red-200/50 dark:border-red-800/50">
                            ${escapeHtml(log.error)}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    // Return empty string for non-minimal rendering (handled by RightPanel)
    return '';
}
