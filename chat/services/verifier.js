/**
 * Station Verifier Service
 * Handles station verification status via broadcast endpoint and staleness tracking
 */

import networkLogger from './networkLogger.js';
import networkProxy from './networkProxy.js';

const VERIFIER_URL = 'https://verifier.openanonymity.ai';

// Staleness thresholds
const STALE_WARNING_MS = 60 * 1000;      // 1 minute - show orange indicator
const STALE_CRITICAL_MS = 10 * 60 * 1000; // 10 minutes - show warning modal

// Dynamic interval settings
const BASE_INTERVAL_MS = 60 * 1000;      // 60 seconds base interval
const MIN_INTERVAL_MS = 10 * 1000;       // 10 seconds minimum
const HIGH_ACTIVITY_INTERVAL_MS = 30 * 1000; // 30 seconds when active
const ACTIVITY_WINDOW_MS = 60 * 1000;    // 1 minute activity window
const HIGH_ACTIVITY_THRESHOLD = 2;       // 2+ requests = high activity

class StationVerifier {
    constructor() {
        // Verification state per station
        this.stationStates = new Map(); // stationId -> state
        
        // Current active station (for UI display)
        this.currentStationId = null;
        
        // Broadcast check interval
        this.broadcastCheckInterval = null;
        this.currentIntervalMs = BASE_INTERVAL_MS;
        
        // Verifier online status
        this.verifierOnline = null; // null = unknown, true = online, false = offline
        this.lastSuccessfulBroadcast = null;
        this.consecutiveFailures = 0;
        this.offlineWarningShown = false;
        
        // Last broadcast response (ground truth until next call)
        this.lastBroadcastData = null; // { verified_stations: [], banned_stations: [], timestamp: ... }
        
        // Callbacks for warnings
        this.onStaleWarning = null;
        this.onBannedWarning = null;
        this.onOfflineWarning = null;
        
        // Track which stations we've already shown warnings for (to avoid spam)
        this.warningShownFor = new Set();
        this.bannedWarningShownFor = new Set();
        
        // Cached attestation data
        this.attestationCache = null;
        this.attestationCacheTime = null;
        
        // Completion request tracking for dynamic interval
        this.completionRequests = []; // timestamps of recent completion requests
    }
    
    /**
     * Record a completion request (called from app.js when sending to OpenRouter)
     */
    recordCompletionRequest() {
        const now = Date.now();
        this.completionRequests.push(now);
        // Clean up old entries outside the activity window
        this.completionRequests = this.completionRequests.filter(t => now - t < ACTIVITY_WINDOW_MS);
        // Recalculate interval
        this.updateDynamicInterval();
    }
    
    /**
     * Calculate and update the broadcast check interval based on activity
     */
    updateDynamicInterval() {
        const now = Date.now();
        const recentRequests = this.completionRequests.filter(t => now - t < ACTIVITY_WINDOW_MS).length;
        
        let newInterval;
        if (recentRequests >= HIGH_ACTIVITY_THRESHOLD) {
            // High activity: use ratio based on request count
            // More requests = shorter interval (but not below MIN_INTERVAL_MS)
            const ratio = Math.max(0.5, 1 - (recentRequests - HIGH_ACTIVITY_THRESHOLD) * 0.1);
            newInterval = Math.max(MIN_INTERVAL_MS, Math.floor(HIGH_ACTIVITY_INTERVAL_MS * ratio));
        } else {
            newInterval = BASE_INTERVAL_MS;
        }
        
        // Only restart interval if it changed significantly
        if (Math.abs(newInterval - this.currentIntervalMs) > 5000) {
            console.log(`📊 Activity: ${recentRequests} requests in last minute, interval: ${newInterval/1000}s`);
            this.currentIntervalMs = newInterval;
            this.restartBroadcastInterval();
        }
    }
    
    /**
     * Restart the broadcast interval with current interval setting
     */
    restartBroadcastInterval() {
        if (this.broadcastCheckInterval && this._broadcastCheckFn) {
            clearInterval(this.broadcastCheckInterval);
            this.broadcastCheckInterval = setInterval(this._broadcastCheckFn, this.currentIntervalMs);
            console.log(`🔄 Broadcast interval updated to ${this.currentIntervalMs/1000}s`);
        }
    }

