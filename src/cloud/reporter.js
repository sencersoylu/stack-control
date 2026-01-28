/**
 * CloudReporter - Cloud sync client for Stack Control
 *
 * Sends data to Supabase Edge Functions.
 * All operations are fire-and-forget with error logging.
 *
 * Supports two modes:
 * - Edge Functions: CLOUD_API_URL = https://xxx.supabase.co
 * - Express Server: CLOUD_API_URL = http://localhost:3100
 */

class CloudReporter {
    constructor(apiUrl, chamberKey) {
        this.apiUrl = apiUrl;
        this.chamberKey = chamberKey;
        this.enabled = !!(apiUrl && chamberKey);
        this.activeSessionId = null;

        // Detect if using Supabase Edge Functions or Express server
        this.isEdgeFunctions = apiUrl && apiUrl.includes('supabase.co');

        if (this.enabled) {
            const mode = this.isEdgeFunctions ? 'Edge Functions' : 'Express Server';
            console.log(`[CloudReporter] Enabled - ${mode}: ${apiUrl}`);
        } else {
            console.log('[CloudReporter] Disabled - Missing CLOUD_API_URL or CHAMBER_API_KEY');
        }
    }

    /**
     * Get the correct endpoint URL based on mode
     */
    _getUrl(endpoint) {
        if (this.isEdgeFunctions) {
            // Supabase Edge Functions: /functions/v1/function-name
            const functionMap = {
                '/api/heartbeat': '/functions/v1/heartbeat',
                '/api/sessions/start': '/functions/v1/sessions-start',
                '/api/alerts': '/functions/v1/alerts',
                '/api/patients/sync': '/functions/v1/patients-sync',
                '/api/chambers/config': '/functions/v1/chambers-config',
                '/api/chambers/register': '/functions/v1/chambers-register',
            };

            // Handle dynamic session end URL
            if (endpoint.startsWith('/api/sessions/') && endpoint.endsWith('/end')) {
                const sessionId = endpoint.split('/')[3];
                return `${this.apiUrl}/functions/v1/sessions-end?id=${sessionId}`;
            }

            return `${this.apiUrl}${functionMap[endpoint] || endpoint}`;
        } else {
            // Express server: /api/endpoint
            return `${this.apiUrl}${endpoint}`;
        }
    }

    /**
     * Make HTTP request to cloud service
     */
    async _request(method, endpoint, data = null) {
        if (!this.enabled) return null;

        try {
            const url = this._getUrl(endpoint);
            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Chamber-Key': this.chamberKey
                }
            };

            if (data) {
                options.body = JSON.stringify(data);
            }

            const response = await fetch(url, options);
            const result = await response.json();

            if (!result.success) {
                console.error(`[CloudReporter] ${endpoint} failed:`, result.error);
                return null;
            }

