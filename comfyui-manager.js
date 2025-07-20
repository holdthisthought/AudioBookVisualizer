const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');
const execAsync = promisify(exec);

class ComfyUIManager {
    constructor() {
        this.comfyUIPath = null;
        this.comfyUIProcess = null;
        this.configFile = path.join(os.homedir(), '.audiobook-visualizer', 'comfyui-config.json');
        this.loadConfig();
    }

    // Load saved ComfyUI path from config
    loadConfig() {
        try {
            if (fs.existsSync(this.configFile)) {
                const config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
                this.comfyUIPath = config.comfyUIPath;
            }
        } catch (error) {
            console.error('Error loading ComfyUI config:', error);
        }
    }

    // Save ComfyUI path to config
    saveConfig() {
        try {
            const dir = path.dirname(this.configFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.configFile, JSON.stringify({
                comfyUIPath: this.comfyUIPath
            }, null, 2));
        } catch (error) {
            console.error('Error saving ComfyUI config:', error);
        }
    }

    // Set the ComfyUI installation path
    setComfyUIPath(installPath) {
        this.comfyUIPath = installPath;
        this.saveConfig();
    }

    // Get the current ComfyUI path
    getComfyUIPath() {
        return this.comfyUIPath;
    }

    // Validate ComfyUI installation
    async validateInstallation() {
        if (!this.comfyUIPath) {
            return { valid: false, error: 'ComfyUI path not set' };
        }

        try {
            // Check if main.py exists
            const mainPyPath = path.join(this.comfyUIPath, 'main.py');
            if (!fs.existsSync(mainPyPath)) {
                return { valid: false, error: 'main.py not found in ComfyUI directory' };
            }

            // Check if custom_nodes directory exists
            const customNodesPath = path.join(this.comfyUIPath, 'custom_nodes');
            if (!fs.existsSync(customNodesPath)) {
                return { valid: false, error: 'custom_nodes directory not found' };
            }

            // Check for required FLUX Kontext nodes
            const fluxKontextPath = path.join(customNodesPath, 'ComfyUI-Flux-Kontext');
            const hasFluxKontext = fs.existsSync(fluxKontextPath);

            // Check models directory structure
            const modelsPath = path.join(this.comfyUIPath, 'models');
            const unetPath = path.join(modelsPath, 'unet');
            const vaePath = path.join(modelsPath, 'vae');
            const clipPath = path.join(modelsPath, 'clip');

            // Create directories if they don't exist
            for (const dir of [modelsPath, unetPath, vaePath, clipPath]) {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            }

            return {
                valid: true,
                hasFluxKontext,
                paths: {
                    main: mainPyPath,
                    customNodes: customNodesPath,
                    models: modelsPath,
                    unet: unetPath,
                    vae: vaePath,
                    clip: clipPath
                }
            };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    // Check if ComfyUI is running
    async isRunning() {
        try {
            const response = await fetch('http://localhost:8188/');
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    // Start ComfyUI in headless mode
    async start(progressCallback) {
        if (!this.comfyUIPath) {
            throw new Error('ComfyUI path not set');
        }

        const validation = await this.validateInstallation();
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        if (await this.isRunning()) {
            progressCallback({ progress: 100, message: 'ComfyUI already running' });
            return { success: true };
        }

        progressCallback({ progress: 10, message: 'Starting ComfyUI...' });

        // Determine Python command
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

        // Start ComfyUI with appropriate arguments
        const args = [
            'main.py',
            '--listen', '0.0.0.0',
            '--port', '8188',
            '--disable-auto-launch',
            '--disable-metadata',  // Disable tqdm progress bars that cause issues in headless mode
            '--cpu'  // Remove this if GPU is available
        ];

        // Check if CUDA is available (for GPU support)
        try {
            await execAsync('nvidia-smi');
            // Remove --cpu flag if NVIDIA GPU is detected
            const cpuIndex = args.indexOf('--cpu');
            if (cpuIndex > -1) {
                args.splice(cpuIndex, 1);
                console.log('[ComfyUI] GPU detected, using CUDA acceleration');
                progressCallback({ progress: 20, message: 'GPU detected, using CUDA...' });
            }
        } catch (error) {
            console.log('[ComfyUI] No GPU detected, using CPU mode');
            progressCallback({ progress: 20, message: 'No GPU detected, using CPU mode...' });
        }
        
        console.log('[ComfyUI] Starting with args:', args.join(' '));

        return new Promise((resolve, reject) => {
            this.comfyUIProcess = spawn(pythonCmd, args, {
                cwd: this.comfyUIPath,
                env: { ...process.env },
                detached: false
            });

            let startupTimeout;
            let healthCheckInterval;

            this.comfyUIProcess.stdout.on('data', (data) => {
                const output = data.toString();
                console.log('[ComfyUI]', output);
                
                if (output.includes('Starting server')) {
                    progressCallback({ progress: 50, message: 'ComfyUI server starting...' });
                } else if (output.includes('To see the GUI go to')) {
                    progressCallback({ progress: 70, message: 'ComfyUI server ready, verifying...' });
                }
            });

            this.comfyUIProcess.stderr.on('data', (data) => {
                const output = data.toString();
                
                // Determine if this is actually an error or just info
                const isInfo = output.includes('ComfyUI startup time') ||
                              output.includes('Platform:') ||
                              output.includes('Python version:') ||
                              output.includes('ComfyUI Path:') ||
                              output.includes('User directory:') ||
                              output.includes('Total VRAM') ||
                              output.includes('Device: cuda') ||
                              output.includes('ComfyUI version:') ||
                              output.includes('frontend version:') ||
                              output.includes('Prompt Server') ||
                              output.includes('Loading:') ||
                              output.includes('Import times') ||
                              output.includes('Prestartup times') ||
                              output.includes('Checkpoint files will always be loaded safely') ||
                              output.includes('Set vram state') ||
                              output.includes('Using pytorch attention') ||
                              output.includes('ComfyUI-Manager') ||
                              output.includes('Context impl') ||
                              output.includes('Starting server') ||
                              output.includes('To see the GUI go to') ||
                              output.includes('pytorch version:') ||
                              output.includes('No target revision found') ||
                              output.includes('cache updated') ||
                              output.includes('network_mode') ||
                              output.includes('Released on') ||
                              output.includes('got prompt') ||
                              output.includes('FETCH ComfyRegistry Data') ||
                              output.includes('VAE load device') ||
                              output.includes('Requested to load') ||
                              output.includes('loaded completely') ||
                              output.includes('UserWarning') ||
                              output.includes('Using scaled fp8') ||
                              output.includes('CLIP/text encoder model load') ||
                              output.includes('clip missing') ||
                              output.includes('model weight dtype') ||
                              output.includes('model_type FLUX') ||
                              output.includes('Torch was not compiled with flash attention');
                
                // Suppress verbose loading messages during image generation
                const suppressPatterns = [
                    'FETCH ComfyRegistry Data',
                    'Using pytorch attention in VAE',
                    'VAE load device',
                    'Requested to load',
                    'loaded completely',
                    'loaded partially',
                    'UserWarning',
                    'Using scaled fp8',
                    'CLIP/text encoder model load',
                    'clip missing',
                    'model weight dtype',
                    'model_type FLUX',
                    'Torch was not compiled with flash attention',
                    'got prompt',
                    'Token indices sequence length',
                    'Prompt executed in',
                    'FETCH DATA from',
                    '[DONE]',
                    'All startup tasks have been completed',
                    '|',  // Progress bar characters
                    '%',  // Progress percentage
                    'it/s'  // Iterations per second
                ];
                
                const shouldSuppress = suppressPatterns.some(pattern => output.includes(pattern));
                
                if (!shouldSuppress) {
                    if (isInfo) {
                        console.log('[ComfyUI]', output);
                    } else {
                        console.error('[ComfyUI Error]', output);
                    }
                }
                
                // Check for specific dependency errors
                if (output.includes('pip install -r requirements.txt')) {
                    console.log('[ComfyUI] Dependency update required. Please run:');
                    console.log(`[ComfyUI] cd ${this.comfyUIPath} && python -m pip install -r requirements.txt`);
                    progressCallback({ 
                        progress: 30, 
                        message: 'ComfyUI needs dependency updates - see console for instructions' 
                    });
                }
                
                // Don't reject on warnings or known non-fatal errors
                const nonFatalPatterns = [
                    'WARNING',
                    'UserWarning',
                    'Prestartup times',
                    'Import times',
                    'Cannot import',
                    'IMPORT FAILED',
                    'comfyui-embedded-docs package not found',
                    'Checkpoint files will always be loaded safely',
                    'Total VRAM',
                    'Set vram state',
                    'Device: cuda',
                    'Using pytorch attention',
                    'Python version',
                    'ComfyUI version',
                    'Prompt Server',
                    'Loading:',
                    'Starting server',
                    'To see the GUI',
                    'pytorch version:',
                    'No target revision found',
                    'cache updated',
                    'network_mode',
                    'Released on',
                    'ComfyUI-Manager',
                    'got prompt',
                    'FETCH ComfyRegistry Data',
                    'VAE load device',
                    'Requested to load',
                    'loaded completely',
                    'loaded partially',
                    'Using scaled fp8',
                    'CLIP/text encoder model load',
                    'clip missing',
                    'model weight dtype',
                    'model_type FLUX',
                    'Torch was not compiled with flash attention',
                    'Token indices sequence length',
                    'Prompt executed in',
                    'seconds:',  // For the custom nodes timing
                    'custom_nodes',
                    'websocket_image_save.py'
                ];
                
                const isFatal = !nonFatalPatterns.some(pattern => output.includes(pattern));
                
                // Only reject on actual fatal errors with meaningful content
                if (isFatal && output.trim().length > 5 && 
                    !output.includes('frontend version') && 
                    !output.includes('Unable to parse pyproject.toml') &&
                    !output.includes('Context impl') &&
                    !output.includes('No target revision found')) {
                    clearTimeout(startupTimeout);
                    clearInterval(healthCheckInterval);
                    reject(new Error(`ComfyUI error: ${output}`));
                }
            });

            this.comfyUIProcess.on('error', (error) => {
                clearTimeout(startupTimeout);
                clearInterval(healthCheckInterval);
                reject(new Error(`Failed to start ComfyUI: ${error.message}`));
            });

            this.comfyUIProcess.on('exit', (code, signal) => {
                this.comfyUIProcess = null;
                if (code !== 0 && code !== null) {
                    clearTimeout(startupTimeout);
                    clearInterval(healthCheckInterval);
                    reject(new Error(`ComfyUI exited with code ${code}`));
                }
            });

            // Set up health check
            let attempts = 0;
            healthCheckInterval = setInterval(async () => {
                attempts++;
                if (await this.isRunning()) {
                    clearTimeout(startupTimeout);
                    clearInterval(healthCheckInterval);
                    progressCallback({ progress: 100, message: 'ComfyUI is ready!' });
                    resolve({ success: true });
                } else if (attempts > 30) { // 30 seconds timeout
                    clearTimeout(startupTimeout);
                    clearInterval(healthCheckInterval);
                    this.stop();
                    reject(new Error('ComfyUI failed to start within 30 seconds'));
                }
            }, 1000);

            // Overall timeout
            startupTimeout = setTimeout(() => {
                clearInterval(healthCheckInterval);
                this.stop();
                reject(new Error('ComfyUI startup timeout'));
            }, 60000); // 60 seconds
        });
    }

    // Stop ComfyUI
    async stop() {
        if (this.comfyUIProcess) {
            return new Promise((resolve) => {
                this.comfyUIProcess.on('exit', () => {
                    this.comfyUIProcess = null;
                    resolve({ success: true });
                });

                // Try graceful shutdown first
                if (process.platform === 'win32') {
                    exec(`taskkill /pid ${this.comfyUIProcess.pid} /T /F`);
                } else {
                    this.comfyUIProcess.kill('SIGTERM');
                    
                    // Force kill after 5 seconds if still running
                    setTimeout(() => {
                        if (this.comfyUIProcess) {
                            this.comfyUIProcess.kill('SIGKILL');
                        }
                    }, 5000);
                }
            });
        }
        return { success: true };
    }

    // Get model directories
    getModelPaths() {
        if (!this.comfyUIPath) {
            return null;
        }

        return {
            unet: path.join(this.comfyUIPath, 'models', 'unet'),
            vae: path.join(this.comfyUIPath, 'models', 'vae'),
            clip: path.join(this.comfyUIPath, 'models', 'clip'),
            diffusion_models: path.join(this.comfyUIPath, 'models', 'diffusion_models')
        };
    }

    // Check if required FLUX Kontext nodes are installed
    async checkFluxKontextNodes() {
        if (!this.comfyUIPath) {
            return { installed: false, error: 'ComfyUI path not set' };
        }

        const customNodesPath = path.join(this.comfyUIPath, 'custom_nodes');
        const fluxKontextPath = path.join(customNodesPath, 'ComfyUI-Flux-Kontext');

        if (fs.existsSync(fluxKontextPath)) {
            // Check if it has the required nodes
            const nodesPath = path.join(fluxKontextPath, 'nodes.py');
            if (fs.existsSync(nodesPath)) {
                return { installed: true, path: fluxKontextPath };
            }
        }

        return {
            installed: false,
            installCommand: `cd "${customNodesPath}" && git clone https://github.com/melMass/ComfyUI-Flux-Kontext.git`,
            manualSteps: [
                '1. Navigate to ComfyUI/custom_nodes directory',
                '2. Clone the repository: git clone https://github.com/melMass/ComfyUI-Flux-Kontext.git',
                '3. Restart ComfyUI'
            ]
        };
    }

    // Get service status
    async getStatus() {
        const isPathSet = !!this.comfyUIPath;
        const isRunning = await this.isRunning();
        const validation = isPathSet ? await this.validateInstallation() : null;
        const fluxKontext = isPathSet ? await this.checkFluxKontextNodes() : null;

        return {
            pathSet: isPathSet,
            path: this.comfyUIPath,
            running: isRunning,
            valid: validation?.valid || false,
            validation,
            fluxKontext,
            processRunning: !!this.comfyUIProcess
        };
    }
}

module.exports = ComfyUIManager;