    /**
     * Initialize verifier - load persisted broadcast data and check verifier connectivity
     */
    async init() {
        console.log('🔄 Initializing verifier...');
        console.log(`  chatDB available: ${!!window.chatDB}`);
        
        // Load persisted broadcast data from database (ground truth)
        try {
            const broadcastData = await window.chatDB?.getSetting('lastBroadcastData');
            console.log(`  Raw broadcast data from DB:`, broadcastData);
            if (broadcastData) {
                this.lastBroadcastData = broadcastData;
                // Restore the lastSuccessfulBroadcast from stored data
                if (broadcastData.timestamp) {
                    this.lastSuccessfulBroadcast = broadcastData.timestamp;
                }
                console.log(`📋 Loaded broadcast data from database (${broadcastData.timestamp})`);
                
                // Apply verified stations
                if (broadcastData.verified_stations) {
                    for (const station of broadcastData.verified_stations) {
                        const state = this.getStationState(station.station_id);
                        state.registered = true;
                        state.trustworthy = true;
                        state.lastVerified = station.last_verified;
                        state.status = 'passed';
                        state.banned = false;
                    }
                    console.log(`  ✅ ${broadcastData.verified_stations.length} verified stations`);
                }
                
                // Apply banned stations
                if (broadcastData.banned_stations) {
                    for (const banned of broadcastData.banned_stations) {
                        const state = this.getStationState(banned.station_id);
                        state.banned = true;
                        state.banReason = banned.reason;
                        state.bannedAt = banned.banned_at;
                        state.status = 'banned';
                        state.trustworthy = false;
                    }
                    console.log(`  🚫 ${broadcastData.banned_stations.length} banned stations`);
                }
            }
        } catch (error) {
            console.warn('Could not load broadcast data from database:', error.message);
        }

        // Do initial broadcast check to verify connectivity (async, don't block)
        console.log('🔄 Checking verifier connectivity...');
        this.queryBroadcast().then(() => {
            console.log('✅ Verifier is online');
        }).catch((error) => {
            console.warn('⚠️ Verifier is offline:', error.message);
            // Mark as offline immediately on first failure during init
            // BUT keep the lastSuccessfulBroadcast and lastBroadcastData from database
            this.verifierOnline = false;
            if (this.lastSuccessfulBroadcast) {
                console.log(`📋 Using cached data from: ${this.lastSuccessfulBroadcast}`);
            }
        });
    }

    /**
     * Persist full broadcast data to database (ground truth)
     */
    async persistBroadcastData() {
        if (!this.lastBroadcastData) {
            console.warn('💾 No broadcast data to persist');
            return;
        }
        
        if (!window.chatDB) {
            console.warn('💾 chatDB not available for persistence');
            return;
        }
        
        try {
            await window.chatDB.saveSetting('lastBroadcastData', this.lastBroadcastData);
            const verified = this.lastBroadcastData.verified_stations?.length || 0;
            const banned = this.lastBroadcastData.banned_stations?.length || 0;
            console.log(`💾 Persisted broadcast data: ${verified} verified, ${banned} banned, timestamp: ${this.lastBroadcastData.timestamp}`);
        } catch (error) {
            console.error('❌ Could not persist broadcast data:', error.message, error);
        }
    }

    /**
     * Check if verifier is offline or unknown (for warning on sends)
     * Returns true if we haven't successfully contacted the verifier
     */
    isOffline() {
        // Offline if explicitly false OR if we've never successfully contacted (null after init attempt)
        return this.verifierOnline !== true;
    }

    /**
     * Check if verifier has ever been successfully contacted
     */
    hasEverConnected() {
        return this.lastSuccessfulBroadcast !== null;
    }

    /**
     * Get or create state for a station
     */
    getStationState(stationId) {
        if (!this.stationStates.has(stationId)) {
            this.stationStates.set(stationId, {
                status: 'none', // 'none' | 'passed' | 'failed' | 'banned'
                registered: null,
                trustworthy: null,
                banned: false,
                banReason: null,
                bannedAt: null,
                lastVerified: null,
                lastBroadcastCheck: null,
                error: null
            });
        }
        return this.stationStates.get(stationId);
    }

    /**
     * Get state for the current active station (for UI)
     */
    getState() {
        if (!this.currentStationId) {
            return {
                status: 'none',
                registered: null,
                trustworthy: null,
                banned: false,
                banReason: null,
                bannedAt: null,
                lastVerified: null,
                lastBroadcastCheck: null,
                error: null
            };
        }
        return { ...this.getStationState(this.currentStationId) };
    }

