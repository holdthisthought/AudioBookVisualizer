
const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { GoogleGenerativeAI } = require('@google/generative-ai');
const FluxManager = require('./flux-manager');
const ComfyUIManager = require('./comfyui-manager');
const FluxServiceLocal = require('./flux-service-local');
const FluxServiceRunPod = require('./flux-service-runpod');
const WhisperLocal = require('./whisper-local');
const WhisperServiceRunPod = require('./whisper-service-runpod');
const characterExtractionCLI = require('./characterExtractionCLI');
const DockerManager = require('./docker-manager');
// Use platform-specific terminal implementation
let LocalTerminalServer;
if (process.platform === 'win32') {
    // Use Windows-specific implementation
    LocalTerminalServer = require('./terminal-local-windows');
    console.log('[Main] Using Windows terminal implementation');
} else {
    // Try node-pty first, then fallback
    try {
        LocalTerminalServer = require('./terminal-local-nodepty');
        console.log('[Main] Using node-pty terminal implementation');
    } catch (error) {
        console.log('[Main] node-pty not available, using basic terminal implementation');
        LocalTerminalServer = require('./terminal-local');
    }
}

// Secure storage for API key
const configDir = path.join(os.homedir(), '.audiobook-visualizer');
const configFile = path.join(configDir, 'config.json');

// Ensure config directory exists
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
}

let GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
let HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN || '';
let RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || '';
let RUNPOD_ENDPOINT_ID = '';
let WHISPER_RUNPOD_ENDPOINT_ID = '';
let genAI = null;
let currentGenerationService = 'local'; // 'local' or 'runpod'
let currentWhisperService = 'local'; // 'local' or 'runpod'

// Load API keys and tokens from secure storage
function loadApiKey() {
    try {
        if (fs.existsSync(configFile)) {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (config.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
                GEMINI_API_KEY = safeStorage.decryptString(Buffer.from(config.encryptedApiKey, 'base64'));
                process.env.GEMINI_API_KEY = GEMINI_API_KEY;  // Set in process.env for Docker
            }
            if (config.encryptedHfToken && safeStorage.isEncryptionAvailable()) {
                HUGGINGFACE_TOKEN = safeStorage.decryptString(Buffer.from(config.encryptedHfToken, 'base64'));
            }
            if (config.encryptedRunpodKey && safeStorage.isEncryptionAvailable()) {
                RUNPOD_API_KEY = safeStorage.decryptString(Buffer.from(config.encryptedRunpodKey, 'base64'));
            }
            if (config.runpodEndpointId) {
                RUNPOD_ENDPOINT_ID = config.runpodEndpointId;
            }
            if (config.whisperRunpodEndpointId) {
                WHISPER_RUNPOD_ENDPOINT_ID = config.whisperRunpodEndpointId;
            }
            if (config.generationService) {
                currentGenerationService = config.generationService;
            }
            if (config.whisperService) {
                currentWhisperService = config.whisperService;
            }
        }
        if (GEMINI_API_KEY) {
            genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        }
    } catch (error) {
        console.error('Error loading API keys:', error);
    }
}

// Initialize FLUX manager (Docker-based - keeping for backward compatibility)
const fluxManager = new FluxManager();

// Initialize ComfyUI manager and local FLUX service
const comfyUIManager = new ComfyUIManager();
const fluxServiceLocal = new FluxServiceLocal(comfyUIManager);

// Initialize RunPod FLUX service
const fluxServiceRunPod = new FluxServiceRunPod();

// Initialize local Whisper
const whisperLocal = new WhisperLocal();

// Initialize RunPod Whisper service
const whisperServiceRunPod = new WhisperServiceRunPod();

// Initialize local terminal server
const terminalServer = new LocalTerminalServer();

// Initialize Docker manager
const dockerManager = new DockerManager();

