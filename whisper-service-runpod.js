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
        
        // Test the connection and log endpoint info
        console.log('Initializing Whisper RunPod service...');
        const testResult = await this.testConnection();
        if (!testResult.success) {
            console.error('Endpoint test failed:', testResult.error);
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
            
            // Try the most basic payload format first
            // The worker might expect a different structure
            const payload = {
                input: {
                    audio_base64: audioBase64,
                    model: modelSize
                }
            };
            
            console.log('Payload being sent (without audio data):', {
                input: {
                    ...payload.input,
                    audio_base64: '[BASE64 AUDIO DATA HIDDEN]'
                }
            });
            
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
            // Use /run for async execution
            const endpointUrl = `${this.baseUrl}/${this.endpointId}/run`;
            
            console.log('Submitting to RunPod Whisper endpoint...');
            const response = await axios.post(
                endpointUrl,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000 // 30 second timeout
                }
            );

            console.log('RunPod response:', JSON.stringify(response.data, null, 2));

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
            
            // Only log non-IN_QUEUE statuses to reduce noise
            if (data.status !== 'IN_QUEUE') {
                console.log('RunPod Whisper response:', JSON.stringify(data, null, 2));
            }
            
            if (data.status === 'COMPLETED') {
                this.activeJobs.delete(jobId);
                
                // According to RunPod docs, for COMPLETED jobs without output,
                // we might need to wait a moment for the output to be available
                // Let's do a single retry after a short delay
                if (!data.output && !data.outputs) {
                    console.log('COMPLETED but no output yet, waiting 2 seconds...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Try fetching again
                    const retryResponse = await axios.get(
                        `${this.baseUrl}/${this.endpointId}/status/${jobId}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${this.apiKey}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    
                    const retryData = retryResponse.data;
                    console.log('Retry response:', JSON.stringify(retryData, null, 2));
                    
                    if (retryData.output || retryData.outputs) {
                        return this.processWhisperOutput(retryData.output || retryData.outputs);
                    }
                }
                
                // Check for output in different possible locations
                const output = data.output || data.outputs || data.result;
                
                if (output) {
                    return this.processWhisperOutput(output);
                }
                
                // If still no output, log what we have
                console.log('COMPLETED status but no output found. Full response:', JSON.stringify(data, null, 2));
                
                // Let's check if the transcription might be at the top level
                if (data.transcription || data.text) {
                    return this.processWhisperOutput(data);
                }
                
                // Return error to avoid infinite polling
                return {
                    status: 'error',
                    error: 'Job completed but no transcription output found. The endpoint might not be configured correctly for RunPod Whisper worker.'
                };
                
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
            // First test the endpoint health
            console.log('Testing endpoint health...');
            const healthResponse = await axios.get(
                `${this.baseUrl}/${this.endpointId}/health`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000
                }
            );
            
            console.log('Health check response:', healthResponse.data);
            
            // Try to get endpoint info to see what image it's using
            try {
                const infoUrl = `https://api.runpod.io/v2/${this.endpointId}`;
                const infoResponse = await axios.get(infoUrl, {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log('Endpoint info:', JSON.stringify(infoResponse.data, null, 2));
            } catch (e) {
                console.log('Could not fetch endpoint info:', e.message);
            }
            
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

    processWhisperOutput(output) {
        // Handle different output formats from RunPod's Whisper
        if (typeof output === 'string') {
            return {
                status: 'success',
                transcription: output,
                segments: this.createSegmentsFromText(output)
            };
        } else if (output.text) {
            return {
                status: 'success',
                transcription: output.text,
                segments: output.segments || this.createSegmentsFromText(output.text),
                language: output.language,
                duration: output.duration
            };
        } else if (output.transcription) {
            return {
                status: 'success',
                transcription: output.transcription,
                segments: output.segments || this.createSegmentsFromText(output.transcription),
                language: output.language,
                duration: output.duration
            };
        } else if (output.error) {
            return {
                status: 'error',
                error: output.error
            };
        } else {
            // If output is an object with other structure, try to extract text
            const text = output.result || output.output || JSON.stringify(output);
            return {
                status: 'success',
                transcription: text,
                segments: this.createSegmentsFromText(text)
            };
        }
    }

    createSegmentsFromText(text) {
        // Create basic segments from plain text transcription
        // Split by sentences for basic segmentation
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        let currentTime = 0;
        const timePerChar = 0.05; // Rough estimate: 50ms per character
        
        return sentences.map((sentence, index) => {
            const duration = sentence.length * timePerChar;
            const segment = {
                id: index,
                start: currentTime,
                end: currentTime + duration,
                text: sentence.trim()
            };
            currentTime += duration;
            return segment;
        });
    }

    async shutdown() {
        // Clean up any active jobs
        this.activeJobs.clear();
        this.isConfigured = false;
    }
}

module.exports = WhisperServiceRunPod;