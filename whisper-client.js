// Whisper client - handles both local and service-based transcription
(function() {
    const { ipcRenderer } = require('electron');
    const fs = require('fs');
    const path = require('path');

    class WhisperClient {
    constructor() {
        this.useService = false;
        this.serviceAvailable = false;
        this.localWhisperAvailable = false;
        // Load saved model preference or default to 'base'
        this.selectedModel = localStorage.getItem('whisperSelectedModel') || 'base';
    }

    // Check availability of Whisper options
    async checkAvailability() {
        // Check service availability
        const setupStatus = await ipcRenderer.invoke('whisper-get-setup-status');
        this.serviceAvailable = setupStatus.service?.healthy || false;
        this.whisperBinaryInstalled = setupStatus.whisperBinary || false;

        return {
            service: this.serviceAvailable,
            available: this.serviceAvailable,
            whisperBinary: this.whisperBinaryInstalled
        };
    }

    // Show Whisper setup modal
    showSetupModal() {
        const modal = document.createElement('div');
        modal.className = 'whisper-setup-modal modal';
        modal.innerHTML = `
            <div class="modal-content">
                <span class="close">&times;</span>
                <h2>AI Services</h2>
                
                <div class="setup-options">
                    <div class="setup-option">
                        <h3>AI CLI Agents (Character Extraction)</h3>
                        <p>AI assistants for extracting character information from transcripts:</p>
                        <div id="cliToolsStatus" style="margin-top: 10px;">
                            <div id="claudeStatus" class="status-message">Checking Claude Code...</div>
                            <div id="geminiStatus" class="status-message" style="margin-top: 5px;">Checking Gemini CLI...</div>
                        </div>
                    </div>
                    
                    <div class="setup-option" style="margin-top: 20px;">
                        <h3>Local Whisper (Transcription)</h3>
                        <p>Uses whisper.cpp for fast, local transcription without requiring Docker.</p>
                        <p style="font-size: 12px; color: #666;">Current model: <strong>${this.selectedModel}</strong></p>
                        <div id="serviceStatus" class="status-message success">✓ Local Whisper is ready</div>
                    </div>
                </div>
                
                <div id="setupProgress" class="setup-progress" style="display: none;">
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                    <div class="progress-message"></div>
                </div>
                
                <div id="modelSelection" class="model-selection" style="display: none;">
                    <h3>Select Whisper Model</h3>
                    <select id="whisperModel">
                        <option value="tiny" ${this.selectedModel === 'tiny' ? 'selected' : ''}>Tiny (39 MB) - Fastest</option>
                        <option value="base" ${this.selectedModel === 'base' ? 'selected' : ''}>Base (74 MB) - Balanced</option>
                        <option value="small" ${this.selectedModel === 'small' ? 'selected' : ''}>Small (244 MB) - Better accuracy</option>
                        <option value="medium" ${this.selectedModel === 'medium' ? 'selected' : ''}>Medium (769 MB) - Good accuracy</option>
                        <option value="large" ${this.selectedModel === 'large' ? 'selected' : ''}>Large (1.5 GB) - Best accuracy</option>
                    </select>
                    <button id="downloadModelBtn" class="primary-btn">Download Model</button>
                    <button id="unloadModelsBtn" class="secondary-btn" title="Free GPU memory by unloading all models">Unload All Models</button>
                    <div id="modelStatus" class="status-message"></div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Setup event handlers
        const closeBtn = modal.querySelector('.close');
        closeBtn.onclick = () => modal.remove();
        
        window.onclick = (event) => {
            if (event.target === modal) {
                modal.remove();
            }
        };
        
        // No setup button needed for local whisper
        
        // Check current status
        this.updateSetupStatus(modal);
        this.updateCLIToolsStatus(modal);
    }

    async updateCLIToolsStatus(modal) {
        try {
            const result = await ipcRenderer.invoke('check-cli-tools');
            const claudeStatus = modal.querySelector('#claudeStatus');
            const geminiStatus = modal.querySelector('#geminiStatus');
            
            if (result.success) {
                // Update Claude status
                if (result.tools.claude.installed) {
                    claudeStatus.innerHTML = `✓ Claude Code installed (v${result.tools.claude.version || 'unknown'})`;
                    claudeStatus.className = 'status-message success';
                } else {
                    claudeStatus.innerHTML = '❌ Claude Code not installed - In WSL, run: <code>npm install -g @anthropic-ai/claude-code</code>';
                    claudeStatus.className = 'status-message error';
                }
                
                // Update Gemini status
                if (result.tools.gemini.installed) {
                    geminiStatus.innerHTML = `✓ Gemini CLI installed (v${result.tools.gemini.version || 'unknown'})`;
                    geminiStatus.className = 'status-message success';
                } else {
                    geminiStatus.innerHTML = '❌ Gemini CLI not installed - In WSL, run: <code>npm install @google/gemini-cli</code>';
                    geminiStatus.className = 'status-message error';
                }
            } else {
                claudeStatus.innerHTML = '⚠ Unable to check CLI tools status';
                claudeStatus.className = 'status-message warning';
                geminiStatus.innerHTML = '';
            }
        } catch (error) {
            console.error('Error checking CLI tools:', error);
            const claudeStatus = modal.querySelector('#claudeStatus');
            claudeStatus.innerHTML = '⚠ Error checking CLI tools status';
            claudeStatus.className = 'status-message warning';
        }
    }

    async updateSetupStatus(modal) {
        const availability = await this.checkAvailability();
        const serviceStatus = modal.querySelector('#serviceStatus');
        
        if (!availability.whisperBinary) {
            serviceStatus.innerHTML = '❌ Whisper.cpp not installed - <a href="#" id="installWhisperLink">Click here to install</a>';
            serviceStatus.className = 'status-message error';
            
            // Add install link handler
            setTimeout(() => {
                const installLink = modal.querySelector('#installWhisperLink');
                if (installLink) {
                    installLink.onclick = (e) => {
                        e.preventDefault();
                        this.openTerminalForInstall();
                        modal.remove();
                    };
                }
            }, 100);
            
            // Hide model selection if whisper not installed
            modal.querySelector('#modelSelection').style.display = 'none';
        } else if (availability.service) {
            serviceStatus.textContent = '✓ Local Whisper is ready';
            serviceStatus.className = 'status-message success';
            modal.querySelector('#modelSelection').style.display = 'block';
            this.updateModelStatus(modal);
        } else {
            serviceStatus.textContent = '⚠ No Whisper models installed - Please download a model below';
            serviceStatus.className = 'status-message warning';
            modal.querySelector('#modelSelection').style.display = 'block';
            this.updateModelStatus(modal);
        }
    }

    // setupService method is no longer needed for local whisper


    async updateModelStatus(modal) {
        const modelsStatus = await ipcRenderer.invoke('whisper-get-models-status');
        const modelSelect = modal.querySelector('#whisperModel');
        const modelStatus = modal.querySelector('#modelStatus');
        const downloadBtn = modal.querySelector('#downloadModelBtn');
        
        const selectedModel = modelSelect.value;
        const modelInfo = modelsStatus[selectedModel];
        
        if (modelInfo) {
            if (modelInfo.available) {
                modelStatus.textContent = `✓ ${modelInfo.name} model is cached and ready`;
                modelStatus.className = 'status-message success';
                downloadBtn.disabled = true;
                downloadBtn.textContent = 'Model Ready';
            } else if (modelInfo.downloading) {
                modelStatus.textContent = `Downloading... ${modelInfo.progress}%`;
                modelStatus.className = 'status-message info';
                downloadBtn.disabled = true;
            } else {
                modelStatus.textContent = `${modelInfo.name} (${modelInfo.size}) - Will download on first use`;
                modelStatus.className = 'status-message info';
                downloadBtn.disabled = false;
                downloadBtn.textContent = 'Pre-download Model';
            }
        }
        
        // Model selection change
        modelSelect.onchange = () => {
            this.selectedModel = modelSelect.value;
            // Save model preference
            localStorage.setItem('whisperSelectedModel', this.selectedModel);
            this.updateModelStatus(modal);
        };
        
        // Download button
        downloadBtn.onclick = () => this.downloadModel(modal);
        
        // Unload models button
        const unloadBtn = modal.querySelector('#unloadModelsBtn');
        unloadBtn.onclick = async () => {
            try {
                modelStatus.textContent = 'Unloading all models...';
                modelStatus.className = 'status-message info';
                
                const result = await ipcRenderer.invoke('whisper-unload-all-models');
                
                if (result.error) {
                    modelStatus.textContent = `Error: ${result.error}`;
                    modelStatus.className = 'status-message error';
                } else {
                    modelStatus.textContent = `✓ ${result.message}`;
                    modelStatus.className = 'status-message success';
                    // Update the model status display
                    setTimeout(() => this.updateModelStatus(modal), 1000);
                }
            } catch (error) {
                modelStatus.textContent = `Error: ${error.message}`;
                modelStatus.className = 'status-message error';
            }
        };
        
        // Listen for download progress
        ipcRenderer.on('whisper-download-progress', (event, { modelName, status }) => {
            if (modelName === selectedModel) {
                if (status.downloading) {
                    modelStatus.textContent = `Downloading... ${status.progress}%`;
                    modelStatus.className = 'status-message info';
                } else if (status.completed) {
                    this.updateModelStatus(modal);
                } else if (status.error) {
                    modelStatus.textContent = `Error: ${status.error}`;
                    modelStatus.className = 'status-message error';
                    downloadBtn.disabled = false;
                }
            }
        });
    }

    async downloadModel(modal) {
        const modelSelect = modal.querySelector('#whisperModel');
        const modelStatus = modal.querySelector('#modelStatus');
        const selectedModel = modelSelect.value;
        
        // Ensure we're saving the selected model
        this.selectedModel = selectedModel;
        localStorage.setItem('whisperSelectedModel', this.selectedModel);
        
        try {
            // Show info message
            modelStatus.textContent = 'Pre-downloading model (this triggers Python whisper to cache it)...';
            modelStatus.className = 'status-message info';
            
            await ipcRenderer.invoke('whisper-download-model', selectedModel);
            
            // After "download" completes, update status
            setTimeout(() => this.updateModelStatus(modal), 1500);
        } catch (error) {
            modelStatus.textContent = `Error: ${error.message}`;
            modelStatus.className = 'status-message error';
        }
    }

    // Transcribe using service
    async transcribeWithService(audioPath, modelName = 'base', language = 'en') {
        try {
            // Read the audio file and convert to base64
            const audioBuffer = fs.readFileSync(audioPath);
            const audioBase64 = `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`;
            const filename = path.basename(audioPath);
            
            // Start transcription job using base64
            const jobResult = await ipcRenderer.invoke('whisper-transcribe-base64', {
                audioData: audioBase64,
                filename,
                modelName,
                language
            });
            
            if (jobResult.error) {
                throw new Error(jobResult.error);
            }
            
            // Poll for job completion
            const jobId = jobResult.job_id;
            let attempts = 0;
            const maxAttempts = 600; // 10 minutes max
            
            while (attempts < maxAttempts) {
                const status = await ipcRenderer.invoke('whisper-get-job-status', jobId);
                
                if (status.status === 'completed') {
                    const result = await ipcRenderer.invoke('whisper-get-job-result', jobId);
                    return {
                        success: true,
                        transcription: result.text,
                        segments: result.segments
                    };
                } else if (status.status === 'failed') {
                    throw new Error(status.error || 'Transcription failed');
                }
                
                // Wait 1 second before next poll
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            }
            
            throw new Error('Transcription timeout');
        } catch (error) {
            console.error('Service transcription error:', error);
            throw error;
        }
    }

    // Open terminal for whisper installation
    openTerminalForInstall() {
        // Show terminal if hidden
        const terminalElement = document.querySelector('.ai-terminal');
        if (terminalElement && terminalElement.classList.contains('collapsed')) {
            const toggleBtn = document.getElementById('terminal-toggle');
            if (toggleBtn) {
                toggleBtn.click();
            }
        }
        
        // Send install command to terminal
        if (window.globalAITerminal) {
            window.globalAITerminal.installWhisper();
        }
    }
    
    // Main transcribe function
    async transcribe(audioPath, options = {}) {
        const modelName = options.modelName || this.selectedModel || 'base';
        const language = options.language || 'en';
        
        // Use local transcription through service compatibility layer
        return await this.transcribeWithService(audioPath, modelName, language);
    }
    }

    // Export for use in script.js
    window.WhisperClient = WhisperClient;
})();