            return result.data;
        } catch (error) {
            console.error(`[CloudReporter] ${endpoint} error:`, error.message);
            return null;
        }
    }

    /**
     * Send heartbeat (chamber status)
     * Call every 30 seconds
     */
    async sendHeartbeat(data) {
        return this._request('POST', '/api/heartbeat', {
            pressure: data.pressure,
            pressureFsw: data.main_fsw || data.pressureFsw,
            o2: data.o2,
            temperature: data.temperature,
            humidity: data.humidity,
            co2: data.co2,
            sessionActive: data.status > 0,
            sessionStatus: data.status,
            sessionTime: data.zaman || data.sessionTime,
            targetPressure: data.hedef ? data.hedef / 33.4 : data.targetPressure,
            targetFsw: data.hedef || data.targetFsw,
            graphState: data.grafikdurum || data.graphState,
            compValvePosition: data.pcontrol || data.compValvePosition,
            chamberStatus: data.chamberStatus,
            chamberStatusText: data.chamberStatusText,
            plcConnected: data.plcConnected,
            pressRateFswPerMin: data.pressRateFswPerMin,
            pressRateBarPerMin: data.pressRateBarPerMin
        });
    }

    /**
     * Report session start
     * Returns cloud session ID
     */
    async reportSessionStart(data) {
        const result = await this._request('POST', '/api/sessions/start', {
            sessionNumber: data.sessionNumber || data.sessionCounter,
            targetDepth: data.setDerinlik || data.targetDepth,
            targetDepthFsw: (data.setDerinlik || data.targetDepth) * 33.4,
            diveDuration: data.dalisSuresi || data.diveDuration,
            exitDuration: data.cikisSuresi || data.exitDuration,
            totalPlannedDuration: data.toplamSure || data.totalPlannedDuration,
            speed: data.speed,
            operatorName: data.operatorName,
            patientId: data.patientId,
            profileData: data.profile
        });

        if (result) {
            this.activeSessionId = result.id;
            console.log(`[CloudReporter] Session started: ${result.id}`);
        }

        return result;
    }

    /**
     * Report session end
     */
    async reportSessionEnd(data) {
        if (!this.activeSessionId) {
            console.warn('[CloudReporter] No active session to end');
            return null;
        }

        const result = await this._request('PUT', `/api/sessions/${this.activeSessionId}/end`, {
            durationMinutes: Math.floor((data.zaman || data.sessionTime || 0) / 60),
            status: data.status || 'completed',
            completionReason: data.completionReason || 'normal',
            performanceScore: data.performanceScore,
            rmsError: data.rmsError,
            maxOvershoot: data.maxOvershoot,
            onTargetPercentage: data.onTargetPercentage,
            measurementData: data.measurementData,
            notes: data.notes
        });

        if (result) {
            console.log(`[CloudReporter] Session ended: ${this.activeSessionId}`);
            this.activeSessionId = null;
        }

        return result;
    }

    /**
     * Report an alert/alarm
     */
    async reportAlert(data) {
        return this._request('POST', '/api/alerts', {
            alertType: data.alertType || 'alarm',
            alertCode: data.type || data.alertCode,
            alertMessage: data.text || data.alertMessage,
            severity: data.severity || 'warning',
            sessionId: this.activeSessionId,
            sessionTime: data.sessionTime || data.zaman,
            sensorValues: data.sensorValues || {
                pressure: data.pressure,
                o2: data.o2,
                temperature: data.temperature,
                humidity: data.humidity,
                co2: data.co2
            }
        });
    }

    /**
     * Sync a patient record
     */
    async syncPatient(patient) {
        return this._request('POST', '/api/patients/sync', {
            localId: patient.id,
            fullName: patient.fullName,
            birthDate: patient.birthDate,
            gender: patient.gender,
            phone: patient.phone,
            email: patient.email,
            medicalNotes: patient.medicalNotes,
            contraindications: patient.contraindications
        });
    }

    /**
     * Sync chamber config
     */
    async syncConfig(config) {
        return this._request('PUT', '/api/chambers/config', {
            o2Point0Raw: config.o2Point0Raw,
            o2Point0Percentage: config.o2Point0Percentage,
            o2Point21Raw: config.o2Point21Raw,
            o2Point21Percentage: config.o2Point21Percentage,
            o2Point100Raw: config.o2Point100Raw,
            o2Point100Percentage: config.o2Point100Percentage,
            filterAlphaPressure: config.filterAlphaPressure,
            filterAlphaO2: config.filterAlphaO2,
            filterAlphaTemperature: config.filterAlphaTemperature,
            filterAlphaHumidity: config.filterAlphaHumidity,
            filterAlphaCo2: config.filterAlphaCo2,
            compOffset: config.compOffset,
            compGain: config.compGain,
            compDepth: config.compDepth,
            decompOffset: config.decompOffset,
            decompGain: config.decompGain,
            decompDepth: config.decompDepth,
            defaultDiveDuration: config.defaultDiveDuration,
            defaultExitDuration: config.defaultExitDuration,
            defaultTotalDuration: config.defaultTotalDuration,
            defaultSetDepth: config.defaultSetDepth,
            defaultSpeed: config.defaultSpeed
        });
    }

    /**
     * Check if cloud reporting is enabled
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * Get active cloud session ID
     */
    getActiveSessionId() {
        return this.activeSessionId;
    }
}

// Singleton instance
let instance = null;

function getCloudReporter() {
    if (!instance) {
        instance = new CloudReporter(
            process.env.CLOUD_API_URL,
            process.env.CHAMBER_API_KEY
        );
    }
    return instance;
}

module.exports = { CloudReporter, getCloudReporter };
