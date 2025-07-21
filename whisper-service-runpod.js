const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class WhisperServiceRunPod {
    constructor() {
        this.apiKey = null;
        this.endpointId = null;
        this.baseUrl = 'https://api.runpod.ai/v2';
        this.isConfigured = false;
        this.activeJobs = new Map();
    }

    async initialize(config) {
        this.apiKey = config.runpodApiKey;
        this.endpointId = config.whisperEndpointId; // Separate endpoint for Whisper
        
        if (!this.apiKey) {
            throw new Error('RunPod API key not configured');
        }
        
        if (!this.endpointId) {
            throw new Error('Whisper RunPod endpoint ID not configured');
        }
        
        this.isConfigured = true;
        return true;
    }

    async transcribeAudio(params) {
        if (!this.isConfigured) {
            throw new Error('Whisper RunPod service not initialized');
        }

        const { audioPath, modelSize = 'base', language = null, task = 'transcribe', wordTimestamps = true } = params;
        
        try {
            // Read audio file and convert to base64
            const audioBuffer = await fs.readFile(audioPath);
            const audioBase64 = audioBuffer.toString('base64');
            
            // Prepare payload
            const payload = {
                input: {
                    audio_base64: audioBase64,
                    model_size: modelSize,
                    language: language,
                    task: task,
                    word_timestamps: wordTimestamps,
                    vad_filter: true,
                    temperature: 0
                }
            };
            
            // Submit job to RunPod
            const jobId = await this.submitJob(payload);
            
            // Store job info for tracking
            this.activeJobs.set(jobId, {
                startTime: Date.now(),
                params: params,
                audioPath: audioPath
            });
            
            return { jobId, service: 'runpod' };
            
        } catch (error) {
            console.error('Error submitting transcription job:', error);
            throw error;
        }
    }

    async submitJob(payload) {
        try {
            const endpointUrl = `${this.baseUrl}/${this.endpointId}/run`;
            
            const response = await axios.post(
                endpointUrl,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000 // 30 second timeout for initial request
                }
            );

            if (response.data.id) {
                return response.data.id;
            } else {
                throw new Error('No job ID returned from RunPod');
            }
        } catch (error) {
            console.error('Error submitting job to RunPod:', error.response?.data || error.message);
            throw new Error(`Failed to submit job: ${error.response?.data?.error || error.message}`);
        }
    }

    async getJobStatus(jobId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/${this.endpointId}/status/${jobId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const data = response.data;
            
            if (data.status === 'COMPLETED') {
                this.activeJobs.delete(jobId);
                
                if (data.output && data.output.text) {
                    return {
                        status: 'success',
                        transcription: data.output.text,
                        segments: data.output.segments || [],
                        language: data.output.language,
                        duration: data.output.duration,
                        processingTime: data.output.transcription_time,
                        modelSize: data.output.model_size,
                        fullResponse: data.output
                    };
                } else if (data.output && data.output.error) {
                    return {
                        status: 'error',
                        error: data.output.error
                    };
                }
                
                throw new Error('Invalid response format from RunPod');
                
            } else if (data.status === 'FAILED') {
                this.activeJobs.delete(jobId);
                return {
                    status: 'error',
                    error: data.error || 'Transcription failed'
                };
            } else if (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS') {
                // Still processing
                const jobInfo = this.activeJobs.get(jobId);
                const elapsed = jobInfo ? (Date.now() - jobInfo.startTime) / 1000 : 0;
                
                return {
                    status: 'processing',
                    message: `Processing audio... (${Math.floor(elapsed)}s)`,
                    elapsed: elapsed
                };
            } else {
                // Unknown status
                return {
                    status: 'processing',
                    message: 'Processing...'
                };
            }
        } catch (error) {
            console.error('Error checking job status:', error.response?.data || error.message);
            
            // If it's a 404, the job might be completed and cleaned up
            if (error.response?.status === 404) {
                this.activeJobs.delete(jobId);
                return {
                    status: 'error',
                    error: 'Job not found - it may have expired'
                };
            }
            
            throw error;
        }
    }

    async testConnection() {
        try {
            // Test the endpoint health
            const response = await axios.get(
                `${this.baseUrl}/${this.endpointId}/health`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000
                }
            );
            return { success: true, message: 'Whisper endpoint is accessible' };
        } catch (error) {
            if (error.response?.status === 401) {
                return { success: false, error: 'Invalid API key' };
            } else if (error.response?.status === 404) {
                return { success: false, error: 'Endpoint not found' };
            }
            
            return { success: false, error: error.message };
        }
    }

    async estimateCost(audioPath) {
        try {
            // Get audio file size to estimate duration
            const stats = await fs.stat(audioPath);
            const fileSizeMB = stats.size / (1024 * 1024);
            
            // Rough estimate: 1 minute of audio ≈ 1MB for MP3
            const estimatedMinutes = fileSizeMB;
            
            // Whisper processing time estimates (on RTX 3060)
            const processingRatios = {
                'tiny': 0.05,    // 5% of audio duration
                'base': 0.1,     // 10% of audio duration
                'small': 0.15,   // 15% of audio duration
                'medium': 0.25,  // 25% of audio duration
                'large': 0.5     // 50% of audio duration
            };
            
            const estimates = {};
            const costPerHour = 0.24; // RTX 3060 cost
            
            for (const [model, ratio] of Object.entries(processingRatios)) {
                const processingMinutes = estimatedMinutes * ratio;
                const processingHours = processingMinutes / 60;
                const cost = processingHours * costPerHour;
                
                estimates[model] = {
                    processingTime: `${processingMinutes.toFixed(1)} minutes`,
                    estimatedCost: `$${cost.toFixed(4)}`
                };
            }
            
            return {
                audioSizeMB: fileSizeMB.toFixed(2),
                estimatedDuration: `${estimatedMinutes.toFixed(1)} minutes`,
                modelEstimates: estimates,
                gpuType: 'RTX 3060'
            };
        } catch (error) {
            return { error: error.message };
        }
    }

    async shutdown() {
        // Clean up any active jobs
        this.activeJobs.clear();
        this.isConfigured = false;
    }
}

module.exports = WhisperServiceRunPod;