const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs').promises;

class FluxServiceRunPod {
    constructor() {
        this.apiKey = null;
        this.endpointId = null;
        this.baseUrl = 'https://api.runpod.ai/v2';
        this.isConfigured = false;
        this.modelPrecision = 'fp8';
        this.activeJobs = new Map();
        this.isRunPod = true; // Flag to identify this as RunPod service
        this.huggingfaceToken = null;
    }

    async initialize(config) {
        this.apiKey = config.runpodApiKey;
        this.endpointId = config.runpodEndpointId;
        this.modelPrecision = config.modelPrecision || 'fp8';
        this.huggingfaceToken = config.huggingfaceToken || null;
        
        if (!this.apiKey) {
            throw new Error('RunPod API key not configured');
        }

        // For now, skip automatic endpoint creation
        // Users need to provide endpoint ID manually
        this.isConfigured = true;
        return true;
    }

    async findOrCreateEndpoint() {
        try {
            // First, check if we already have a compatible endpoint
            const endpoints = await this.listEndpoints();
            const fluxEndpoint = endpoints.find(ep => 
                ep.name === 'audiobook-visualizer-flux' && 
                ep.status === 'READY'
            );

            if (fluxEndpoint) {
                return fluxEndpoint.id;
            }

            // Create a new endpoint if none exists
            return await this.createEndpoint();
        } catch (error) {
            console.error('Error finding/creating endpoint:', error);
            throw error;
        }
    }

