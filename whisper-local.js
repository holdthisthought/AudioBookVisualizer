const fs = require('fs');
const path = require('path');
const os = require('os');
const WhisperPython = require('./whisper-python');

class WhisperLocal {
    constructor() {
        this.whisperPython = new WhisperPython();
        this.currentModel = null;
        this.isInitialized = false;
    }

    // Model information
    getModelInfo() {
        return {
            tiny: { name: 'Tiny', size: '39 MB' },
            base: { name: 'Base', size: '74 MB' },
            small: { name: 'Small', size: '244 MB' },
            medium: { name: 'Medium', size: '769 MB' },
            large: { name: 'Large', size: '1.5 GB' }
        };
    }

    // Check if a model is available locally
    async isModelAvailable(modelName) {
        const models = await this.whisperPython.getAvailableModels();
        return models[modelName]?.available || false;
    }

    // Get status of all models
    async getModelsStatus() {
        const models = await this.whisperPython.getAvailableModels();
        const status = {};
        
        for (const [key, info] of Object.entries(models)) {
            status[key] = {
                name: info.name,
                size: info.size,
                available: info.available,
                downloading: false,
                progress: 0
            };
        }
        
        return status;
    }

    // Download a model (trigger Python whisper to download it)
    async downloadModel(modelName, progressCallback) {
        try {
            // Show initial progress
            if (progressCallback) {
                progressCallback({
                    modelName,
                    status: {
                        downloading: true,
                        progress: 10,
                        completed: false
                    }
                });
            }
            
            // Trigger Python to download the model
            if (progressCallback) {
                progressCallback({
                    modelName,
                    status: {
                        downloading: true,
                        progress: 30,
                        completed: false
                    }
                });
            }
            
            await this.whisperPython.preDownloadModel(modelName);
            
            // Mark as completed
            if (progressCallback) {
                progressCallback({
                    modelName,
                    status: {
                        downloading: false,
                        progress: 100,
                        completed: true
                    }
                });
            }
            
            return { success: true, message: 'Model downloaded successfully' };
        } catch (error) {
            if (progressCallback) {
                progressCallback({
                    modelName,
                    status: {
                        downloading: false,
                        progress: 0,
                        completed: false,
                        error: error.message
                    }
                });
            }
            throw error;
        }
    }

    // Check if whisper is installed
    async isWhisperInstalled() {
        return await this.whisperPython.checkWhisper();
    }

    // Initialize whisper with a specific model
    async initializeModel(modelName) {
        // Check if whisper is installed
        const isInstalled = await this.isWhisperInstalled();
        if (!isInstalled) {
            throw new Error('OpenAI Whisper is not installed. Please install it first using the terminal.');
        }
        
        // With Python whisper, we don't need to pre-load models
        this.currentModel = modelName;
        this.isInitialized = true;
        
        return { success: true };
    }

    // Transcribe audio file
    async transcribe(audioPath, options = {}) {
        const modelName = options.modelName || this.currentModel || 'base';
        const language = options.language || 'en';
        
        // Check if whisper is installed
        const isInstalled = await this.isWhisperInstalled();
        if (!isInstalled) {
            throw new Error('OpenAI Whisper is not installed. Please install it first using the terminal.');
        }
        
        try {
            // Use Python whisper for transcription
            const result = await this.whisperPython.transcribe(audioPath, modelName, language);
            
            return {
                text: result.text,
                segments: result.segments,
                language: language
            };
        } catch (error) {
            console.error('Transcription error:', error);
            
            // If model not found, it might need to be downloaded
            if (error.message && error.message.includes('Model') && error.message.includes('not found')) {
                throw new Error(`Model ${modelName} needs to be downloaded. It will download automatically on first use.`);
            }
            
            throw error;
        }
    }

    // Unload current model (Python whisper manages its own memory)
    unloadModel() {
        this.currentModel = null;
        this.isInitialized = false;
        return { success: true, message: 'Model reference cleared' };
    }

    // Unload all models
    unloadAllModels() {
        this.unloadModel();
        return { success: true, message: 'Model references cleared' };
    }
}

module.exports = WhisperLocal;