    /**
     * Get verifier status info
     */
    getVerifierStatus() {
        return {
            online: this.verifierOnline,
            lastSuccessfulBroadcast: this.lastSuccessfulBroadcast,
            consecutiveFailures: this.consecutiveFailures
        };
    }

    /**
     * Set the current active station (for UI display)
     * Also checks if station is banned and triggers warning
     */
    setCurrentStation(stationId, session = null) {
        this.currentStationId = stationId;
        window.dispatchEvent(new CustomEvent('verification-updated'));
        
        // Check if this station is already known to be banned
        const state = this.stationStates.get(stationId);
        if (state?.banned && this.onBannedWarning) {
            // Show warning when switching to a banned station
            // (Don't use bannedWarningShownFor here - always warn on session switch)
            this.onBannedWarning({
                stationId,
                reason: state.banReason,
                bannedAt: state.bannedAt,
                session
            });
        }
    }

    /**
     * Reset state for a station
     */
    resetState(stationId = null) {
        if (stationId) {
            this.stationStates.delete(stationId);
            this.warningShownFor.delete(stationId);
            this.bannedWarningShownFor.delete(stationId);
        } else if (this.currentStationId) {
            this.stationStates.delete(this.currentStationId);
            this.warningShownFor.delete(this.currentStationId);
            this.bannedWarningShownFor.delete(this.currentStationId);
        }
        window.dispatchEvent(new CustomEvent('verification-updated'));
    }

    /**
     * Set callback for stale verification warnings
     */
    setStaleWarningCallback(callback) {
        this.onStaleWarning = callback;
    }

    /**
     * Set callback for banned station warnings
     */
    setBannedWarningCallback(callback) {
        this.onBannedWarning = callback;
    }

    /**
     * Set callback for verifier offline warnings
     */
    setOfflineWarningCallback(callback) {
        this.onOfflineWarning = callback;
    }

    /**
     * Calculate staleness level for a station
     * Returns: 'fresh' | 'stale' | 'critical' | 'unverified' | 'banned'
     */
    getStalenessLevel(stationId) {
        const state = this.stationStates.get(stationId);
        if (!state) return 'unverified';
        
        if (state.banned) {
            return 'banned';
        }
        
        if (state.status === 'none' || !state.lastVerified) {
            return 'unverified';
        }
        
        if (state.status === 'failed' || !state.trustworthy) {
            return 'critical';
        }

        const timeSinceVerified = Date.now() - new Date(state.lastVerified).getTime();
        
        if (timeSinceVerified > STALE_CRITICAL_MS) {
            return 'critical';
        }
        if (timeSinceVerified > STALE_WARNING_MS) {
            return 'stale';
        }
        return 'fresh';
    }

    /**
     * Get human-readable time since last verification
     */
    getTimeSinceVerification(stationId) {
        const state = this.stationStates.get(stationId);
        if (!state || !state.lastVerified) {
            return null;
        }

        const diffMs = Date.now() - new Date(state.lastVerified).getTime();
        const diffMins = Math.floor(diffMs / 60000);
        
        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        
        return new Date(state.lastVerified).toLocaleDateString();
    }

    /**
     * Get human-readable time since last successful broadcast
     */
    getTimeSinceLastBroadcast() {
        if (!this.lastSuccessfulBroadcast) {
            return null;
        }

        const diffMs = Date.now() - new Date(this.lastSuccessfulBroadcast).getTime();
        const diffMins = Math.floor(diffMs / 60000);
        
        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        
        return new Date(this.lastSuccessfulBroadcast).toLocaleString();
    }

    /**
     * Get the last broadcast data (ground truth)
     */
    getLastBroadcastData() {
        return this.lastBroadcastData;
    }

    /**
     * Check if a station is banned based on cached broadcast data
     */
    isStationBanned(stationId) {
        if (!this.lastBroadcastData?.banned_stations) return false;
        return this.lastBroadcastData.banned_stations.some(s => s.station_id === stationId);
    }

    /**
     * Check if a station is verified based on cached broadcast data
     */
    isStationVerified(stationId) {
        if (!this.lastBroadcastData?.verified_stations) return false;
        return this.lastBroadcastData.verified_stations.some(s => s.station_id === stationId);
    }