    async listEndpoints() {
        const response = await axios.get(`${this.baseUrl}/endpoint`, {
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data || [];
    }

    async createEndpoint() {
        // For now, we'll use a pre-existing endpoint ID that the user provides
        // Creating endpoints programmatically requires specific template IDs from RunPod
        throw new Error('Please provide a RunPod endpoint ID in the configuration. You can create one at https://www.runpod.io/console/serverless');
    }

    async generateImage(params) {
        if (!this.isConfigured) {
            throw new Error('RunPod service not initialized');
        }

        const { prompt, width, height, steps, guidance, seed, sampler, scheduler, characterImages, modelPrecision } = params;
        
        // Use the model precision from params, falling back to the initialized value
        const actualModelPrecision = modelPrecision || this.modelPrecision;
        
        // Add the actual model precision to params for workflow creation
        const workflowParams = { ...params, modelPrecision: actualModelPrecision };

        // Create the appropriate workflow based on character count
        let workflow;
        if (!characterImages || characterImages.length === 0) {
            workflow = this.createTextToImageWorkflow(workflowParams);
        } else if (characterImages.length === 1) {
            workflow = await this.createKontextSingleWorkflow(workflowParams, characterImages[0]);
        } else {
            workflow = await this.createKontextWorkflow(workflowParams, characterImages);
        }

        // Submit job to RunPod
        const jobId = await this.submitJob(workflow);
        
        // Store job info for tracking
        this.activeJobs.set(jobId, {
            startTime: Date.now(),
            params: params
        });

        return jobId;
    }

    async submitJob(workflow) {
        // timpietruskyblibla/runpod-worker-comfy expects workflow as an object
        // Based on the worker documentation from GitHub
        
        const payload = {
            input: {
                workflow: workflow,  // Send as object, not string
                hf_token: this.huggingfaceToken  // Pass HF token if available
            }
        };

        // Log basic info for debugging if needed
        // console.log('Submitting workflow with', Object.keys(workflow).length, 'nodes');

        try {
            // RunPod uses direct endpoint URLs
            const endpointUrl = `https://api.runpod.ai/v2/${this.endpointId}/run`;
            // Submit job to endpoint
            
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
        if (!this.activeJobs.has(jobId)) {
            // Still check the status even if not in active jobs
            // Job not in active jobs list, but still check status
        }

        try {
            const response = await axios.get(
                `https://api.runpod.ai/v2/${this.endpointId}/status/${jobId}`,
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
                
                // Extract image data from output based on v5.0.0+ format
                if (data.output && data.output.images && data.output.images.length > 0) {
                    // v5.0.0+ format returns images as an array
                    const firstImage = data.output.images[0];
                    
                    if (firstImage.type === 'base64' && firstImage.data) {
                        return {
                            status: 'success',
                            image: firstImage.data,
                            filename: firstImage.filename || `runpod_${jobId}.png`
                        };
                    } else if (firstImage.type === 's3_url' && firstImage.data) {
                        // If S3 URL, we'd need to fetch it - for now just return the URL
                        return {
                            status: 'success',
                            imageUrl: firstImage.data,
                            filename: firstImage.filename || `runpod_${jobId}.png`
                        };
                    }
                } else if (data.output && data.output.message) {
                    // Legacy format (< v5.0.0)
                    return {
                        status: 'success',
                        image: data.output.message,
                        filename: `runpod_${jobId}.png`
                    };
                }
                
                throw new Error('No image data in completed job');
            } else if (data.status === 'FAILED') {
                this.activeJobs.delete(jobId);
                return {
                    status: 'error',
                    error: data.error || 'Job failed'
                };
            } else if (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS') {
                // Still processing
                return {
                    status: 'processing',
                    progress: 0 // RunPod doesn't provide detailed progress
                };
            } else {
                // Unknown status
                return {
                    status: 'processing',
                    progress: 0
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

    // Workflow creation methods (similar to flux-service-local.js)
    createTextToImageWorkflow(params) {
        const { prompt, width, height, steps, guidance, seed, sampler, scheduler, modelPrecision } = params;
        // Use the exact model names available on the RunPod endpoint
        // Based on the error logs, these are the available models:
        // Model name depends on precision setting
        const actualModelPrecision = modelPrecision || this.modelPrecision;
        const modelName = actualModelPrecision === 'fp16' ? 'flux1-kontext-dev-fp16.safetensors' : 'flux1-kontext-dev-fp8.safetensors';
        const t5ModelName = actualModelPrecision === 'fp16' ? 't5xxl_fp16.safetensors' : 't5xxl_fp8_e4m3fn.safetensors';

        return {
            "6": {
                "inputs": {
                    "text": prompt,
                    "clip": ["30", 0]
                },
                "class_type": "CLIPTextEncode"
            },
            "8": {
                "inputs": {
                    "samples": ["31", 0],
                    "vae": ["10", 0]
                },
                "class_type": "VAEDecode"
            },
            "9": {
                "inputs": {
                    "images": ["8", 0],
                    "filename_prefix": "ComfyUI"
                },
                "class_type": "SaveImage"
            },
            "10": {
                "inputs": {
                    "vae_name": "ae.safetensors"
                },
                "class_type": "VAELoader"
            },
            "27": {
                "inputs": {
                    "width": width,
                    "height": height,
                    "batch_size": 1
                },
                "class_type": "EmptySD3LatentImage"
            },
            "30": {
                "inputs": {
                    "clip_name1": t5ModelName,
                    "clip_name2": "clip_l.safetensors",
                    "type": "flux"
                },
                "class_type": "DualCLIPLoader"
            },
            "31": {
                "inputs": {
                    "seed": seed || Math.floor(Math.random() * 1000000),
                    "steps": steps,
                    "cfg": 1.0,
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                    "model": ["32", 0],
                    "positive": ["33", 0],
                    "negative": ["6", 0],
                    "latent_image": ["27", 0]
                },
                "class_type": "KSampler"
            },
            "32": {
                "inputs": {
                    "unet_name": modelName,
                    "weight_dtype": actualModelPrecision === 'fp16' ? "default" : "fp8_e4m3fn"
                },
                "class_type": "UNETLoader"
            },
            "33": {
                "inputs": {
                    "text": prompt,
                    "clip": ["30", 0]
                },
                "class_type": "CLIPTextEncode"
            }
        };
    }

    async createKontextWorkflow(params, characterImages) {
        const { prompt, width, height, steps, guidance, seed, sampler, scheduler, modelPrecision } = params;
        
        // Model names for RunPod deployment
        // Model name depends on precision setting
        const actualModelPrecision = modelPrecision || this.modelPrecision;
        const modelName = actualModelPrecision === 'fp16' ? 'flux1-kontext-dev-fp16.safetensors' : 'flux1-kontext-dev-fp8.safetensors';
        const t5ModelName = actualModelPrecision === 'fp16' ? 't5xxl_fp16.safetensors' : 't5xxl_fp8_e4m3fn.safetensors';
        
        const actualSeed = seed || Math.floor(Math.random() * 0xFFFFFFFF);
        
        // Upload character images first
        const char1Base64 = characterImages[0];
        const char2Base64 = characterImages[1];
        
        return {
            "1": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": char1Base64,
                    "upload": "image"
                }
            },
            "2": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": char2Base64,
                    "upload": "image"
                }
            },
            "3": {
                "class_type": "ImageStitch",
                "inputs": {
                    "image1": ["1", 0],
                    "image2": ["2", 0],
                    "direction": "right",
                    "match_image_size": true,
                    "spacing_width": 0,
                    "spacing_color": "white"
                }
            },
            "4": {
                "class_type": "FluxKontextImageScale",
                "inputs": {
                    "image": ["3", 0]
                }
            },
            "5": {
                "class_type": "VAELoader",
                "inputs": {
                    "vae_name": "ae.safetensors"
                }
            },
            "6": {
                "class_type": "VAEEncode",
                "inputs": {
                    "pixels": ["4", 0],
                    "vae": ["5", 0]
                }
            },
            "8": {
                "class_type": "DualCLIPLoader",
                "inputs": {
                    "clip_name1": "clip_l.safetensors",
                    "clip_name2": t5ModelName,
                    "type": "flux"
                }
            },
            "9": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": prompt,
                    "clip": ["8", 0]
                }
            },
            "10": {
                "class_type": "UNETLoader",
                "inputs": {
                    "unet_name": modelName,
                    "weight_dtype": actualModelPrecision === 'fp16' ? "default" : "fp8_e4m3fn"
                }
            },
            "11": {
                "class_type": "ReferenceLatent",
                "inputs": {
                    "conditioning": ["15", 0],
                    "latent": ["6", 0]
                }
            },
            "12": {
                "class_type": "ModelSamplingFlux",
                "inputs": {
                    "model": ["10", 0],
                    "max_shift": 1.15,
                    "base_shift": 0.5,
                    "width": 1024,
                    "height": 1024
                }
            },
            "13": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": actualSeed,
                    "steps": steps,
                    "cfg": 1.0,
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                    "model": ["12", 0],
                    "positive": ["14", 0],
                    "negative": ["9", 0],
                    "latent_image": ["6", 0]
                }
            },
            "14": {
                "class_type": "FluxGuidance",
                "inputs": {
                    "guidance": guidance,
                    "conditioning": ["11", 0]
                }
            },
            "15": {
                "class_type": "CLIPTextEncodeFlux",
                "inputs": {
                    "clip": ["8", 0],
                    "clip_l": prompt,
                    "t5xxl": prompt,
                    "guidance": guidance
                }
            },
            "16": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["13", 0],
                    "vae": ["5", 0]
                }
            },
            "17": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["16", 0],
                    "filename_prefix": "kontext_dual"
                }
            }
        };
    }

    async createKontextSingleWorkflow(params, characterImage) {
        const { prompt, width, height, steps, guidance, seed, sampler, scheduler, modelPrecision } = params;
        
        // Model names for RunPod deployment
        // Model name depends on precision setting
        const actualModelPrecision = modelPrecision || this.modelPrecision;
        const modelName = actualModelPrecision === 'fp16' ? 'flux1-kontext-dev-fp16.safetensors' : 'flux1-kontext-dev-fp8.safetensors';
        const t5ModelName = actualModelPrecision === 'fp16' ? 't5xxl_fp16.safetensors' : 't5xxl_fp8_e4m3fn.safetensors';
        
        const actualSeed = seed || Math.floor(Math.random() * 0xFFFFFFFF);

        return {
            "1": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": characterImage,
                    "upload": "image"
                }
            },
            "3": {
                "class_type": "VAELoader",
                "inputs": {
                    "vae_name": "ae.safetensors"
                }
            },
            "4": {
                "class_type": "VAEEncode",
                "inputs": {
                    "pixels": ["1", 0],
                    "vae": ["3", 0]
                }
            },
            "5": {
                "class_type": "DualCLIPLoader",
                "inputs": {
                    "clip_name1": "clip_l.safetensors",
                    "clip_name2": t5ModelName,
                    "type": "flux"
                }
            },
            "6": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": prompt,
                    "clip": ["5", 0]
                }
            },
            "7": {
                "class_type": "UNETLoader",
                "inputs": {
                    "unet_name": modelName,
                    "weight_dtype": actualModelPrecision === 'fp16' ? "default" : "fp8_e4m3fn"
                }
            },
            "8": {
                "class_type": "ReferenceLatent",
                "inputs": {
                    "conditioning": ["12", 0],
                    "latent": ["4", 0]
                }
            },
            "9": {
                "class_type": "ModelSamplingFlux",
                "inputs": {
                    "model": ["7", 0],
                    "max_shift": 1.15,
                    "base_shift": 0.5,
                    "width": 1024,
                    "height": 1024
                }
            },
            "10": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": actualSeed,
                    "steps": steps,
                    "cfg": 1.0,
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                    "model": ["9", 0],
                    "positive": ["11", 0],
                    "negative": ["6", 0],
                    "latent_image": ["4", 0]
                }
            },
            "11": {
                "class_type": "FluxGuidance",
                "inputs": {
                    "guidance": guidance,
                    "conditioning": ["8", 0]
                }
            },
            "12": {
                "class_type": "CLIPTextEncodeFlux",
                "inputs": {
                    "clip": ["5", 0],
                    "clip_l": prompt,
                    "t5xxl": prompt,
                    "guidance": guidance
                }
            },
            "13": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["10", 0],
                    "vae": ["3", 0]
                }
            },
            "14": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["13", 0],
                    "filename_prefix": "kontext_single"
                }
            }
        };
    }

    async uploadImage(base64Image) {
        // RunPod typically handles base64 images directly in the workflow
        // But if needed, this could upload to RunPod's storage
        return base64Image;
    }

    async editImage(params) {
        if (!this.isConfigured) {
            throw new Error('RunPod service not initialized');
        }

        const { prompt, image, width, height, steps, guidance, seed, sampler, scheduler, modelPrecision } = params;
        
        // Use the model precision from params, falling back to the initialized value
        const actualModelPrecision = modelPrecision || this.modelPrecision;
        
        // Create the edit workflow using Kontext single image
        const workflow = this.createEditImageWorkflow({
            ...params,
            modelPrecision: actualModelPrecision
        }, image);

        // Submit job to RunPod
        const jobId = await this.submitJob(workflow);
        
        // Store job info for tracking
        this.activeJobs.set(jobId, {
            startTime: Date.now(),
            params: params,
            type: 'edit'
        });

        return { jobId, service: 'runpod' };
    }

    createEditImageWorkflow(params, base64Image) {
        const { prompt, width, height, steps, guidance, seed, sampler, scheduler, modelPrecision } = params;
        
        // Model names for RunPod deployment
        const actualModelPrecision = modelPrecision || this.modelPrecision;
        const modelName = actualModelPrecision === 'fp16' ? 'flux1-kontext-dev-fp16.safetensors' : 'flux1-kontext-dev-fp8.safetensors';
        const t5ModelName = actualModelPrecision === 'fp16' ? 't5xxl_fp16.safetensors' : 't5xxl_fp8_e4m3fn.safetensors';
        
        const actualSeed = seed || Math.floor(Math.random() * 0xFFFFFFFF);

        return {
            "1": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": base64Image,
                    "upload": "image"
                }
            },
            "2": {
                "class_type": "VAELoader",
                "inputs": {
                    "vae_name": "ae.safetensors"
                }
            },
            "3": {
                "class_type": "VAEEncode",
                "inputs": {
                    "pixels": ["1", 0],
                    "vae": ["2", 0]
                }
            },
            "4": {
                "class_type": "DualCLIPLoader",
                "inputs": {
                    "clip_name1": "clip_l.safetensors",
                    "clip_name2": t5ModelName,
                    "type": "flux"
                }
            },
            "5": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": prompt,
                    "clip": ["4", 0]
                }
            },
            "6": {
                "class_type": "UNETLoader",
                "inputs": {
                    "unet_name": modelName,
                    "weight_dtype": actualModelPrecision === 'fp16' ? "default" : "fp8_e4m3fn"
                }
            },
            "7": {
                "class_type": "ModelSamplingFlux",
                "inputs": {
                    "model": ["6", 0],
                    "max_shift": 1.19,
                    "base_shift": 0.5,
                    "width": width || 1024,
                    "height": height || 1024
                }
            },
            "8": {
                "class_type": "ReferenceLatent",
                "inputs": {
                    "conditioning": ["5", 0],
                    "latent": ["3", 0]
                }
            },
            "9": {
                "class_type": "FluxGuidance",
                "inputs": {
                    "conditioning": ["8", 0],
                    "guidance": guidance || 3.5
                }
            },
            "10": {
                "class_type": "RandomNoise",
                "inputs": {
                    "noise_seed": actualSeed
                }
            },
            "11": {
                "class_type": "KSamplerSelect",
                "inputs": {
                    "sampler_name": sampler || "euler"
                }
            },
            "12": {
                "class_type": "BasicScheduler",
                "inputs": {
                    "scheduler": scheduler || "simple",
                    "steps": steps || 20,
                    "denoise": 1.0,
                    "model": ["7", 0]
                }
            },
            "13": {
                "class_type": "SamplerCustomAdvanced",
                "inputs": {
                    "noise": ["10", 0],
                    "guider": ["14", 0],
                    "sampler": ["11", 0],
                    "sigmas": ["12", 0],
                    "latent_image": ["3", 0]
                }
            },
            "14": {
                "class_type": "BasicGuider",
                "inputs": {
                    "model": ["7", 0],
                    "conditioning": ["9", 0]
                }
            },
            "15": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["13", 0],
                    "vae": ["2", 0]
                }
            },
            "16": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["15", 0],
                    "filename_prefix": "kontext_edit"
                }
            }
        };
    }

    async shutdown() {
        // Clean up any active jobs
        this.activeJobs.clear();
        this.isConfigured = false;
    }

    async verifyApiKey() {
        try {
            // Try to list endpoints to verify API key
            const response = await axios.get(`${this.baseUrl}/endpoint`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            const endpoints = response.data || [];
            // Successfully listed endpoints
            
            // Check if our endpoint is in the list
            if (this.endpointId && Array.isArray(endpoints)) {
                const ourEndpoint = endpoints.find(ep => ep.id === this.endpointId);
                if (ourEndpoint) {
                    return { 
                        success: true, 
                        message: `Endpoint "${ourEndpoint.name}" found and accessible`
                    };
                }
            }
            
            return { 
                success: true, 
                message: `API key is valid. Found ${endpoints.length} endpoints.`
            };
        } catch (error) {
            throw error;
        }
    }

    async testConnection() {
        try {
            // If we have an endpoint ID, test it directly
            if (this.endpointId) {
                // Try to verify the endpoint is accessible
                try {
                    const response = await axios.get(
                        `https://api.runpod.ai/v2/${this.endpointId}/health`,
                        {
                            headers: {
                                'Authorization': `Bearer ${this.apiKey}`,
                                'Content-Type': 'application/json'
                            },
                            timeout: 5000
                        }
                    );
                    return { success: true, message: 'Endpoint is accessible' };
                } catch (err) {
                    // If endpoint check fails, verify API key
                    return await this.verifyApiKey();
                }
            }
            
            // Otherwise, just verify the API key works by listing endpoints
            const response = await axios.get(`${this.baseUrl}/endpoint`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            const endpoints = response.data || [];
            return { 
                success: true, 
                message: `API key is valid. Found ${endpoints.length} endpoints.`,
                endpoints: endpoints
            };
        } catch (error) {
            // console.error('RunPod API test failed:', error.response?.data || error.message);
            
            if (error.response?.status === 401) {
                return { success: false, error: 'Invalid API key' };
            } else if (error.response?.status === 404) {
                return { success: false, error: `Endpoint not found (404). URL: ${error.config?.url}` };
            }
            
            return { success: false, error: error.response?.data?.error || error.message };
        }
    }

    async estimateCost(params) {
        // Estimate cost based on GPU type and expected runtime
        const { width, height, steps } = params;
        const pixels = width * height;
        const estimatedSeconds = Math.ceil((pixels * steps) / 1000000) + 30; // Rough estimate
        const costPerHour = 0.54; // RTX 3090 cost
        const estimatedCost = (estimatedSeconds / 3600) * costPerHour;
        
        return {
            estimatedSeconds,
            estimatedCost: estimatedCost.toFixed(4),
            gpuType: 'RTX 3090'
        };
    }
}

module.exports = FluxServiceRunPod;