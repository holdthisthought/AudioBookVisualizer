const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const WebSocket = require('ws');

class FluxServiceLocal {
    constructor(comfyUIManager) {
        this.comfyUIManager = comfyUIManager;
        this.comfyUIUrl = 'http://localhost:8188';
        this.clientId = crypto.randomUUID();
        this.jobs = new Map();
        this.downloadProgress = new Map();
    }

    // Queue a workflow prompt
    async queuePrompt(workflow) {
        const payload = {
            prompt: workflow,
            client_id: this.clientId
        };

        const response = await fetch(`${this.comfyUIUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to queue prompt: ${error}`);
        }

        const result = await response.json();
        return result.prompt_id;
    }

    // Upload an image to ComfyUI
    async uploadImage(imageData, filename) {
        const base64Data = imageData.split(',')[1] || imageData;
        const buffer = Buffer.from(base64Data, 'base64');

        return new Promise((resolve, reject) => {
            const http = require('http');
            const FormData = require('form-data');
            
            const formData = new FormData();
            
            // Append the image buffer directly
            formData.append('image', buffer, {
                filename: filename,
                contentType: 'image/png'
            });
            formData.append('type', 'input');
            formData.append('overwrite', 'true');

            // Parse the URL
            const url = new URL(`${this.comfyUIUrl}/upload/image`);
            
            const options = {
                method: 'POST',
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname,
                headers: formData.getHeaders()
            };

            const req = http.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const result = JSON.parse(data);
                            resolve(result.name || filename);
                        } catch (error) {
                            reject(new Error(`Failed to parse response: ${error.message}`));
                        }
                    } else {
                        reject(new Error(`Failed to upload image: ${res.statusCode} ${res.statusMessage}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            // Pipe form data to request
            formData.pipe(req);
        });
    }

    // Get workflow execution history
    async getHistory(promptId) {
        const response = await fetch(`${this.comfyUIUrl}/history/${promptId}`);
        if (!response.ok) {
            throw new Error('Failed to get history');
        }
        return await response.json();
    }

    // Download generated image
    async getImage(filename, subfolder, folderType) {
        const params = new URLSearchParams({
            filename,
            subfolder,
            type: folderType
        });

        const response = await fetch(`${this.comfyUIUrl}/view?${params}`);
        if (!response.ok) {
            throw new Error('Failed to get image');
        }

        // Convert response to buffer
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    // Monitor job completion with WebSocket
    async monitorJob(jobId, promptId, timeout = 600000) { // 10 minutes default for high-res
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let ws;
            let pollInterval;
            let isCompleted = false;
            
            const cleanup = () => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
                if (pollInterval) {
                    clearInterval(pollInterval);
                }
            };
            
            const checkCompletion = async () => {
                try {
                    const history = await this.getHistory(promptId);
                    
                    if (promptId in history) {
                        const promptHistory = history[promptId];
                        
                        // ComfyUI doesn't always set status.completed, check for outputs instead
                        const outputs = promptHistory.outputs;
                        
                        if (!outputs || Object.keys(outputs).length === 0) {
                            return false;
                        }
                        
                        // Find saved images
                        for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
                            if (nodeOutput.images && nodeOutput.images.length > 0) {
                                const image = nodeOutput.images[0];
                                
                                const imageData = await this.getImage(
                                    image.filename,
                                    image.subfolder,
                                    image.type
                                );
                                
                                this.jobs.set(jobId, {
                                    status: 'completed',
                                    imageData,
                                    filename: image.filename
                                });
                                
                                isCompleted = true;
                                cleanup();
                                resolve({
                                    status: 'completed',
                                    imageData
                                });
                                return true;
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error checking completion:', error);
                }
                return false;
            };
            
            // Set up WebSocket for real-time updates
            try {
                ws = new WebSocket(`ws://localhost:8188/ws?clientId=${this.clientId}`);
                
                ws.on('open', () => {
                    // WebSocket connected successfully
                });
                
                ws.on('message', async (data) => {
                    try {
                        const message = JSON.parse(data);
                        
                        if (message.type === 'executing') {
                            const nodeId = message.data.node;
                            const promptIdFromMsg = message.data.prompt_id;
                            
                            if (promptIdFromMsg === promptId) {
                                if (nodeId === null) {
                                    // Execution finished
                                    // Give ComfyUI a moment to save the image
                                    setTimeout(async () => {
                                        await checkCompletion();
                                    }, 1000);
                                }
                            }
                        } else if (message.type === 'executed') {
                            // Node execution completed
                        } else if (message.type === 'progress') {
                            // Progress updates (can be used for progress bars in future)
                        }
                    } catch (error) {
                        console.error('Error processing WebSocket message:', error);
                    }
                });
                
                ws.on('error', (error) => {
                    console.error('WebSocket error:', error);
                });
                
                ws.on('close', () => {
                    // WebSocket connection closed
                });
            } catch (error) {
                console.error('Failed to create WebSocket:', error);
            }
            
            // Also poll as backup
            pollInterval = setInterval(async () => {
                if (isCompleted) {
                    return;
                }
                
                // Check timeout
                if (Date.now() - startTime > timeout) {
                    this.jobs.set(jobId, {
                        status: 'failed',
                        error: 'Generation timeout'
                    });
                    cleanup();
                    reject(new Error('Generation timeout'));
                    return;
                }
                
                // Check completion
                await checkCompletion();
            }, 2000); // Check every 2 seconds
            
            // Initial check
            setTimeout(() => checkCompletion(), 1000);
        });
    }

    // Create text-to-image workflow
    createTextToImageWorkflow(params) {
        const modelName = params.modelPrecision === 'fp8' 
            ? 'flux1-dev-kontext_fp8_scaled.safetensors'
            : 'flux1-kontext-dev.safetensors';
            
        const t5Model = params.modelPrecision === 'fp8'
            ? 't5xxl_fp8_e4m3fn_scaled.safetensors'
            : 't5xxl_fp16.safetensors';

        const seed = params.seed || Math.floor(Math.random() * 0xFFFFFFFF);

        return {
            "unet_loader": {
                "class_type": "UNETLoader",
                "inputs": {
                    "unet_name": modelName,
                    "weight_dtype": "default"
                }
            },
            "clip_loader": {
                "class_type": "DualCLIPLoader",
                "inputs": {
                    "clip_name1": t5Model,
                    "clip_name2": "clip_l.safetensors",
                    "type": "flux",
                    "device": "default"
                }
            },
            "vae_loader": {
                "class_type": "VAELoader",
                "inputs": {
                    "vae_name": "ae.safetensors"
                }
            },
            "model_sampling": {
                "class_type": "ModelSamplingFlux",
                "inputs": {
                    "model": ["unet_loader", 0],
                    "width": params.width,
                    "height": params.height,
                    "max_shift": 0.99,
                    "base_shift": 0.5
                }
            },
            "clip_encode": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": params.prompt,
                    "clip": ["clip_loader", 0]
                }
            },
            "flux_guidance": {
                "class_type": "FluxGuidance",
                "inputs": {
                    "conditioning": ["clip_encode", 0],
                    "guidance": params.guidance
                }
            },
            "empty_latent": {
                "class_type": "EmptySD3LatentImage",
                "inputs": {
                    "width": params.width,
                    "height": params.height,
                    "batch_size": 1
                }
            },
            "guider": {
                "class_type": "BasicGuider",
                "inputs": {
                    "model": ["model_sampling", 0],
                    "conditioning": ["flux_guidance", 0]
                }
            },
            "sampler_select": {
                "class_type": "KSamplerSelect",
                "inputs": {
                    "sampler_name": params.sampler
                }
            },
            "scheduler": {
                "class_type": "BasicScheduler",
                "inputs": {
                    "model": ["model_sampling", 0],
                    "scheduler": params.scheduler,
                    "steps": params.steps,
                    "denoise": 1.0
                }
            },
            "noise": {
                "class_type": "RandomNoise",
                "inputs": {
                    "noise_seed": seed,
                    "noise_mode": "GPU(=A1111)"
                }
            },
            "sampler": {
                "class_type": "SamplerCustomAdvanced",
                "inputs": {
                    "noise": ["noise", 0],
                    "guider": ["guider", 0],
                    "sampler": ["sampler_select", 0],
                    "sigmas": ["scheduler", 0],
                    "latent_image": ["empty_latent", 0]
                }
            },
            "vae_decode": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["sampler", 0],
                    "vae": ["vae_loader", 0]
                }
            },
            "save_image": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["vae_decode", 0],
                    "filename_prefix": "flux_generated"
                }
            }
        };
    }

    // Create Kontext workflow
    createKontextWorkflow(params, char1Filename, char2Filename) {
        const modelName = params.modelPrecision === 'fp8' 
            ? 'flux1-dev-kontext_fp8_scaled.safetensors'
            : 'flux1-kontext-dev.safetensors';
            
        const textEncoder = params.modelPrecision === 'fp8'
            ? 't5xxl_fp8_e4m3fn_scaled.safetensors'
            : 't5xxl_fp16.safetensors';

        const seed = params.seed || Math.floor(Math.random() * 0xFFFFFFFF);

        return {
            "1": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": char1Filename
                }
            },
            "2": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": char2Filename
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
            "7": {
                "class_type": "DualCLIPLoader",
                "inputs": {
                    "clip_name1": "clip_l.safetensors",
                    "clip_name2": textEncoder,
                    "type": "flux",
                    "device": "default"
                }
            },
            "8": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": params.prompt,
                    "clip": ["7", 0]
                }
            },
            "9": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "",
                    "clip": ["7", 0]
                }
            },
            "10": {
                "class_type": "UNETLoader",
                "inputs": {
                    "unet_name": modelName,
                    "weight_dtype": "default"
                }
            },
            "11": {
                "class_type": "ModelSamplingFlux",
                "inputs": {
                    "model": ["10", 0],
                    "max_shift": 1.19,
                    "base_shift": 0.5,
                    "width": params.width,
                    "height": params.height
                }
            },
            "12": {
                "class_type": "ReferenceLatent",
                "inputs": {
                    "conditioning": ["8", 0],
                    "latent": ["6", 0]
                }
            },
            "13": {
                "class_type": "FluxGuidance",
                "inputs": {
                    "conditioning": ["12", 0],
                    "guidance": params.guidance
                }
            },
            "14": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["11", 0],
                    "positive": ["13", 0],
                    "negative": ["9", 0],
                    "latent_image": ["6", 0],
                    "seed": seed,
                    "steps": params.steps,
                    "cfg": 1.0,
                    "sampler_name": "euler",
                    "scheduler": "simple",
                    "denoise": 1.0
                }
            },
            "15": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["14", 0],
                    "vae": ["5", 0]
                }
            },
            "16": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["15", 0],
                    "filename_prefix": "kontext_fusion"
                }
            }
        };
    }

    // Create single character Kontext workflow
    createKontextSingleWorkflow(params, charFilename) {
        const modelName = params.modelPrecision === 'fp8' 
            ? 'flux1-dev-kontext_fp8_scaled.safetensors'
            : 'flux1-kontext-dev.safetensors';
            
        const textEncoder = params.modelPrecision === 'fp8'
            ? 't5xxl_fp8_e4m3fn_scaled.safetensors'
            : 't5xxl_fp16.safetensors';

        const seed = params.seed || Math.floor(Math.random() * 0xFFFFFFFF);

        return {
            "1": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": charFilename
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
            "4b": {
                "class_type": "EmptySD3LatentImage",
                "inputs": {
                    "width": params.width,
                    "height": params.height,
                    "batch_size": 1
                }
            },
            "5": {
                "class_type": "DualCLIPLoader",
                "inputs": {
                    "clip_name1": "clip_l.safetensors",
                    "clip_name2": textEncoder,
                    "type": "flux",
                    "device": "default"
                }
            },
            "6": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": params.prompt,
                    "clip": ["5", 0]
                }
            },
            "7": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "",
                    "clip": ["5", 0]
                }
            },
            "8": {
                "class_type": "UNETLoader",
                "inputs": {
                    "unet_name": modelName,
                    "weight_dtype": "default"
                }
            },
            "9": {
                "class_type": "ModelSamplingFlux",
                "inputs": {
                    "model": ["8", 0],
                    "max_shift": 1.19,
                    "base_shift": 0.5,
                    "width": params.width,
                    "height": params.height
                }
            },
            "10": {
                "class_type": "ReferenceLatent",
                "inputs": {
                    "conditioning": ["6", 0],
                    "latent": ["4", 0]
                }
            },
            "11": {
                "class_type": "FluxGuidance",
                "inputs": {
                    "conditioning": ["10", 0],
                    "guidance": params.guidance
                }
            },
            "12": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["9", 0],
                    "positive": ["11", 0],
                    "negative": ["7", 0],
                    "latent_image": ["4b", 0],
                    "seed": seed,
                    "steps": params.steps || 20,
                    "cfg": 1,
                    "sampler_name": params.sampler || "euler",
                    "scheduler": "beta",
                    "denoise": 1
                }
            },
            "13": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["12", 0],
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

    // Create edit image workflow
    createEditImageWorkflow(params, imageFilename) {
        const modelName = params.modelPrecision === 'fp8' 
            ? 'flux1-dev-kontext_fp8_scaled.safetensors'
            : 'flux1-kontext-dev.safetensors';
            
        const textEncoder = params.modelPrecision === 'fp8'
            ? 't5xxl_fp8_e4m3fn_scaled.safetensors'
            : 't5xxl_fp16.safetensors';

        const seed = params.seed || Math.floor(Math.random() * 0xFFFFFFFF);

        return {
            "1": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": imageFilename
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
                    "clip_name2": textEncoder,
                    "type": "flux",
                    "device": "default"
                }
            },
            "5": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": params.prompt,
                    "clip": ["4", 0]
                }
            },
            "6": {
                "class_type": "UNETLoader",
                "inputs": {
                    "unet_name": modelName,
                    "weight_dtype": "default"
                }
            },
            "7": {
                "class_type": "ModelSamplingFlux",
                "inputs": {
                    "model": ["6", 0],
                    "max_shift": 1.19,
                    "base_shift": 0.5,
                    "width": params.width,
                    "height": params.height
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
                    "guidance": params.guidance
                }
            },
            "10": {
                "class_type": "RandomNoise",
                "inputs": {
                    "noise_seed": seed
                }
            },
            "11": {
                "class_type": "KSamplerSelect",
                "inputs": {
                    "sampler_name": "euler"
                }
            },
            "12": {
                "class_type": "BasicScheduler",
                "inputs": {
                    "scheduler": "simple",
                    "steps": params.steps,
                    "denoise": 1.0,
                    "model": ["7", 0]
                }
            },
            "13": {
                "class_type": "BasicGuider",
                "inputs": {
                    "model": ["7", 0],
                    "conditioning": ["9", 0]
                }
            },
            "14": {
                "class_type": "SamplerCustomAdvanced",
                "inputs": {
                    "noise": ["10", 0],
                    "guider": ["13", 0],
                    "sampler": ["11", 0],
                    "sigmas": ["12", 0],
                    "latent_image": ["3", 0]
                }
            },
            "15": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["14", 0],
                    "vae": ["2", 0]
                }
            },
            "16": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["15", 0],
                    "filename_prefix": "edited_character"
                }
            }
        };
    }

    // Generate text-to-image
    async generateTextToImage(params) {
        const jobId = crypto.randomUUID();
        
        try {
            const workflow = this.createTextToImageWorkflow(params);
            const promptId = await this.queuePrompt(workflow);
            
            this.jobs.set(jobId, {
                promptId,
                status: 'queued',
                created: new Date().toISOString()
            });
            
            // Start monitoring in background
            this.monitorJob(jobId, promptId).catch(error => {
                console.error('Error monitoring job:', error);
                this.jobs.set(jobId, {
                    status: 'failed',
                    error: error.message
                });
            });
            
            return { job_id: jobId, status: 'queued' };
        } catch (error) {
            this.jobs.set(jobId, {
                status: 'failed',
                error: error.message
            });
            throw error;
        }
    }

    // Generate Kontext image
    async generateKontext(params) {
        const jobId = crypto.randomUUID();
        
        try {
            // Upload character images
            const char1Filename = await this.uploadImage(
                params.characterImage1, 
                `kontext_char1_${jobId}.png`
            );
            const char2Filename = await this.uploadImage(
                params.characterImage2, 
                `kontext_char2_${jobId}.png`
            );
            
            const workflow = this.createKontextWorkflow(params, char1Filename, char2Filename);
            const promptId = await this.queuePrompt(workflow);
            
            this.jobs.set(jobId, {
                promptId,
                status: 'queued',
                created: new Date().toISOString()
            });
            
            // Start monitoring in background
            this.monitorJob(jobId, promptId).catch(error => {
                console.error('Error monitoring job:', error);
                this.jobs.set(jobId, {
                    status: 'failed',
                    error: error.message
                });
            });
            
            return { job_id: jobId, status: 'queued' };
        } catch (error) {
            this.jobs.set(jobId, {
                status: 'failed',
                error: error.message
            });
            throw error;
        }
    }

    // Single character Kontext generation
    async generateKontextSingle(params) {
        const jobId = crypto.randomUUID();
        
        try {
            // Upload single character image
            const charFilename = await this.uploadImage(
                params.characterImage, 
                `kontext_single_${jobId}.png`
            );
            
            const workflow = this.createKontextSingleWorkflow(params, charFilename);
            const promptId = await this.queuePrompt(workflow);
            
            this.jobs.set(jobId, {
                promptId,
                status: 'queued',
                created: new Date().toISOString()
            });
            
            // Start monitoring in background
            this.monitorJob(jobId, promptId).catch(error => {
                console.error('Error monitoring job:', error);
                this.jobs.set(jobId, {
                    status: 'failed',
                    error: error.message
                });
            });
            
            return { job_id: jobId, status: 'queued' };
        } catch (error) {
            this.jobs.set(jobId, {
                status: 'failed',
                error: error.message
            });
            throw error;
        }
    }

    // Edit image
    async editImage(params) {
        const jobId = crypto.randomUUID();
        
        try {
            const imageFilename = await this.uploadImage(
                params.image, 
                `edit_${jobId}.png`
            );
            
            const workflow = this.createEditImageWorkflow(params, imageFilename);
            const promptId = await this.queuePrompt(workflow);
            
            this.jobs.set(jobId, {
                promptId,
                status: 'queued',
                created: new Date().toISOString()
            });
            
            // Start monitoring in background
            this.monitorJob(jobId, promptId).catch(error => {
                console.error('Error monitoring job:', error);
                this.jobs.set(jobId, {
                    status: 'failed',
                    error: error.message
                });
            });
            
            return { job_id: jobId, status: 'queued' };
        } catch (error) {
            this.jobs.set(jobId, {
                status: 'failed',
                error: error.message
            });
            throw error;
        }
    }

    // Get job status
    getJobStatus(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) {
            return { status: 'not_found' };
        }
        return job;
    }

    // Get job image
    getJobImage(jobId) {
        const job = this.jobs.get(jobId);
        if (!job || job.status !== 'completed' || !job.imageData) {
            return null;
        }
        return job.imageData;
    }

    // Get model status
    async getModelsStatus() {
        const modelPaths = this.comfyUIManager.getModelPaths();
        if (!modelPaths) {
            return {};
        }

        const models = {
            "flux_kontext": {
                "name": "FLUX.1 Kontext Dev",
                "filename": "flux1-kontext-dev.safetensors",
                "size": "23.8GB",
                "available": false,
                "downloading": false,
                "progress": 0,
                "url": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev/resolve/main/flux1-kontext-dev.safetensors",
                "requires_auth": true
            },
            "flux_kontext_fp8": {
                "name": "FLUX.1 Kontext Dev FP8 (Community)",
                "filename": "flux1-dev-kontext_fp8_scaled.safetensors",
                "size": "11.9GB",
                "available": false,
                "downloading": false,
                "progress": 0,
                "url": "https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors",
                "requires_auth": false
            },
            "clip_l": {
                "name": "CLIP-L",
                "filename": "clip_l.safetensors",
                "size": "246MB",
                "available": false,
                "downloading": false,
                "progress": 0,
                "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
                "requires_auth": false
            },
            "t5xxl_fp8": {
                "name": "T5-XXL FP8",
                "filename": "t5xxl_fp8_e4m3fn_scaled.safetensors",
                "size": "5.16GB",
                "available": false,
                "downloading": false,
                "progress": 0,
                "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors",
                "requires_auth": false
            },
            "t5xxl_fp16": {
                "name": "T5-XXL FP16",
                "filename": "t5xxl_fp16.safetensors",
                "size": "9.8GB",
                "available": false,
                "downloading": false,
                "progress": 0,
                "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors",
                "requires_auth": false
            },
            "ae": {
                "name": "VAE/AutoEncoder",
                "filename": "ae.safetensors",
                "size": "335MB",
                "available": false,
                "downloading": false,
                "progress": 0,
                "url": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev/resolve/main/ae.safetensors",
                "requires_auth": true
            }
        };

        // Check file existence
        for (const [key, model] of Object.entries(models)) {
            let filepath;
            if (key.includes('flux_kontext')) {
                // Check both unet and diffusion_models directories
                filepath = path.join(modelPaths.unet, model.filename);
                if (!fs.existsSync(filepath)) {
                    filepath = path.join(modelPaths.diffusion_models, model.filename);
                }
            } else if (key.includes('clip') || key.includes('t5')) {
                filepath = path.join(modelPaths.clip, model.filename);
            } else if (key === 'ae') {
                filepath = path.join(modelPaths.vae, model.filename);
            }

            if (filepath && fs.existsSync(filepath)) {
                models[key].available = true;
            }

            // Check download status
            const downloadStatus = this.downloadProgress.get(key);
            if (downloadStatus) {
                models[key].downloading = downloadStatus.downloading;
                models[key].progress = downloadStatus.progress;
                if (downloadStatus.error) {
                    models[key].error = downloadStatus.error;
                }
            }
        }

        return models;
    }

    // Download model
    async downloadModel(modelKey, hfToken, progressCallback) {
        const models = await this.getModelsStatus();
        const model = models[modelKey];
        
        if (!model) {
            throw new Error('Model not found');
        }
        
        if (model.available) {
            return { status: 'already_available' };
        }
        
        if (this.downloadProgress.get(modelKey)?.downloading) {
            return { status: 'already_downloading' };
        }

        const modelPaths = this.comfyUIManager.getModelPaths();
        let targetPath;
        
        if (modelKey.includes('flux_kontext')) {
            targetPath = path.join(modelPaths.unet, model.filename);
        } else if (modelKey.includes('clip') || modelKey.includes('t5')) {
            targetPath = path.join(modelPaths.clip, model.filename);
        } else if (modelKey === 'ae') {
            targetPath = path.join(modelPaths.vae, model.filename);
        }

        // Start download
        this.downloadProgress.set(modelKey, { downloading: true, progress: 0 });

        try {
            return await new Promise((resolve, reject) => {
                const url = new URL(model.url);
                const options = {
                    hostname: url.hostname,
                    path: url.pathname + url.search,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'AudioBookVisualizer/1.0'
                    }
                };

                if (model.requires_auth && hfToken) {
                    options.headers['Authorization'] = `Bearer ${hfToken}`;
                }

                const fileStream = fs.createWriteStream(`${targetPath}.tmp`);
                let downloadedSize = 0;
                let totalSize = 0;

                const request = https.get(options, (response) => {
                    if (response.statusCode === 302 || response.statusCode === 301 || response.statusCode === 307 || response.statusCode === 308) {
                        // Handle redirect
                        fileStream.close();
                        if (fs.existsSync(`${targetPath}.tmp`)) {
                            fs.unlinkSync(`${targetPath}.tmp`);
                        }
                        
                        const redirectUrl = response.headers.location;
                        console.log(`Following redirect to: ${redirectUrl}`);
                        
                        // Download from redirect URL
                        const redirectOptions = new URL(redirectUrl);
                        const redirectReq = https.get(redirectUrl, (redirectResponse) => {
                            if (redirectResponse.statusCode !== 200) {
                                if (redirectResponse.statusCode === 401) {
                                    reject(new Error('Unauthorized. Please provide a valid HuggingFace token.'));
                                } else if (redirectResponse.statusCode === 403) {
                                    reject(new Error('Access forbidden. Make sure you have accepted the model license.'));
                                } else {
                                    reject(new Error(`HTTP ${redirectResponse.statusCode}: ${redirectResponse.statusMessage}`));
                                }
                                return;
                            }

                            totalSize = parseInt(redirectResponse.headers['content-length'], 10);
                            console.log(`Starting download of ${model.filename} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);

                            const newFileStream = fs.createWriteStream(`${targetPath}.tmp`);

                            redirectResponse.on('data', (chunk) => {
                                downloadedSize += chunk.length;
                                newFileStream.write(chunk);
                                
                                const progress = Math.round((downloadedSize / totalSize) * 100);
                                this.downloadProgress.set(modelKey, { downloading: true, progress });
                                
                                if (progressCallback) {
                                    progressCallback({ modelKey, progress, downloadedSize, totalSize });
                                }
                            });

                            redirectResponse.on('end', () => {
                                newFileStream.end(() => {
                                    // Verify download size
                                    if (downloadedSize !== totalSize && totalSize > 0) {
                                        fs.unlinkSync(`${targetPath}.tmp`);
                                        reject(new Error(`Download incomplete. Expected ${totalSize} bytes, got ${downloadedSize} bytes.`));
                                        return;
                                    }

                                    // Rename temp file to final name
                                    fs.renameSync(`${targetPath}.tmp`, targetPath);
                                    
                                    this.downloadProgress.set(modelKey, { downloading: false, progress: 100 });
                                    console.log(`Download completed: ${model.filename}`);
                                    resolve({ status: 'completed' });
                                });
                            });

                            redirectResponse.on('error', (error) => {
                                newFileStream.close();
                                if (fs.existsSync(`${targetPath}.tmp`)) {
                                    fs.unlinkSync(`${targetPath}.tmp`);
                                }
                                reject(error);
                            });

                            newFileStream.on('error', (error) => {
                                if (fs.existsSync(`${targetPath}.tmp`)) {
                                    fs.unlinkSync(`${targetPath}.tmp`);
                                }
                                reject(error);
                            });
                        });

                        redirectReq.on('error', (error) => {
                            reject(error);
                        });
                        
                        return;
                    }

                    if (response.statusCode !== 200) {
                        fileStream.close();
                        fs.unlinkSync(`${targetPath}.tmp`);
                        
                        if (response.statusCode === 401) {
                            reject(new Error('Unauthorized. Please provide a valid HuggingFace token.'));
                        } else if (response.statusCode === 403) {
                            reject(new Error('Access forbidden. Make sure you have accepted the model license.'));
                        } else {
                            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                        }
                        return;
                    }

                    totalSize = parseInt(response.headers['content-length'], 10);
                    console.log(`Starting download of ${model.filename} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);

                    response.on('data', (chunk) => {
                        downloadedSize += chunk.length;
                        fileStream.write(chunk);
                        
                        const progress = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
                        this.downloadProgress.set(modelKey, { downloading: true, progress });
                        
                        if (progressCallback) {
                            progressCallback({ modelKey, progress, downloadedSize, totalSize });
                        }
                    });

                    response.on('end', () => {
                        fileStream.end(() => {
                            // Verify download size
                            if (downloadedSize !== totalSize && totalSize > 0) {
                                fs.unlinkSync(`${targetPath}.tmp`);
                                reject(new Error(`Download incomplete. Expected ${totalSize} bytes, got ${downloadedSize} bytes.`));
                                return;
                            }

                            // Rename temp file to final name
                            fs.renameSync(`${targetPath}.tmp`, targetPath);
                            
                            this.downloadProgress.set(modelKey, { downloading: false, progress: 100 });
                            resolve({ status: 'completed' });
                        });
                    });

                    response.on('error', (error) => {
                        fileStream.close();
                        fs.unlinkSync(`${targetPath}.tmp`);
                        reject(error);
                    });
                });

                request.on('error', (error) => {
                    fileStream.close();
                    if (fs.existsSync(`${targetPath}.tmp`)) {
                        fs.unlinkSync(`${targetPath}.tmp`);
                    }
                    reject(error);
                });

                fileStream.on('error', (error) => {
                    request.abort();
                    if (fs.existsSync(`${targetPath}.tmp`)) {
                        fs.unlinkSync(`${targetPath}.tmp`);
                    }
                    reject(error);
                });
            });

        } catch (error) {
            this.downloadProgress.set(modelKey, { 
                downloading: false, 
                progress: 0, 
                error: error.message 
            });
            
            // Clean up temp file if it exists
            if (fs.existsSync(`${targetPath}.tmp`)) {
                fs.unlinkSync(`${targetPath}.tmp`);
            }
            
            throw error;
        }
    }

    // Get settings
    getSettings() {
        return {
            model_precision: "fp8",
            steps_min: 1,
            steps_max: 50,
            guidance_min: 0.0,
            guidance_max: 10.0,
            available_samplers: ["euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral"],
            available_schedulers: ["simple", "normal", "karras", "exponential"]
        };
    }
}

module.exports = FluxServiceLocal;