// API Key Management IPC Handlers
ipcMain.handle('save-api-key', async (event, apiKey) => {
    try {
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Encryption not available on this system');
        }
        
        const encryptedKey = safeStorage.encryptString(apiKey);
        const config = {
            encryptedApiKey: encryptedKey.toString('base64')
        };
        
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        
        // Update runtime variables
        GEMINI_API_KEY = apiKey;
        process.env.GEMINI_API_KEY = apiKey;  // Set in process.env for Docker
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        
        return { success: true };
    } catch (error) {
        console.error('Error saving API key:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-api-key-status', async () => {
    return {
        hasKey: !!GEMINI_API_KEY,
        encryptionAvailable: safeStorage.isEncryptionAvailable()
    };
});

// Claude API Key IPC Handler
ipcMain.handle('save-claude-api-key', async (event, apiKey) => {
    try {
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Encryption not available on this system');
        }
        
        // Read existing config
        let config = {};
        if (fs.existsSync(configFile)) {
            config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        }
        
        // Add encrypted Claude API key
        const encryptedKey = safeStorage.encryptString(apiKey);
        config.encryptedClaudeApiKey = encryptedKey.toString('base64');
        
        // Save config
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        
        // Set environment variable for the whisper service
        process.env.ANTHROPIC_API_KEY = apiKey;
        
        return { success: true };
    } catch (error) {
        console.error('Error saving Claude API key:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-claude-api-key', async () => {
    try {
        if (fs.existsSync(configFile)) {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (config.encryptedClaudeApiKey && safeStorage.isEncryptionAvailable()) {
                return safeStorage.decryptString(Buffer.from(config.encryptedClaudeApiKey, 'base64'));
            }
        }
        return '';
    } catch (error) {
        console.error('Error loading Claude API key:', error);
        return '';
    }
});

// HuggingFace Token IPC Handlers
ipcMain.handle('save-hf-token', async (event, token) => {
    try {
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Encryption not available on this system');
        }
        
        // Read existing config
        let config = {};
        if (fs.existsSync(configFile)) {
            config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        }
        
        // Add encrypted HF token
        const encryptedToken = safeStorage.encryptString(token);
        config.encryptedHfToken = encryptedToken.toString('base64');
        
        // Save config
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        
        // Update runtime variable
        HUGGINGFACE_TOKEN = token;
        
        return { success: true };
    } catch (error) {
        console.error('Error saving HuggingFace token:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-hf-token-status', async () => {
    return {
        hasToken: !!HUGGINGFACE_TOKEN,
        encryptionAvailable: safeStorage.isEncryptionAvailable()
    };
});

// RunPod API Key Management
ipcMain.handle('save-runpod-key', async (event, { apiKey, endpointId }) => {
    try {
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Encryption not available on this system');
        }
        
        // Read existing config
        let config = {};
        if (fs.existsSync(configFile)) {
            config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        }
        
        // Add encrypted RunPod API key
        const encryptedKey = safeStorage.encryptString(apiKey);
        config.encryptedRunpodKey = encryptedKey.toString('base64');
        
        // Save endpoint ID if provided
        if (endpointId) {
            config.runpodEndpointId = endpointId;
        }
        
        // Save config
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        
        // Update runtime variable
        RUNPOD_API_KEY = apiKey;
        
        // Initialize RunPod service with new key
        await fluxServiceRunPod.initialize({
            runpodApiKey: apiKey,
            runpodEndpointId: endpointId || config.runpodEndpointId,
            modelPrecision: config.modelPrecision || 'fp8',
            huggingfaceToken: HUGGINGFACE_TOKEN
        });
        
        return { success: true };
    } catch (error) {
        console.error('Error saving RunPod API key:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-runpod-status', async () => {
    return {
        hasKey: !!RUNPOD_API_KEY,
        encryptionAvailable: safeStorage.isEncryptionAvailable()
    };
});

ipcMain.handle('get-flux-settings', async () => {
    return {
        runpodApiKey: RUNPOD_API_KEY,
        runpodEndpointId: RUNPOD_ENDPOINT_ID,
        whisperRunpodEndpointId: WHISPER_RUNPOD_ENDPOINT_ID,
        huggingfaceToken: HUGGINGFACE_TOKEN,
        generationService: currentGenerationService,
        whisperService: currentWhisperService
    };
});

ipcMain.handle('test-runpod-connection', async (event, { apiKey, endpointId }) => {
    try {
        const testService = new FluxServiceRunPod();
        await testService.initialize({
            runpodApiKey: apiKey,
            runpodEndpointId: endpointId,
            modelPrecision: 'fp8',
            huggingfaceToken: HUGGINGFACE_TOKEN
        });
        const result = await testService.testConnection();
        return result;
    } catch (error) {
        console.error('Error testing RunPod connection:', error);
        return { success: false, error: error.message };
    }
});

// Generation Service Management
ipcMain.handle('set-generation-service', async (event, service) => {
    try {
        currentGenerationService = service;
        
        // Save preference
        let config = {};
        if (fs.existsSync(configFile)) {
            config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        }
        config.generationService = service;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        
        return { success: true };
    } catch (error) {
        console.error('Error setting generation service:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-generation-service', async () => {
    return currentGenerationService;
});

ipcMain.handle('get-whisper-service', async () => {
    return currentWhisperService;
});

ipcMain.handle('set-whisper-service', async (event, service) => {
    currentWhisperService = service;
    // Save to config
    try {
        const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
        config.whisperService = service;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error('Error saving whisper service preference:', error);
    }
    return { success: true };
});

ipcMain.handle('save-whisper-endpoint-id', async (event, endpointId) => {
    try {
        // Read existing config
        let config = {};
        if (fs.existsSync(configFile)) {
            config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        }
        
        // Save whisper endpoint ID
        config.whisperRunpodEndpointId = endpointId;
        
        // Save config
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        
        // Update runtime variable
        WHISPER_RUNPOD_ENDPOINT_ID = endpointId;
        
        // Re-initialize whisper service if using RunPod
        if (currentWhisperService === 'runpod' && RUNPOD_API_KEY) {
            await whisperServiceRunPod.initialize({
                runpodApiKey: RUNPOD_API_KEY,
                whisperEndpointId: endpointId
            });
        }
        
        return { success: true };
    } catch (error) {
        console.error('Error saving whisper endpoint ID:', error);
        return { success: false, error: error.message };
    }
});

// Prompt Settings IPC Handlers
ipcMain.handle('save-prompts', async (event, { bookPath, prompts }) => {
    try {
        if (!bookPath) {
            throw new Error('Book path is required');
        }
        const promptsPath = path.join(bookPath, 'prompts.json');
        await fsPromises.writeFile(promptsPath, JSON.stringify(prompts, null, 2));
        return { success: true };
    } catch (error) {
        console.error('Error saving prompts:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-prompts', async (event, bookPath) => {
    try {
        if (!bookPath) {
            return { success: false };
        }
        const promptsPath = path.join(bookPath, 'prompts.json');
        const data = await fsPromises.readFile(promptsPath, 'utf-8');
        return { success: true, prompts: JSON.parse(data) };
    } catch (error) {
        // Return success false if file doesn't exist, it's not an error
        return { success: false };
    }
});

// Tags IPC Handlers
ipcMain.handle('save-tags', async (event, { bookPath, tags }) => {
    try {
        if (!bookPath) {
            throw new Error('Book path is required');
        }
        const tagsPath = path.join(bookPath, 'tags.json');
        await fsPromises.writeFile(tagsPath, JSON.stringify(tags, null, 2));
        return { success: true };
    } catch (error) {
        console.error('Error saving tags:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-tags', async (event, bookPath) => {
    try {
        if (!bookPath) {
            return { success: false };
        }
        const tagsPath = path.join(bookPath, 'tags.json');
        const data = await fsPromises.readFile(tagsPath, 'utf-8');
        return { success: true, tags: JSON.parse(data) };
    } catch (error) {
        // Return success false if file doesn't exist, it's not an error
        return { success: false };
    }
});

// CLI Tools Check IPC Handler
ipcMain.handle('check-cli-tools', async () => {
    try {
        const results = await terminalServer.checkAllCLITools();
        return { success: true, tools: results };
    } catch (error) {
        console.error('Error checking CLI tools:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('test-api-key', async (event, apiKey) => {
    try {
        const testGenAI = new GoogleGenerativeAI(apiKey);
        const model = testGenAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
        
        // Test with a simple prompt
        const result = await model.generateContent('Say "API key is working" if you can read this.');
        const response = await result.response;
        const text = response.text();
        
        return { 
            success: true, 
            working: text.toLowerCase().includes('api key is working') || text.toLowerCase().includes('working')
        };
    } catch (error) {
        console.error('API key test failed:', error);
        return { 
            success: false, 
            error: error.message 
        };
    }
});

// Helper function to get custom prompts or defaults
async function getCustomPrompts(bookPath) {
    try {
        if (bookPath) {
            const promptsPath = path.join(bookPath, 'prompts.json');
            const data = await fsPromises.readFile(promptsPath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        // Continue to return defaults
    }
    
    // Return defaults if no custom prompts saved
    return {
            characterIdentification: `Use advanced reasoning to identify when different names/titles refer to the same person
Examples: "Didius Falco" = "Falco", "the young prince" = "Prince Adrian" = "Adrian"
Merge all references into a single character entry using the most complete/formal name`,
            
            physicalDescription: `Extract ALL physical details mentioned about each character FROM HEAD TO TOE
CRITICAL: Always describe the complete person for full body portraits:
- HEAD/HAIR: Hair color, style, length, texture, any head coverings, hair accessories
- FACE: Eyes, nose, mouth, skin tone, facial hair, distinguishing features
- BODY: Build, height, posture, skin marks, tattoos, scars
- CLOTHING: Every layer from top to bottom, colors, materials, condition
- FEET/FOOTWEAR: ALWAYS include footwear details (boots, sandals, shoes, bare feet, etc.)
If feet/footwear not mentioned in text, note "footwear not specified" but suggest appropriate footwear for the character's status/setting
Note when new details are revealed (e.g., a birthmark mentioned for the first time in chapter 5)`,
            
            characterEvolution: `Identify when a character's appearance changes significantly
Create sub-characteristics for major transformations:
* Age progression (young prince → middle-aged king → elderly ruler)
* Status changes affecting appearance (peasant → knight → lord)
* Physical changes (injuries, scars, weight changes, hair changes)
* Costume/role changes (disguises, different outfits for different scenes)`,
            
            descriptionDetail: `Make descriptions vivid and specific FOR FULL BODY PORTRAITS
For baseDescription: Include chapter references and detailed analysis from head to toe
For imagePrompt: Create clean COMPLETE head-to-toe visual descriptions without chapter refs
CRITICAL for imagePrompt:
- Start with age, gender, overall build
- Describe head/hair in detail (color, style, length, accessories)
- Include all facial features
- Describe complete outfit from top to bottom
- ALWAYS end with footwear (even if you must infer appropriate footwear)
Example: "tall man, approximately 6'2", broad shoulders, athletic build" → "tall man, 6'2", broad shoulders, athletic build, short dark hair, brown eyes, weathered face with realistic wrinkles, black tunic, leather belt, dark trousers, worn leather boots"
The goal is a COMPLETE person that AI can generate as a full body portrait
IMPORTANT: Describe realistic human proportions and features, avoid exaggerated features`
        };
}

// REMOVED: Direct API character extraction handler
// Character extraction now only works through CLI tools (Claude Code or Gemini CLI)

// CLI-based character extraction handler
ipcMain.handle('get-main-characters-cli', async (event, { transcript, existingCharacters, chapterNumber, bookPath, contextInfo }) => {
    try {
        // Get custom prompts
        const customPrompts = await getCustomPrompts(bookPath);
        
        // Use book-specific directory for character extraction instructions
        const aiWorkspaceDir = path.join(bookPath, 'character_extraction_instructions');
        const result = await characterExtractionCLI.prepareCharacterExtraction({
            transcript,
            existingCharacters,
            chapterNumber,
            bookPath,
            customPrompts,
            tempDir: aiWorkspaceDir,
            contextInfo: contextInfo
        });
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            promptFile: result.promptFile,
            bookPath: result.bookPath
        };
    } catch (error) {
        console.error('Error preparing character extraction:', error);
        return { error: error.message };
    }
});

// Batch CLI-based character extraction handler
ipcMain.handle('get-main-characters-batch-cli', async (event, { chapters, existingCharacters, bookPath, contextInfo }) => {
    try {
        // Get custom prompts
        const customPrompts = await getCustomPrompts(bookPath);
        
        // Use book-specific directory for character extraction instructions
        const aiWorkspaceDir = path.join(bookPath, 'character_extraction_instructions');
        const result = await characterExtractionCLI.prepareBatchCharacterExtraction({
            chapters,
            existingCharacters,
            bookPath,
            customPrompts,
            tempDir: aiWorkspaceDir,
            contextInfo: contextInfo
        });
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            promptFile: result.promptFile,
            bookPath: result.bookPath,
            chapterCount: result.chapterCount
        };
    } catch (error) {
        console.error('Error preparing batch character extraction:', error);
        console.error('Error stack:', error.stack);
        return { error: error.message };
    }
});

// Regenerate character description handler
ipcMain.handle('regenerate-character-description', async (event, { characterName, transcript, selectedChapters, bookPath }) => {
    try {
        if (!genAI || !GEMINI_API_KEY) {
            throw new Error('Gemini API key not configured. Please set your API key in Settings.');
        }
        
        // Get custom prompts
        const customPrompts = await getCustomPrompts(bookPath);
        
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
        const prompt = `You are an intelligent character analyzer for an audiobook. Your task is to regenerate the description for a specific character based on selected chapters only.

Character to regenerate: ${characterName}

Selected chapters: ${selectedChapters.join(', ')}

Here is the transcript content from the selected chapters:
---
${transcript}
---

CRITICAL INSTRUCTIONS:

1. **Focus ONLY on the character named "${characterName}"**
   - Ignore all other characters
   - ${customPrompts.characterIdentification}

2. **Physical Description Building**
   ${customPrompts.physicalDescription}

3. **Character Evolution & Sub-Characteristics**
   ${customPrompts.characterEvolution}
   - ONLY include sub-characteristics that appear in the selected chapters
   
4. **Detailed Appearance Descriptions**
   ${customPrompts.descriptionDetail}

5. **Chapter Tracking**
   - Only include chapter numbers from the selected chapters: ${selectedChapters.join(', ')}
   - Do not reference chapters that weren't selected

Return ONLY the JSON object for the character "${characterName}" with this exact structure:
{
  "name": "${characterName}",
  "baseDescription": "Default/most common appearance - extremely detailed physical description WITH chapter references from selected chapters",
  "imagePrompt": "Clean description for image generation WITHOUT chapter references or commentary - just pure visual description",
  "photo": "placeholder.png",
  "chapters": [${selectedChapters.join(', ')}],
  "personalityTraits": "Brief personality description based on actions/dialogue in selected chapters",
  "subCharacteristics": [
    // Only include versions that appear in the selected chapters
    // Each must have both "description" (with references) and "imagePrompt" (clean)
  ]
}

IMPORTANT FORMATTING RULES:
- baseDescription: Include ALL details with chapter references for user reference
- imagePrompt: ONLY visual details, NO chapter references, NO commentary like "described as", "seemingly", etc. Write as direct visual facts for AI image generation
- imagePrompt MUST be complete head-to-toe description: hair, face, body, full outfit, and ALWAYS include footwear
- If footwear not mentioned in text, add contextually appropriate footwear (e.g., "leather boots" for medieval, "sandals" for Roman, etc.)
- Same rules apply to subCharacteristics

IMPORTANT: Return ONLY the JSON object for this single character, not an array.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Clean the text to ensure it's valid JSON
        const cleanedText = text.replace(/```json\n|```/g, '').trim();
        const character = JSON.parse(cleanedText);
        
        return { character };
    } catch (error) {
        console.error('Error regenerating character description:', error);
        return { error: error.message };
    }
});

// Dialog handler for directory selection
ipcMain.handle('dialog-select-directory', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select ComfyUI Installation Directory'
    });
    return result;
});

// ComfyUI Settings IPC Handlers
ipcMain.handle('comfyui-get-path', async () => {
    return comfyUIManager.getComfyUIPath();
});

ipcMain.handle('comfyui-set-path', async (event, installPath) => {
    try {
        comfyUIManager.setComfyUIPath(installPath);
        const validation = await comfyUIManager.validateInstallation();
        return { success: true, validation };
    } catch (error) {
        console.error('Error setting ComfyUI path:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('comfyui-validate-installation', async () => {
    try {
        return await comfyUIManager.validateInstallation();
    } catch (error) {
        console.error('Error validating ComfyUI installation:', error);
        return { valid: false, error: error.message };
    }
});

ipcMain.handle('comfyui-get-status', async () => {
    try {
        return await comfyUIManager.getStatus();
    } catch (error) {
        console.error('Error getting ComfyUI status:', error);
        return { error: error.message };
    }
});

ipcMain.handle('comfyui-start', async (event) => {
    try {
        return await comfyUIManager.start((progress) => {
            event.sender.send('comfyui-start-progress', progress);
        });
    } catch (error) {
        console.error('Error starting ComfyUI:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('comfyui-stop', async () => {
    try {
        return await comfyUIManager.stop();
    } catch (error) {
        console.error('Error stopping ComfyUI:', error);
        return { success: false, error: error.message };
    }
});

// FLUX Service Management IPC Handlers
ipcMain.handle('flux-get-setup-status', async () => {
    try {
        // Check ComfyUI status first
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet) {
            // Return ComfyUI-based status
            return {
                docker: { installed: false, running: false },
                service: {
                    exists: comfyStatus.valid,
                    running: comfyStatus.running,
                    healthy: comfyStatus.running,
                    isComfyUI: true
                },
                comfyUI: comfyStatus
            };
        }
        
        // Fall back to Docker-based status
        return await fluxManager.getSetupStatus();
    } catch (error) {
        console.error('Error getting FLUX setup status:', error);
        return { error: error.message };
    }
});

ipcMain.handle('flux-start-service', async (event) => {
    try {
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet) {
            // Start ComfyUI instead of Docker
            return await comfyUIManager.start((progress) => {
                event.sender.send('flux-setup-progress', progress);
            });
        }
        
        // Fall back to Docker
        return new Promise((resolve, reject) => {
            fluxManager.startService((progress) => {
                // Send progress updates to renderer
                event.sender.send('flux-setup-progress', progress);
            }).then(resolve).catch(reject);
        });
    } catch (error) {
        console.error('Error starting FLUX service:', error);
        return { error: error.message };
    }
});

ipcMain.handle('flux-stop-service', async () => {
    try {
        // Check if ComfyUI is configured and running
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet && (comfyStatus.running || comfyUIManager.comfyUIProcess)) {
            console.log('Stopping ComfyUI service...');
            return await comfyUIManager.stop();
        }
        
        // Fall back to Docker
        console.log('Attempting to stop Docker service...');
        return await fluxManager.stopService();
    } catch (error) {
        console.error('Error stopping FLUX service:', error);
        return { error: error.message };
    }
});

ipcMain.handle('flux-get-logs', async () => {
    try {
        return await fluxManager.getLogs();
    } catch (error) {
        console.error('Error getting FLUX logs:', error);
        return { error: error.message };
    }
});

// FLUX Service API IPC Handlers
ipcMain.handle('flux-get-models-status', async () => {
    try {
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet) {
            return await fluxServiceLocal.getModelsStatus();
        }
        
        // Fall back to Docker API
        const response = await fetch('http://localhost:8001/models/status');
        if (response.ok) {
            return await response.json();
        }
        throw new Error('Failed to get models status');
    } catch (error) {
        // Only log non-connection errors (connection refused is expected when service is not running)
        if (!error.cause || error.cause.code !== 'ECONNREFUSED') {
            console.error('Error getting FLUX models status:', error);
        }
        return { error: error.message };
    }
});

// Check if HuggingFace token exists
ipcMain.handle('check-hf-token', async () => {
    return { hasToken: !!HUGGINGFACE_TOKEN };
});

ipcMain.handle('flux-download-model', async (event, { modelKey, hfToken }) => {
    console.log('Starting download for model:', modelKey);
    try {
        const token = hfToken || HUGGINGFACE_TOKEN;
        console.log('Using token:', token ? 'Yes' : 'No');
        
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet) {
            // Use local download
            return await fluxServiceLocal.downloadModel(modelKey, token, (progress) => {
                event.sender.send('flux-download-progress', { 
                    modelKey, 
                    status: {
                        downloading: true,
                        progress: progress.progress,
                        downloadedSize: progress.downloadedSize,
                        totalSize: progress.totalSize
                    }
                });
            });
        }
        
        // Fall back to Docker API
        const response = await fetch(`http://localhost:8001/models/download/${modelKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                hf_token: token 
            })
        });
        
        console.log('Download response status:', response.status);
        
        if (response.ok) {
            const result = await response.json();
            console.log('Download started:', result);
            
            // Start polling for download progress
            const pollProgress = async () => {
                try {
                    const statusResponse = await fetch(`http://localhost:8001/models/download/status/${modelKey}`);
                    if (statusResponse.ok) {
                        const status = await statusResponse.json();
                        event.sender.send('flux-download-progress', { modelKey, status });
                        
                        if (!status.downloading || status.error) {
                            console.log('Download finished:', modelKey, status);
                            return;
                        }
                    }
                } catch (error) {
                    console.error('Error polling download status:', error);
                }
                
                setTimeout(pollProgress, 1000);
            };
            
            pollProgress();
            return result;
        }
        
        const errorText = await response.text();
        console.error('Download failed:', errorText);
        throw new Error(`Failed to start download: ${response.status} ${errorText}`);
    } catch (error) {
        console.error('Error downloading FLUX model:', error);
        return { error: error.message };
    }
});

ipcMain.handle('flux-edit-image', async (event, { prompt, image, settings }) => {
    try {
        // Check current generation service
        if (currentGenerationService === 'runpod') {
            // Using RunPod service for editing
            const config = {
                runpodApiKey: RUNPOD_API_KEY,
                runpodEndpointId: RUNPOD_ENDPOINT_ID,
                modelPrecision: settings.modelPrecision || 'fp8',
                huggingfaceToken: HUGGINGFACE_TOKEN
            };
            
            if (!fluxServiceRunPod.isConfigured) {
                await fluxServiceRunPod.initialize(config);
            }
            
            return await fluxServiceRunPod.editImage({
                prompt,
                image,
                modelPrecision: settings.modelPrecision || 'fp8',
                width: settings.width || 1024,
                height: settings.height || 1024,
                steps: settings.steps || 20,
                guidance: settings.guidance || 3.5,
                seed: settings.seed,
                sampler: settings.sampler || 'euler',
                scheduler: settings.scheduler || 'simple'
            });
        }
        
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet && comfyStatus.running) {
            return await fluxServiceLocal.editImage({
                prompt,
                image,
                modelPrecision: settings.modelPrecision || 'fp8',
                width: settings.width || 512,
                height: settings.height || 512,
                steps: settings.steps || 20,
                guidance: settings.guidance || 3.5,
                seed: settings.seed
            });
        }
        
        // Fall back to Docker API
        const response = await fetch('http://localhost:8001/edit/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                image,
                model_precision: settings.modelPrecision || 'fp8',
                width: settings.width || 512,
                height: settings.height || 512,
                steps: settings.steps || 20,
                guidance: settings.guidance || 3.5,
                seed: settings.seed
            })
        });
        
        if (response.ok) {
            return await response.json();
        }
        
        return { error: `HTTP ${response.status}: ${response.statusText}` };
    } catch (error) {
        console.error('Error calling FLUX edit service:', error);
        return { error: error.message };
    }
});

ipcMain.handle('flux-generate-kontext', async (event, { prompt, character_image_1, character_image_2, settings }) => {
    try {
        const params = {
            prompt,
            characterImages: [character_image_1, character_image_2],
            modelPrecision: settings.modelPrecision || 'fp8',
            width: settings.width || 512,
            height: settings.height || 512,
            steps: settings.steps || 20,
            guidance: settings.guidance || 3.5,
            seed: settings.seed,
            sampler: settings.sampler || 'euler',
            scheduler: settings.scheduler || 'simple'
        };
        
        // Use RunPod if selected
        if (currentGenerationService === 'runpod') {
            // Using RunPod service for Kontext generation
            
            if (!RUNPOD_API_KEY) {
                throw new Error('RunPod API key not configured');
            }
            
            // Initialize RunPod service if needed
            if (!fluxServiceRunPod.isConfigured) {
                await fluxServiceRunPod.initialize({
                    runpodApiKey: RUNPOD_API_KEY,
                    runpodEndpointId: RUNPOD_ENDPOINT_ID,
                    modelPrecision: settings.modelPrecision || 'fp8',
                    huggingfaceToken: HUGGINGFACE_TOKEN
                });
            }
            
            const jobId = await fluxServiceRunPod.generateImage(params);
            return { jobId, service: 'runpod' };
        }
        
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        
        if (comfyStatus.pathSet && comfyStatus.running) {
            return await fluxServiceLocal.generateKontext({
                prompt,
                characterImage1: character_image_1,
                characterImage2: character_image_2,
                modelPrecision: settings.modelPrecision || 'fp8',
                width: settings.width || 512,
                height: settings.height || 512,
                steps: settings.steps || 20,
                guidance: settings.guidance || 3.5,
                seed: settings.seed
            });
        }
        
        // Fall back to Docker API
        const response = await fetch('http://localhost:8001/generate/kontext', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                character_image_1,
                character_image_2,
                model_precision: settings.modelPrecision || 'fp8',
                width: settings.width || 512,
                height: settings.height || 512,
                steps: settings.steps || 20,
                guidance: settings.guidance || 3.5,
                seed: settings.seed
            })
        });
        
        if (response.ok) {
            return await response.json();
        }
        
        const error = await response.text();
        throw new Error(error || 'Generation failed');
    } catch (error) {
        console.error('Error generating Kontext image:', error);
        
        // If Docker service is not available and ComfyUI is not running
        if (error.cause?.code === 'ECONNREFUSED') {
            return { 
                error: 'Neither ComfyUI nor Docker FLUX service is running. Please start the FLUX service from the System Monitor.'
            };
        }
        
        return { error: error.message };
    }
});

// Single character Kontext generation
ipcMain.handle('flux-generate-kontext-single', async (event, { prompt, character_image, settings }) => {
    try {
        const params = {
            prompt,
            characterImages: [character_image],
            modelPrecision: settings.modelPrecision || 'fp8',
            width: settings.width || 512,
            height: settings.height || 512,
            steps: settings.steps || 20,
            guidance: settings.guidance || 3.5,
            seed: settings.seed,
            sampler: settings.sampler || 'euler',
            scheduler: settings.scheduler || 'simple'
        };
        
        // Use RunPod if selected
        if (currentGenerationService === 'runpod') {
            // Using RunPod service for single Kontext generation
            
            if (!RUNPOD_API_KEY) {
                throw new Error('RunPod API key not configured');
            }
            
            // Initialize RunPod service if needed
            if (!fluxServiceRunPod.isConfigured) {
                await fluxServiceRunPod.initialize({
                    runpodApiKey: RUNPOD_API_KEY,
                    runpodEndpointId: RUNPOD_ENDPOINT_ID,
                    modelPrecision: settings.modelPrecision || 'fp8',
                    huggingfaceToken: HUGGINGFACE_TOKEN
                });
            }
            
            const jobId = await fluxServiceRunPod.generateImage(params);
            return { jobId, service: 'runpod' };
        }
        
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        
        if (comfyStatus.pathSet && comfyStatus.running) {
            return await fluxServiceLocal.generateKontextSingle({
                prompt,
                characterImage: character_image,
                modelPrecision: settings.modelPrecision || 'fp8',
                width: settings.width || 512,
                height: settings.height || 512,
                steps: settings.steps || 20,
                guidance: settings.guidance || 3.5,
                seed: settings.seed
            });
        }
        
        // Fall back to Docker API
        const response = await fetch('http://localhost:8001/generate/kontext-single', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                character_image,
                model_precision: settings.modelPrecision || 'fp8',
                width: settings.width || 512,
                height: settings.height || 512,
                steps: settings.steps || 20,
                guidance: settings.guidance || 3.5,
                seed: settings.seed
            })
        });
        
        if (response.ok) {
            return await response.json();
        }
        
        const error = await response.text();
        throw new Error(error || 'Generation failed');
    } catch (error) {
        console.error('Error generating single character Kontext image:', error);
        
        // If Docker service is not available and ComfyUI is not running
        if (error.cause?.code === 'ECONNREFUSED') {
            return { 
                error: 'Neither ComfyUI nor Docker FLUX service is running. Please start the FLUX service from the System Monitor.'
            };
        }
        
        return { error: error.message };
    }
});

ipcMain.handle('flux-generate-image', async (event, { prompt, settings }) => {
    try {
        const params = {
            prompt,
            modelPrecision: settings.modelPrecision || 'fp8',
            width: settings.width || 512,
            height: settings.height || 512,
            steps: settings.steps || 20,
            guidance: settings.guidance || 3.5,
            seed: settings.seed,
            sampler: settings.sampler || 'euler',
            scheduler: settings.scheduler || 'simple'
        };
        
        // Use RunPod if selected
        if (currentGenerationService === 'runpod') {
            // Using RunPod service for generation
            
            if (!RUNPOD_API_KEY) {
                throw new Error('RunPod API key not configured');
            }
            
            // Initialize RunPod service if needed
            if (!fluxServiceRunPod.isConfigured) {
                // Initialize RunPod service if needed
                await fluxServiceRunPod.initialize({
                    runpodApiKey: RUNPOD_API_KEY,
                    runpodEndpointId: RUNPOD_ENDPOINT_ID,
                    modelPrecision: settings.modelPrecision || 'fp8',
                    huggingfaceToken: HUGGINGFACE_TOKEN
                });
            }
            
            // Submit job to RunPod
            const jobId = await fluxServiceRunPod.generateImage(params);
            return { jobId, service: 'runpod' };
        }
        
        // Check if ComfyUI is configured for local generation
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet && comfyStatus.running) {
            return await fluxServiceLocal.generateTextToImage(params);
        }
        
        // Fall back to Docker API
        const response = await fetch('http://localhost:8001/generate/text-to-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                model_precision: settings.modelPrecision || 'fp8',
                width: settings.width || 512,
                height: settings.height || 512,
                steps: settings.steps || 20,
                guidance: settings.guidance || 3.5,
                seed: settings.seed,
                sampler: settings.sampler || 'euler',
                scheduler: settings.scheduler || 'simple'
            })
        });
        
        if (response.ok) {
            return await response.json();
        }
        
        const error = await response.json();
        throw new Error(error.detail || 'Failed to generate image');
    } catch (error) {
        console.error('Error generating FLUX image:', error);
        return { error: error.message };
    }
});

ipcMain.handle('flux-get-job-status', async (event, { jobId, service }) => {
    try {
        // Check if this is a RunPod job
        if (service === 'runpod' || currentGenerationService === 'runpod') {
            return await fluxServiceRunPod.getJobStatus(jobId);
        }
        
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet && comfyStatus.running) {
            return fluxServiceLocal.getJobStatus(jobId);
        }
        
        // Fall back to Docker API
        const response = await fetch(`http://localhost:8001/job/${jobId}`);
        if (response.ok) {
            return await response.json();
        }
        throw new Error('Failed to get job status');
    } catch (error) {
        console.error('Error getting job status:', error);
        return { error: error.message };
    }
});