    /**
     * Get current broadcast check interval in ms
     */
    getCurrentInterval() {
        return this.currentIntervalMs;
    }

    /**
     * Query broadcast endpoint to check all monitored stations
     * GET /broadcast
     */
    async queryBroadcast() {
        console.log('📡 Querying broadcast for station verification status...');

        try {
            const response = await networkProxy.fetch(
                `${VERIFIER_URL}/broadcast`,
                {},
                { bypassProxy: true }
            );

            const data = await response.json();

            // Note: Not logging broadcast polls to avoid cluttering activity panel

            if (!response.ok) {
                throw new Error(data.detail || `Broadcast query failed: ${response.status}`);
            }

            // Mark verifier as online
            this.verifierOnline = true;
            this.lastSuccessfulBroadcast = new Date().toISOString();
            this.consecutiveFailures = 0;
            this.offlineWarningShown = false;

            // Store full broadcast data as ground truth
            const { verified, banned } = this.parseBroadcastData(data);
            this.lastBroadcastData = {
                verified_stations: verified,
                banned_stations: banned,
                timestamp: this.lastSuccessfulBroadcast
            };
            
            // Apply to station states
            for (const station of verified) {
                const state = this.getStationState(station.station_id);
                state.registered = true;
                state.trustworthy = true;
                state.lastVerified = station.last_verified;
                state.status = 'passed';
                state.banned = false;
                state.banReason = null;
                state.bannedAt = null;
            }
            
            for (const station of banned) {
                const state = this.getStationState(station.station_id);
                state.banned = true;
                state.banReason = station.reason;
                state.bannedAt = station.banned_at;
                state.status = 'banned';
                state.trustworthy = false;
            }
            
            // Persist to database
            this.persistBroadcastData();

            console.log(`📡 Broadcast: ${verified.length} verified, ${banned.length} banned`);
            return data;
        } catch (error) {
            console.warn('⚠️ Broadcast query failed:', error.message);
            console.log(`📋 Keeping last successful broadcast data from: ${this.lastSuccessfulBroadcast || 'never'}`);
            
            // Track failures - but DO NOT overwrite lastSuccessfulBroadcast or lastBroadcastData
            this.consecutiveFailures++;
            
            // After 2 consecutive failures, consider verifier offline
            if (this.consecutiveFailures >= 2) {
                this.verifierOnline = false;
                
                // Trigger offline warning (only once until back online)
                if (!this.offlineWarningShown && this.onOfflineWarning) {
                    this.offlineWarningShown = true;
                    this.onOfflineWarning({
                        lastSuccessful: this.lastSuccessfulBroadcast,
                        timeSince: this.getTimeSinceLastBroadcast(),
                        error: error.message
                    });
                }
            }
            
            throw error;
        }
    }

    /**
     * Parse broadcast data to get verified and banned stations
     */
    parseBroadcastData(broadcastData) {
        // New format: { verified_stations: [...], banned_stations: [...] }
        if (broadcastData.verified_stations || broadcastData.banned_stations) {
            return {
                verified: broadcastData.verified_stations || [],
                banned: broadcastData.banned_stations || []
            };
        }
        // Legacy format: array or { stations: [...] }
        const stations = Array.isArray(broadcastData) ? broadcastData : (broadcastData.stations || []);
        return { verified: stations, banned: [] };
    }

    /**
     * Refresh status for current station from broadcast
     */
    async refreshStatus() {
        if (!this.currentStationId) return null;

        const state = this.getStationState(this.currentStationId);
        state.status = 'pending';
        window.dispatchEvent(new CustomEvent('verification-updated'));

        try {
            const broadcastData = await this.queryBroadcast();
            const { verified, banned } = this.parseBroadcastData(broadcastData);
            
            // Check if station is banned
            const bannedInfo = banned.find(s => s.station_id === this.currentStationId);
            if (bannedInfo) {
                state.banned = true;
                state.banReason = bannedInfo.reason;
                state.bannedAt = bannedInfo.banned_at;
                state.status = 'banned';
                state.trustworthy = false;
                state.lastBroadcastCheck = new Date().toISOString();
                state.error = null;
                // Broadcast data is persisted in queryBroadcast()
                window.dispatchEvent(new CustomEvent('verification-updated'));
                return state;
            }

            // Check if station is verified
            const stationInfo = verified.find(s => s.station_id === this.currentStationId);
            if (stationInfo && stationInfo.last_verified) {
                state.registered = true;
                state.trustworthy = true;
                state.banned = false;
                state.banReason = null;
                state.bannedAt = null;
                state.lastVerified = stationInfo.last_verified;
                state.status = 'passed';
                state.lastBroadcastCheck = new Date().toISOString();
                state.error = null;
            } else if (stationInfo) {
                state.registered = true;
                state.trustworthy = false;
                state.banned = false;
                state.lastVerified = null;
                state.status = 'none';
                state.lastBroadcastCheck = new Date().toISOString();
                state.error = null;
            } else {
                state.status = 'none';
                state.registered = false;
                state.banned = false;
                state.error = 'Station not found in broadcast';
            }

            window.dispatchEvent(new CustomEvent('verification-updated'));
            return state;
        } catch (error) {
            state.status = 'failed';
            state.error = error.message;
            window.dispatchEvent(new CustomEvent('verification-updated'));
            throw error;
        }
    }

