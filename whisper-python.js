const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const execPromise = util.promisify(exec);

class WhisperPython {
    constructor() {
        this.modelsPath = path.join(os.homedir(), '.cache', 'whisper');
        this.pythonCommand = null;
        this.whisperCommand = null;
    }

    // Check if Python is installed
    async checkPython() {
        const commands = ['python', 'python3', 'py'];
        
        for (const cmd of commands) {
            try {
                const { stdout } = await execPromise(`${cmd} --version`);
                if (stdout.includes('Python')) {
                    this.pythonCommand = cmd;
                    return true;
                }
            } catch (e) {
                // Try next command
            }
        }
        
        return false;
    }

    // Check if whisper is installed
    async checkWhisper() {
        if (!this.pythonCommand) {
            await this.checkPython();
        }
        
        if (!this.pythonCommand) {
            return false;
        }
        
        try {
            // Try to import whisper
            const { stdout } = await execPromise(`${this.pythonCommand} -c "import whisper; print('OK')"`);
            if (stdout.trim() === 'OK') {
                // Also check for whisper CLI
                try {
                    await execPromise('whisper --help');
                    this.whisperCommand = 'whisper';
                } catch (e) {
                    // CLI might not be in PATH, but module is available
                    this.whisperCommand = `${this.pythonCommand} -m whisper`;
                }
                return true;
            }
        } catch (e) {
            return false;
        }
        
        return false;
    }

    // Install whisper using pip
    async installWhisper(progressCallback) {
        if (!this.pythonCommand) {
            throw new Error('Python is not installed. Please install Python 3.8 or later.');
        }
        
        try {
            progressCallback({ message: 'Installing OpenAI Whisper via pip...', progress: 20 });
            
            const pipCommand = `${this.pythonCommand} -m pip install -U openai-whisper`;
            
            return new Promise((resolve, reject) => {
                const proc = exec(pipCommand, { maxBuffer: 10 * 1024 * 1024 });
                
                let lastProgress = 20;
                
                proc.stdout.on('data', (data) => {
                    const output = data.toString();
                    console.log('pip output:', output);
                    
                    if (output.includes('Collecting')) {
                        lastProgress = Math.min(lastProgress + 10, 70);
                        progressCallback({ message: 'Downloading packages...', progress: lastProgress });
                    } else if (output.includes('Installing')) {
                        lastProgress = Math.min(lastProgress + 10, 90);
                        progressCallback({ message: 'Installing packages...', progress: lastProgress });
                    }
                });
                
                proc.stderr.on('data', (data) => {
                    console.error('pip error:', data.toString());
                });
                
                proc.on('close', (code) => {
                    if (code === 0) {
                        progressCallback({ message: 'Whisper installed successfully!', progress: 100 });
                        resolve({ success: true });
                    } else {
                        reject(new Error(`pip install failed with code ${code}`));
                    }
                });
                
                proc.on('error', (err) => {
                    reject(err);
                });
            });
        } catch (error) {
            throw error;
        }
    }

    // Check which models are available
    async getAvailableModels() {
        const models = {
            'tiny': { name: 'Tiny', size: '39 MB', file: 'tiny.pt' },
            'base': { name: 'Base', size: '74 MB', file: 'base.pt' },
            'small': { name: 'Small', size: '244 MB', file: 'small.pt' },
            'medium': { name: 'Medium', size: '769 MB', file: 'medium.pt' },
            'large': { name: 'Large', size: '1.5 GB', file: 'large-v3.pt' }
        };
        
        const available = {};
        
        for (const [key, info] of Object.entries(models)) {
            const modelPath = path.join(this.modelsPath, info.file);
            available[key] = {
                ...info,
                available: fs.existsSync(modelPath)
            };
        }
        
        return available;
    }

    // Pre-download a model by loading it in Python
    async preDownloadModel(modelName) {
        if (!await this.checkWhisper()) {
            throw new Error('Whisper is not installed.');
        }
        
        // Create a Python script that just loads the model
        const scriptContent = `
import whisper
import sys

model_name = sys.argv[1]
print(f"Loading {model_name} model...")
model = whisper.load_model(model_name)
print(f"Model {model_name} loaded successfully!")
`;

        const tempScript = path.join(os.tmpdir(), `whisper_download_${Date.now()}.py`);
        fs.writeFileSync(tempScript, scriptContent);
        
        try {
            const { stdout, stderr } = await execPromise(
                `${this.pythonCommand} "${tempScript}" "${modelName}"`,
                { maxBuffer: 10 * 1024 * 1024 }
            );
            
            // Clean up temp script
            fs.unlinkSync(tempScript);
            
            return { success: true, output: stdout };
        } catch (error) {
            // Clean up temp script
            if (fs.existsSync(tempScript)) {
                fs.unlinkSync(tempScript);
            }
            throw error;
        }
    }
    
    // Transcribe audio using Python whisper
    async transcribe(audioPath, modelName = 'base', language = 'en') {
        if (!await this.checkWhisper()) {
            throw new Error('Whisper is not installed. Please install it first.');
        }
        
        // Create a temporary Python script to run whisper and output JSON
        const scriptContent = `
import whisper
import json
import sys

audio_path = sys.argv[1]
model_name = sys.argv[2]
language = sys.argv[3]

# Load model
model = whisper.load_model(model_name)

# Transcribe
result = model.transcribe(audio_path, language=language)

# Output as JSON
output = {
    "text": result["text"],
    "segments": []
}

for segment in result["segments"]:
    output["segments"].append({
        "id": segment["id"],
        "start": segment["start"],
        "end": segment["end"],
        "text": segment["text"].strip()
    })

print(json.dumps(output))
`;

        const tempScript = path.join(os.tmpdir(), `whisper_transcribe_${Date.now()}.py`);
        fs.writeFileSync(tempScript, scriptContent);
        
        try {
            const { stdout, stderr } = await execPromise(
                `${this.pythonCommand} "${tempScript}" "${audioPath}" "${modelName}" "${language}"`,
                { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer for large transcriptions
            );
            
            if (stderr && !stderr.includes('UserWarning')) {
                console.error('Whisper stderr:', stderr);
            }
            
            const result = JSON.parse(stdout);
            
            // Clean up temp script
            fs.unlinkSync(tempScript);
            
            return result;
        } catch (error) {
            // Clean up temp script
            if (fs.existsSync(tempScript)) {
                fs.unlinkSync(tempScript);
            }
            
            throw error;
        }
    }
}

module.exports = WhisperPython;