ipcMain.handle('flux-get-image', async (event, { jobId }) => {
    try {
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet && comfyStatus.running) {
            const imageData = fluxServiceLocal.getJobImage(jobId);
            if (imageData) {
                return imageData;
            }
            throw new Error('Image not found');
        }
        
        // Fall back to Docker API
        const response = await fetch(`http://localhost:8001/image/${jobId}`);
        if (response.ok) {
            const buffer = await response.arrayBuffer();
            return Buffer.from(buffer);
        }
        throw new Error('Failed to get image');
    } catch (error) {
        console.error('Error getting FLUX image:', error);
        return { error: error.message };
    }
});

ipcMain.handle('flux-get-settings', async () => {
    try {
        // Check if ComfyUI is configured
        const comfyStatus = await comfyUIManager.getStatus();
        if (comfyStatus.pathSet) {
            return fluxServiceLocal.getSettings();
        }
        
        // Fall back to Docker API
        const response = await fetch('http://localhost:8001/settings');
        if (response.ok) {
            return await response.json();
        }
        throw new Error('Failed to get FLUX settings');
    } catch (error) {
        // Only log non-connection errors
        if (!error.cause || error.cause.code !== 'ECONNREFUSED') {
            console.error('Error getting FLUX settings:', error);
        }
        return { error: error.message };
    }
});