    /**
     * Get attestation from verifier (running in enclave)
     * GET /attestation
     */
    async getAttestation(forceRefresh = false) {
        // Return cached if available and less than 5 minutes old
        if (!forceRefresh && this.attestationCache && this.attestationCacheTime) {
            const cacheAge = Date.now() - this.attestationCacheTime;
            if (cacheAge < 5 * 60 * 1000) {
                return this.attestationCache;
            }
        }

        console.log('🔐 Fetching attestation from verifier...');

        try {
            const response = await networkProxy.fetch(
                `${VERIFIER_URL}/attestation`,
                {},
                { bypassProxy: true }
            );

            const data = await response.json();

            networkLogger.logRequest({
                type: 'verification',
                method: 'GET',
                url: `${VERIFIER_URL}/attestation`,
                status: response.status,
                response: { summary: data.summary }
            });

            if (!response.ok) {
                throw new Error(data.detail || `Attestation fetch failed: ${response.status}`);
            }

            // Cache the result
            this.attestationCache = data;
            this.attestationCacheTime = Date.now();

            console.log('🔐 Attestation received:', data.summary);
            return data;
        } catch (error) {
            console.error('❌ Failed to get attestation:', error.message);

            networkLogger.logRequest({
                type: 'verification',
                method: 'GET',
                url: `${VERIFIER_URL}/attestation`,
                status: 0,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Submit key data to verifier for validation before AI inference
     * POST /submit_key
     * @param {object} keyData - Key data from org's /request_key response
     * @returns {Promise<{status: string, station_id: string, key_hash: string}>}
     */
    async submitKey(keyData) {
        console.log('🔐 Submitting key to verifier for validation...');

        const requestBody = {
            station_id: keyData.stationId,
            api_key: keyData.key,
            key_valid_till: keyData.expiresAt,
            station_signature: keyData.stationSignature,
            org_signature: keyData.orgSignature
        };

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
            
            const response = await networkProxy.fetch(
                `${VERIFIER_URL}/submit_key`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                },
                { bypassProxy: true }
            );
            
            clearTimeout(timeoutId);

            const data = await response.json();

            networkLogger.logRequest({
                type: 'verification',
                method: 'POST',
                url: `${VERIFIER_URL}/submit_key`,
                status: response.status,
                request: { station_id: keyData.stationId },
                response: data
            });

            if (!response.ok) {
                const errorMessage = data.error || data.detail || data.message || 'Verification failed';
                const error = new Error(errorMessage);
                
                // Attach detailed banned station info if available
                if (data.status === 'banned' && data.banned_station) {
                    error.status = 'banned';
                    error.bannedStation = {
                        stationId: data.banned_station.station_id,
                        publicKey: data.banned_station.public_key,
                        reason: data.banned_station.reason,
                        bannedAt: data.banned_station.banned_at
                    };
                }
                throw error;
            }

            console.log('✅ Key verified:', data.status);
            return data;
        } catch (error) {
            // Convert AbortError to user-friendly message
            const friendlyError = error.name === 'AbortError' 
                ? new Error('Verification request timed out. Please try again.')
                : error;
            
            console.error('❌ Key verification failed:', friendlyError.message);

            networkLogger.logRequest({
                type: 'verification',
                method: 'POST',
                url: `${VERIFIER_URL}/submit_key`,
                status: 0,
                request: { station_id: keyData.stationId },
                error: friendlyError.message
            });

            throw friendlyError;
        }
    }

    /**
     * Start periodic broadcast checks (every 60 seconds)
     * Only checks the current station for efficiency
     * @param {Function} getCurrentSession - callback to get the current session
     */
    startBroadcastCheck(getCurrentSession) {
        if (this.broadcastCheckInterval) {
            clearInterval(this.broadcastCheckInterval);
        }

        const checkBroadcast = async () => {
            // Only check if we have a current station
            if (!this.currentStationId) {
                try {
                    // Still query to update online status
                    await this.queryBroadcast();
                } catch (e) {
                    // Ignore - just checking connectivity
                }
                return;
            }

            try {
                const broadcastData = await this.queryBroadcast();
                const { verified, banned } = this.parseBroadcastData(broadcastData);
                const session = getCurrentSession();
                const stationId = this.currentStationId;

                const state = this.getStationState(stationId);
                state.lastBroadcastCheck = new Date().toISOString();

                // Check if current station is banned
                const bannedInfo = banned.find(s => s.station_id === stationId);
                if (bannedInfo) {
                    state.banned = true;
                    state.banReason = bannedInfo.reason;
                    state.bannedAt = bannedInfo.banned_at;
                    state.status = 'banned';
                    state.trustworthy = false;

                    // Broadcast data is already persisted in queryBroadcast()

                    // Trigger banned warning
                    if (this.onBannedWarning && !this.bannedWarningShownFor.has(stationId)) {
                        this.bannedWarningShownFor.add(stationId);
                        this.onBannedWarning({
                            stationId,
                            reason: bannedInfo.reason,
                            bannedAt: bannedInfo.banned_at,
                            session
                        });
                    }
                    window.dispatchEvent(new CustomEvent('verification-updated'));
                    return;
                }

                // Check if current station is verified
                const stationInfo = verified.find(s => s.station_id === stationId);
                if (stationInfo && stationInfo.last_verified) {
                    state.registered = true;
                    state.trustworthy = true;
                    state.banned = false;
                    state.banReason = null;
                    state.bannedAt = null;
                    state.lastVerified = stationInfo.last_verified;
                    state.status = 'passed';
                } else {
                    // Station not in verified list
                    state.registered = false;
                    state.trustworthy = false;
                    state.banned = false;
                    state.status = 'none';
                }

                // Check staleness for current station (only if session has valid key)
                const now = new Date();
                const hasValidKey = session?.apiKey &&
                    (!session.expiresAt || new Date(session.expiresAt * 1000) > now);
                
                if (!state.banned && hasValidKey) {
                    const staleness = this.getStalenessLevel(stationId);
                    if ((staleness === 'critical' || staleness === 'unverified') && this.onStaleWarning) {
                        if (!this.warningShownFor.has(stationId)) {
                            this.warningShownFor.add(stationId);
                            const timeSince = this.getTimeSinceVerification(stationId);
                            this.onStaleWarning({
                                stationId,
                                staleness,
                                timeSince,
                                session
                            });
                        }
                    } else if (staleness === 'fresh') {
                        this.warningShownFor.delete(stationId);
                    }
                }

                window.dispatchEvent(new CustomEvent('verification-updated'));
            } catch (error) {
                console.warn('⚠️ Broadcast check failed:', error.message);
                window.dispatchEvent(new CustomEvent('verification-updated'));
            }
        };

        // Store function for dynamic interval restarts
        this._broadcastCheckFn = checkBroadcast;
        
        // Check immediately on start
        checkBroadcast();

        // Start with base interval (will adjust dynamically based on activity)
        this.currentIntervalMs = BASE_INTERVAL_MS;
        this.broadcastCheckInterval = setInterval(checkBroadcast, this.currentIntervalMs);
        console.log(`🔄 Started periodic broadcast check (every ${this.currentIntervalMs/1000}s)`);
    }

    /**
     * Stop periodic broadcast checks
     */
    stopBroadcastCheck() {
        if (this.broadcastCheckInterval) {
            clearInterval(this.broadcastCheckInterval);
            this.broadcastCheckInterval = null;
            console.log('⏹️ Stopped broadcast check');
        }
    }
}

const stationVerifier = new StationVerifier();

if (typeof window !== 'undefined') {
    window.stationVerifier = stationVerifier;
}

export default stationVerifier;
