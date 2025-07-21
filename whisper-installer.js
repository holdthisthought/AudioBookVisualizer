const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const execPromise = util.promisify(exec);
const WhisperPython = require('./whisper-python');

class WhisperInstaller {
    constructor() {
        this.whisperPython = new WhisperPython();
    }

    // Check if Python is installed
    async checkPython() {
        return await this.whisperPython.checkPython();
    }

    // Check if whisper is installed
    async isWhisperInstalled() {
        return await this.whisperPython.checkWhisper();
    }

    // Check system dependencies for Python whisper
    async checkDependencies() {
        const deps = {
            python: false,
            pip: false,
            ffmpeg: false
        };

        // Check Python
        deps.python = await this.checkPython();
        
        // Check pip
        if (deps.python) {
            try {
                await execPromise(`${this.whisperPython.pythonCommand} -m pip --version`);
                deps.pip = true;
            } catch (e) {
                deps.pip = false;
            }
        }
        
        // Check ffmpeg (required for audio processing)
        try {
            await execPromise('ffmpeg -version');
            deps.ffmpeg = true;
        } catch (e) {
            deps.ffmpeg = false;
        }

        return deps;
    }

    // Install whisper using pip
    async install(progressCallback) {
        try {
            progressCallback({ message: 'Checking Python installation...', progress: 5 });
            
            const hasPython = await this.checkPython();
            if (!hasPython) {
                throw new Error('Python is not installed. Please install Python 3.8 or later from python.org');
            }
            
            progressCallback({ message: 'Checking dependencies...', progress: 10 });
            
            const deps = await this.checkDependencies();
            if (!deps.pip) {
                throw new Error('pip is not installed. Please ensure Python was installed with pip.');
            }
            
            if (!deps.ffmpeg) {
                progressCallback({ message: 'Warning: ffmpeg not found. Audio processing may be limited.', progress: 15 });
            }
            
            // Check if already installed
            if (await this.isWhisperInstalled()) {
                progressCallback({ message: 'OpenAI Whisper is already installed!', progress: 100 });
                return { success: true };
            }
            
            // Install whisper
            progressCallback({ message: 'Installing OpenAI Whisper (this may take a few minutes)...', progress: 20 });
            
            await this.whisperPython.installWhisper(progressCallback);
            
            progressCallback({ message: 'Verifying installation...', progress: 95 });
            
            if (!await this.isWhisperInstalled()) {
                throw new Error('Installation completed but whisper not found. Try restarting the application.');
            }
            
            progressCallback({ message: 'OpenAI Whisper installed successfully!', progress: 100 });
            
            return { success: true };
        } catch (error) {
            console.error('Installation error:', error);
            throw error;
        }
    }

    // Get installation instructions for missing dependencies
    getInstallInstructions() {
        const platform = os.platform();
        
        if (platform === 'darwin') {
            return {
                title: 'macOS Installation',
                instructions: [
                    '1. Install Python:',
                    '   Download from https://python.org/downloads/',
                    '   Or use Homebrew: brew install python',
                    '',
                    '2. Install ffmpeg (optional but recommended):',
                    '   brew install ffmpeg',
                    '',
                    '3. Restart the application after installation'
                ]
            };
        } else if (platform === 'linux') {
            return {
                title: 'Linux Installation',
                instructions: [
                    'For Ubuntu/Debian:',
                    '   sudo apt update',
                    '   sudo apt install python3 python3-pip ffmpeg',
                    '',
                    'For Fedora/RHEL:',
                    '   sudo dnf install python3 python3-pip ffmpeg',
                    '',
                    'For Arch:',
                    '   sudo pacman -S python python-pip ffmpeg',
                    '',
                    'Restart the application after installation'
                ]
            };
        } else if (platform === 'win32') {
            return {
                title: 'Windows Installation',
                instructions: [
                    '1. Install Python:',
                    '   Download from https://python.org/downloads/',
                    '   IMPORTANT: Check "Add Python to PATH" during installation',
                    '',
                    '2. Install ffmpeg (optional but recommended):',
                    '   Download from https://ffmpeg.org/download.html',
                    '   Extract and add to PATH',
                    '',
                    '3. Restart the application after installation',
                    '',
                    'Note: You may need to restart your computer for PATH changes to take effect'
                ]
            };
        }
        
        return {
            title: 'Installation Instructions',
            instructions: ['Please install Python 3.8 or later from https://python.org']
        };
    }
}

module.exports = WhisperInstaller;