// Whisper Service Management IPC Handlers
ipcMain.handle('whisper-get-setup-status', async () => {
    try {
        // Check if whisper is installed
        const isWhisperInstalled = await whisperLocal.isWhisperInstalled();
        
        // Check if any Whisper models are available
        const modelsStatus = await whisperLocal.getModelsStatus();
        const hasAnyModel = Object.values(modelsStatus).some(model => model.available);
        
        return {
            docker: { installed: false, running: false },
            service: {
                exists: isWhisperInstalled,
                running: isWhisperInstalled && hasAnyModel,
                healthy: isWhisperInstalled && hasAnyModel
            },
            whisperBinary: isWhisperInstalled
        };
    } catch (error) {
        console.error('Error getting Whisper setup status:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-start-service', async (event) => {
    try {
        // Local whisper doesn't need to be started
        event.sender.send('whisper-setup-progress', { progress: 100, message: 'Local Whisper ready!' });
        return { success: true };
    } catch (error) {
        console.error('Error starting Whisper service:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-stop-service', async () => {
    try {
        // Local whisper doesn't need to be stopped
        return { success: true };
    } catch (error) {
        console.error('Error stopping Whisper service:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-restart-service', async () => {
    try {
        // Local whisper doesn't need to be restarted
        whisperLocal.unloadAllModels();
        return { success: true };
    } catch (error) {
        console.error('Error restarting Whisper service:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-get-logs', async () => {
    try {
        // Local whisper doesn't have logs
        return { stdout: 'Local Whisper service running', stderr: '' };
    } catch (error) {
        console.error('Error getting Whisper logs:', error);
        return { error: error.message };
    }
});

// Whisper Service API IPC Handlers
ipcMain.handle('whisper-get-models-status', async () => {
    try {
        return await whisperLocal.getModelsStatus();
    } catch (error) {
        console.error('Error getting Whisper models status:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-download-model', async (event, modelName) => {
    try {
        const result = await whisperLocal.downloadModel(modelName, (progress) => {
            event.sender.send('whisper-download-progress', progress);
        });
        return result;
    } catch (error) {
        console.error('Error downloading Whisper model:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-transcribe', async (event, { audioPath, modelName, language }) => {
    try {
        // Check if we should use RunPod for transcription
        if (currentWhisperService === 'runpod') {
            // Initialize RunPod whisper if needed
            if (!whisperServiceRunPod.isConfigured) {
                const config = {
                    runpodApiKey: RUNPOD_API_KEY,
                    whisperEndpointId: WHISPER_RUNPOD_ENDPOINT_ID
                };
                await whisperServiceRunPod.initialize(config);
            }
            
            // Submit transcription job to RunPod
            const result = await whisperServiceRunPod.transcribeAudio({
                audioPath,
                modelSize: modelName || 'base',
                language: language || null,
                task: 'transcribe',
                wordTimestamps: true
            });
            
            return result; // Returns { jobId, service: 'runpod' }
        } else {
            // Use local whisper
            const result = await whisperLocal.transcribe(audioPath, {
                modelName: modelName || 'base',
                language: language || 'en'
            });
            return result;
        }
    } catch (error) {
        console.error('Error calling Whisper service:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-transcribe-base64', async (event, { audioData, filename, modelName, language }) => {
    try {
        // Convert base64 to file temporarily
        const tempPath = path.join(os.tmpdir(), `whisper-${Date.now()}-${filename}`);
        const base64Data = audioData.replace(/^data:audio\/\w+;base64,/, '');
        fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));
        
        // Create a job-like response for compatibility
        const jobId = `local-${Date.now()}`;
        
        // Start transcription asynchronously
        setTimeout(async () => {
            try {
                const result = await whisperLocal.transcribe(tempPath, {
                    modelName: modelName || 'base',
                    language: language || 'en'
                });
                
                // Store result temporarily
                global.whisperJobs = global.whisperJobs || {};
                global.whisperJobs[jobId] = {
                    status: 'completed',
                    result
                };
                
                // Clean up temp file
                fs.unlinkSync(tempPath);
            } catch (error) {
                global.whisperJobs = global.whisperJobs || {};
                global.whisperJobs[jobId] = {
                    status: 'failed',
                    error: error.message
                };
                
                // Clean up temp file
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            }
        }, 100);
        
        return { job_id: jobId };
    } catch (error) {
        console.error('Error calling Whisper service:', error);
        return { error: error.message };
    }
});

// Whisper job status handler
ipcMain.handle('whisper-get-job-status', async (event, { jobId, service }) => {
    try {
        // Check if this is a RunPod job
        if (service === 'runpod' || jobId.startsWith('runpod_')) {
            return await whisperServiceRunPod.getJobStatus(jobId);
        }
        
        // Otherwise it's a local job
        global.whisperJobs = global.whisperJobs || {};
        const job = global.whisperJobs[jobId];
        
        if (!job) {
            return { status: 'error', error: 'Job not found' };
        }
        
        return job;
    } catch (error) {
        console.error('Error getting whisper job status:', error);
        return { status: 'error', error: error.message };
    }
});


ipcMain.handle('whisper-get-job-result', async (event, jobId) => {
    try {
        global.whisperJobs = global.whisperJobs || {};
        const job = global.whisperJobs[jobId];
        
        if (!job || !job.result) {
            throw new Error('Job result not found');
        }
        
        const result = job.result;
        // Clean up job after retrieving result
        delete global.whisperJobs[jobId];
        
        return result;
    } catch (error) {
        console.error('Error getting job result:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-unload-model', async (event, modelName) => {
    try {
        return whisperLocal.unloadModel();
    } catch (error) {
        console.error('Error unloading model:', error);
        return { error: error.message };
    }
});

ipcMain.handle('whisper-unload-all-models', async () => {
    try {
        return whisperLocal.unloadAllModels();
    } catch (error) {
        console.error('Error unloading all models:', error);
        return { error: error.message };
    }
});

// Story context IPC handlers
ipcMain.handle('get-story-context', async (event, bookPath) => {
    try {
        const contextFile = path.join(bookPath, 'story_context.json');
        if (fs.existsSync(contextFile)) {
            const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
            return { success: true, context };
        }
        return { success: false, error: 'No context file found' };
    } catch (error) {
        console.error('Error loading story context:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('save-story-context', async (event, { bookPath, context }) => {
    try {
        const contextFile = path.join(bookPath, 'story_context.json');
        fs.writeFileSync(contextFile, JSON.stringify(context, null, 2));
        return { success: true };
    } catch (error) {
        console.error('Error saving story context:', error);
        return { success: false, error: error.message };
    }
});

// Storyboard tags IPC handlers
ipcMain.handle('get-storyboard-tags', async (event, bookPath) => {
    try {
        const tagsFile = path.join(bookPath, 'storyboard_tags.json');
        if (fs.existsSync(tagsFile)) {
            const tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'));
            return { success: true, tags };
        }
        return { success: false, error: 'No storyboard tags file found' };
    } catch (error) {
        console.error('Error loading storyboard tags:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('save-storyboard-tags', async (event, { bookPath, tags }) => {
    try {
        const tagsFile = path.join(bookPath, 'storyboard_tags.json');
        fs.writeFileSync(tagsFile, JSON.stringify(tags, null, 2));
        return { success: true };
    } catch (error) {
        console.error('Error saving storyboard tags:', error);
        return { success: false, error: error.message };
    }
});


// CPU usage tracking
let previousCpuInfo = null;

// System monitoring IPC handlers
ipcMain.handle('get-system-stats', async () => {
    try {
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const usedMemory = totalMemory - freeMemory;
        const memoryPercentage = Math.round((usedMemory / totalMemory) * 100);
        
        // Calculate CPU usage with proper idle time tracking
        const cpus = os.cpus();
        let currentCpuInfo = { idle: 0, total: 0 };
        
        cpus.forEach(cpu => {
            for (const type in cpu.times) {
                currentCpuInfo.total += cpu.times[type];
            }
            currentCpuInfo.idle += cpu.times.idle;
        });
        
        let cpuPercentage = 0;
        if (previousCpuInfo) {
            const idleDiff = currentCpuInfo.idle - previousCpuInfo.idle;
            const totalDiff = currentCpuInfo.total - previousCpuInfo.total;
            cpuPercentage = Math.round(100 - (100 * idleDiff / totalDiff));
            cpuPercentage = Math.max(0, Math.min(100, cpuPercentage)); // Clamp between 0-100
        }
        
        previousCpuInfo = currentCpuInfo;
        
        // GPU stats - Try platform-specific commands
        let gpuPercentage = 0;
        let vramPercentage = 0;
        
        if (process.platform === 'win32') {
            // Try nvidia-smi for NVIDIA GPUs on Windows
            try {
                const { stdout } = await execPromise('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits');
                const [utilization, memUsed, memTotal] = stdout.trim().split(',').map(v => parseInt(v.trim()));
                
                if (!isNaN(utilization)) {
                    gpuPercentage = utilization;
                }
                
                if (!isNaN(memUsed) && !isNaN(memTotal) && memTotal > 0) {
                    vramPercentage = Math.round((memUsed / memTotal) * 100);
                }
            } catch (e) {
                // nvidia-smi not available or failed
                console.log('GPU monitoring not available');
            }
        } else if (process.platform === 'linux') {
            // Try nvidia-smi for Linux
            try {
                const { stdout } = await execPromise('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits');
                const [utilization, memUsed, memTotal] = stdout.trim().split(',').map(v => parseInt(v.trim()));
                
                if (!isNaN(utilization)) {
                    gpuPercentage = utilization;
                }
                
                if (!isNaN(memUsed) && !isNaN(memTotal) && memTotal > 0) {
                    vramPercentage = Math.round((memUsed / memTotal) * 100);
                }
            } catch (e) {
                // Try AMD GPU command
                try {
                    const { stdout } = await execPromise('rocm-smi --showuse --csv');
                    // Parse AMD GPU stats if available
                } catch (e2) {
                    console.log('GPU monitoring not available');
                }
            }
        }
        
        return {
            memory: {
                percentage: memoryPercentage
            },
            cpu: {
                percentage: cpuPercentage
            },
            gpu: {
                percentage: gpuPercentage
            },
            vram: {
                percentage: vramPercentage
            }
        };
    } catch (error) {
        console.error('Error getting system stats:', error);
        return { error: error.message };
    }
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false // Allow loading local files
        }
    });

    win.loadFile('index.html');
    
    // Uncomment the next line to open DevTools automatically
    // win.webContents.openDevTools();
}

app.whenReady().then(async () => {
    // Load API key from secure storage
    loadApiKey();
    
    // Initialize RunPod service if API key is available
    if (RUNPOD_API_KEY && currentGenerationService === 'runpod') {
        try {
            await fluxServiceRunPod.initialize({
                runpodApiKey: RUNPOD_API_KEY,
                runpodEndpointId: RUNPOD_ENDPOINT_ID,
                modelPrecision: 'fp8',
                huggingfaceToken: HUGGINGFACE_TOKEN
            });
            console.log('[Main] RunPod service initialized successfully');
        } catch (error) {
            console.error('[Main] Failed to initialize RunPod service:', error);
        }
    }
    
    // Start local terminal server
    terminalServer.start();
    
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Stop terminal server
    terminalServer.stop();
    
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Docker Management IPC Handlers
ipcMain.handle('docker-check', async () => {
    try {
        const initialized = await dockerManager.initialize();
        if (!initialized) {
            return { 
                available: false, 
                error: 'Docker not found. Please install Docker Desktop.' 
            };
        }
        
        await dockerManager.checkDockerRunning();
        const info = await dockerManager.getDockerInfo();
        
        return { 
            available: true,
            version: info.version,
            info: info
        };
    } catch (error) {
        return { 
            available: false, 
            error: error.message 
        };
    }
});

ipcMain.handle('docker-login', async (event, { username, accessToken, registry }) => {
    try {
        const result = await dockerManager.dockerLogin(username, accessToken, registry);
        return result;
    } catch (error) {
        return { 
            success: false, 
            error: error.message 
        };
    }
});

ipcMain.handle('docker-build-runpod-image', async (event, { dockerUsername, onProgress }) => {
    try {
        // Path to our RunPod Dockerfile
        const dockerfilePath = path.join(__dirname, 'runpod', 'Dockerfile');
        const imageName = `${dockerUsername}/comfyui-flux-kontext`;
        
        // Check if Dockerfile exists
        const dockerfileExists = await fsPromises.access(dockerfilePath).then(() => true).catch(() => false);
        if (!dockerfileExists) {
            throw new Error('RunPod Dockerfile not found');
        }
        
        // Build the image
        const buildResult = await dockerManager.buildImage({
            dockerfilePath,
            imageName,
            tag: 'latest',
            onProgress: (progress) => {
                // Send progress to renderer
                event.sender.send('docker-build-progress', progress);
            }
        });
        
        return buildResult;
    } catch (error) {
        return { 
            success: false, 
            error: error.message 
        };
    }
});

ipcMain.handle('docker-push-image', async (event, { imageName, tag, registry, onProgress }) => {
    try {
        const pushResult = await dockerManager.pushImage({
            imageName,
            tag,
            registry,
            onProgress: (progress) => {
                // Send progress to renderer
                event.sender.send('docker-push-progress', progress);
            }
        });
        
        return pushResult;
    } catch (error) {
        return { 
            success: false, 
            error: error.message 
        };
    }
});

ipcMain.handle('docker-build-and-push', async (event, { dockerUsername, dockerAccessToken }) => {
    try {
        // Initialize Docker
        const initialized = await dockerManager.initialize();
        if (!initialized) {
            throw new Error('Docker not found');
        }
        
        // Check Docker is running
        await dockerManager.checkDockerRunning();
        
        // Login to Docker Hub
        event.sender.send('docker-progress', { 
            stage: 'login', 
            message: 'Logging in to Docker Hub...' 
        });
        
        await dockerManager.dockerLogin(dockerUsername, dockerAccessToken);
        
        // Build the image
        event.sender.send('docker-progress', { 
            stage: 'build', 
            message: 'Building Docker image...' 
        });
        
        const dockerfilePath = path.join(__dirname, 'runpod', 'Dockerfile');
        const imageName = `${dockerUsername}/comfyui-flux-kontext`;
        
        const buildResult = await dockerManager.buildImage({
            dockerfilePath,
            imageName,
            tag: 'latest',
            onProgress: (progress) => {
                event.sender.send('docker-progress', {
                    stage: 'build',
                    ...progress
                });
            }
        });
        
        if (!buildResult.success) {
            throw new Error('Build failed');
        }
        
        // Push the image
        event.sender.send('docker-progress', { 
            stage: 'push', 
            message: 'Pushing image to Docker Hub...' 
        });
        
        const pushResult = await dockerManager.pushImage({
            imageName,
            tag: 'latest',
            onProgress: (progress) => {
                event.sender.send('docker-progress', {
                    stage: 'push',
                    ...progress
                });
            }
        });
        
        if (!pushResult.success) {
            throw new Error('Push failed');
        }
        
        return {
            success: true,
            imageName: `${imageName}:latest`,
            buildDuration: buildResult.duration,
            pushDuration: pushResult.duration
        };
        
    } catch (error) {
        return { 
            success: false, 
            error: error.message 
        };
    }
});

ipcMain.handle('docker-cancel-build', async () => {
    return dockerManager.cancelBuild();
});