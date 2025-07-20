const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const WhisperInstaller = require('./whisper-installer');

class LocalTerminalServer {
    constructor(port = 8003) {
        this.port = port;
        this.wss = null;
        this.sessions = new Map();
    }

    start() {
        this.wss = new WebSocket.Server({ port: this.port });
        console.log(`Local terminal server listening on ws://localhost:${this.port}`);

        this.wss.on('connection', (ws) => {
            console.log('New terminal connection');
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleMessage(ws, data);
                } catch (error) {
                    console.error('Error handling message:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        data: `Error: ${error.message}`
                    }));
                }
            });

            ws.on('close', () => {
                // Clean up session
                for (const [sessionId, session] of this.sessions.entries()) {
                    if (session.ws === ws) {
                        if (session.process) {
                            session.process.kill();
                        }
                        this.sessions.delete(sessionId);
                        break;
                    }
                }
            });
        });
    }

    handleMessage(ws, data) {
        const { command, sessionId, tool } = data;

        switch (command) {
            case 'init':
                this.initSession(ws, sessionId, tool);
                break;
            case 'input':
                this.sendInput(sessionId, data.data);
                break;
            case 'resize':
                this.resizeTerminal(sessionId, data.cols, data.rows);
                break;
            case 'install-whisper':
                this.installWhisper(ws, sessionId);
                break;
            default:
                ws.send(JSON.stringify({
                    type: 'error',
                    data: `Unknown command: ${command}`
                }));
        }
    }

    initSession(ws, sessionId, tool) {
        console.log(`[Terminal] Initializing session ${sessionId} for tool: ${tool}`);
        
        // Clean up any existing session
        if (this.sessions.has(sessionId)) {
            const existingSession = this.sessions.get(sessionId);
            if (existingSession.process) {
                console.log(`[Terminal] Killing existing process for session ${sessionId}`);
                existingSession.process.kill();
            }
        }

        // Get the path to the locally installed CLI tool
        let command, args;
        
        // On Windows, we need to use WSL to run the CLI tools
        const isWindows = process.platform === 'win32';
        console.log(`[Terminal] Platform: ${process.platform}, isWindows: ${isWindows}`);
        
        if (tool === 'claude') {
            // For Claude, we need proper TTY allocation
            if (isWindows) {
                // Use WSL with unbuffer or script for PTY allocation
                command = 'wsl';
                // Try multiple methods to get a PTY
                // Method 1: Use unbuffer (from expect package)
                args = ['sh', '-c', 'which unbuffer >/dev/null 2>&1 && unbuffer -p claude || script -q -c claude /dev/null'];
            } else {
                // On Linux/Mac, use script for PTY (more universally available)
                // Note: macOS 'script' has different syntax than Linux
                if (process.platform === 'darwin') {
                    // macOS: script command doesn't support -c flag
                    command = 'sh';
                    args = ['-c', 'which unbuffer >/dev/null 2>&1 && unbuffer -p claude || script -q /dev/null claude'];
                } else {
                    // Linux: standard script command
                    command = 'sh';
                    args = ['-c', 'which unbuffer >/dev/null 2>&1 && unbuffer -p claude || script -q -c claude /dev/null'];
                }
            }
            console.log(`[Terminal] Claude command: ${command} ${args.join(' ')}`);
        } else if (tool === 'gemini') {
            // Try to use npx first (for npm package), fallback to global command
            if (isWindows) {
                // Use WSL to run Gemini CLI
                command = 'wsl';
                args = ['sh', '-c', 'npx --no-install @google/gemini-cli gemini 2>/dev/null || gemini'];
            } else {
                // On Linux/Mac - for now just run directly, Gemini might not need PTY
                command = 'sh';
                args = ['-c', 'npx --no-install @google/gemini-cli gemini 2>/dev/null || gemini'];
            }
            console.log(`[Terminal] Gemini command: ${command} ${args.join(' ')}`);
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                data: `Unknown tool: ${tool}`
            }));
            return;
        }

        // Get the audiobooks directory path
        let workingDir = process.cwd();
        // If we're in the AudioBookVisualizer directory, use the audiobooks subdirectory
        if (process.cwd().includes('AudioBookVisualizer')) {
            const audiobooksPath = path.join(process.cwd(), 'audiobooks');
            if (require('fs').existsSync(audiobooksPath)) {
                workingDir = audiobooksPath;
            }
        }

        console.log(`[Terminal] Working directory: ${workingDir}`);
        console.log(`[Terminal] Spawning process with command: ${command} ${args.join(' ')}`);
        
        // Spawn the process
        const childProcess = spawn(command, args, {
            env: {
                ...process.env,
                FORCE_COLOR: '1',
                TERM: 'xterm-256color',
                // Add Claude Code specific environment variables
                CLAUDE_INTERACTIVE: '1',
                CLAUDE_TTY: '1'
            },
            shell: true, // Need shell for command chaining
            cwd: workingDir,
            // Important: use 'pipe' for stdio to properly handle input/output
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        console.log(`[Terminal] Process spawned with PID: ${childProcess.pid}`);
        
        // Check if the process started successfully
        childProcess.on('spawn', () => {
            console.log(`[Terminal] Process ${childProcess.pid} spawned successfully`);
        });
        
        childProcess.on('error', (error) => {
            console.error(`[Terminal] Process spawn error:`, error);
            ws.send(JSON.stringify({
                type: 'error',
                data: `Failed to start ${tool}: ${error.message}`
            }));
        });

        // Set up process event handlers
        childProcess.stdout.on('data', (data) => {
            console.log(`[Terminal] stdout data (${data.length} bytes):`, data.toString().substring(0, 100));
            ws.send(JSON.stringify({
                type: 'output',
                data: data.toString()
            }));
        });

        childProcess.stderr.on('data', (data) => {
            console.log(`[Terminal] stderr data (${data.length} bytes):`, data.toString().substring(0, 100));
            ws.send(JSON.stringify({
                type: 'output',
                data: data.toString()
            }));
        });

        childProcess.on('exit', (code) => {
            ws.send(JSON.stringify({
                type: 'output',
                data: `\r\nProcess exited with code ${code}\r\n`
            }));
            this.sessions.delete(sessionId);
        });

        childProcess.on('error', (error) => {
            ws.send(JSON.stringify({
                type: 'error',
                data: `Failed to start ${tool}: ${error.message}`
            }));
        });

        // Store the session
        this.sessions.set(sessionId, {
            ws,
            process: childProcess,
            tool
        });

        // Send initialization confirmation
        ws.send(JSON.stringify({
            type: 'initialized',
            data: `${tool} session initialized`
        }));
    }

    sendInput(sessionId, input) {
        console.log(`[Terminal] sendInput called for session ${sessionId}, input length: ${input.length}`);
        console.log(`[Terminal] Input data:`, JSON.stringify(input));
        
        const session = this.sessions.get(sessionId);
        if (!session) {
            console.error(`[Terminal] No session found for ${sessionId}`);
            return;
        }
        
        if (!session.process) {
            console.error(`[Terminal] No process found for session ${sessionId}`);
            return;
        }
        
        if (!session.process.stdin) {
            console.error(`[Terminal] No stdin found for process in session ${sessionId}`);
            return;
        }
        
        if (session.process.stdin.destroyed) {
            console.error(`[Terminal] stdin is destroyed for session ${sessionId}`);
            return;
        }
        
        try {
            // Write input to the process stdin
            const written = session.process.stdin.write(input);
            console.log(`[Terminal] Wrote ${input.length} bytes to stdin, success: ${written}`);
        } catch (error) {
            console.error('[Terminal] Error sending input to process:', error);
            // Try to send error back to client
            if (session.ws) {
                session.ws.send(JSON.stringify({
                    type: 'error',
                    data: `Error sending input: ${error.message}`
                }));
            }
        }
    }

    resizeTerminal(sessionId, cols, rows) {
        const session = this.sessions.get(sessionId);
        if (session && session.process) {
            // Send resize signal if supported
            if (session.process.stdout && session.process.stdout.columns !== undefined) {
                session.process.stdout.columns = cols;
                session.process.stdout.rows = rows;
            }
            if (session.process.stderr && session.process.stderr.columns !== undefined) {
                session.process.stderr.columns = cols;
                session.process.stderr.rows = rows;
            }
            // Try to resize the pty if available
            if (session.process.resize && typeof session.process.resize === 'function') {
                try {
                    session.process.resize(cols, rows);
                } catch (error) {
                    console.error('Error resizing terminal:', error);
                }
            }
        }
    }

    async installWhisper(ws, sessionId) {
        const installer = new WhisperInstaller();
        
        // Create a session for this installation
        this.sessions.set(sessionId, {
            ws,
            process: null,
            tool: 'whisper-installer'
        });
        
        ws.send(JSON.stringify({
            type: 'output',
            data: '\r\n=== OpenAI Whisper Installation (Python) ===\r\n\r\n'
        }));
        
        // Check if already installed
        ws.send(JSON.stringify({
            type: 'output',
            data: 'Checking if OpenAI Whisper is already installed...\r\n'
        }));
        
        if (await installer.isWhisperInstalled()) {
            ws.send(JSON.stringify({
                type: 'output',
                data: '\r\n✅ OpenAI Whisper is already installed and ready!\r\n'
            }));
            ws.send(JSON.stringify({
                type: 'output',
                data: 'You can close this window and start using Whisper.\r\n'
            }));
            return;
        }
        
        try {
            // Check dependencies first
            ws.send(JSON.stringify({
                type: 'output',
                data: 'Checking system dependencies...\r\n'
            }));
            
            const deps = await installer.checkDependencies();
            const missingDeps = Object.entries(deps)
                .filter(([dep, installed]) => !installed)
                .map(([dep]) => dep);
            
            if (missingDeps.length > 0) {
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `\r\n❌ Missing dependencies: ${missingDeps.join(', ')}\r\n\r\n`
                }));
                
                const instructions = installer.getInstallInstructions();
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `${instructions.title}:\r\n\r\n`
                }));
                
                for (const line of instructions.instructions) {
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `${line}\r\n`
                    }));
                }
                
                return;
            }
            
            // All dependencies are available, proceed with installation
            ws.send(JSON.stringify({
                type: 'output',
                data: '\r\n✅ All dependencies found. Starting installation...\r\n\r\n'
            }));
            
            await installer.install((progress) => {
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `[${progress.progress}%] ${progress.message}\r\n`
                }));
            });
            
            ws.send(JSON.stringify({
                type: 'output',
                data: '\r\n✅ Installation completed successfully!\r\n'
            }));
            ws.send(JSON.stringify({
                type: 'output',
                data: 'You can now download Whisper models and start transcribing.\r\n'
            }));
            
        } catch (error) {
            ws.send(JSON.stringify({
                type: 'output',
                data: `\r\n❌ Installation failed: ${error.message}\r\n`
            }));
        }
        
        // Clean up session
        this.sessions.delete(sessionId);
    }
    
    async checkCLIInstallation(tool) {
        return new Promise((resolve) => {
            const isWindows = process.platform === 'win32';
            const packageName = tool === 'claude' ? '@anthropic-ai/claude-code' : '@google/gemini-cli';
            
            // First check npm packages
            let command, args;
            if (isWindows) {
                command = 'wsl';
                args = ['npm', 'list', packageName, '--depth=0', '--json'];
            } else {
                command = 'npm';
                args = ['list', packageName, '--depth=0', '--json'];
            }
            
            const checkProcess = spawn(command, args, {
                shell: true,
                stdio: 'pipe',
                windowsHide: true
            });
            
            let output = '';
            let errorOutput = '';
            let finished = false;
            
            // Add timeout
            const timeout = setTimeout(() => {
                if (!finished) {
                    finished = true;
                    checkProcess.kill();
                    resolve({
                        tool,
                        installed: false,
                        version: null,
                        error: 'Check timed out'
                    });
                }
            }, 5000);
            
            checkProcess.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            checkProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            checkProcess.on('close', (code) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                
                // Try parsing npm output first
                try {
                    if (output.trim()) {
                        const result = JSON.parse(output);
                        const isInstalled = !!(result.dependencies && result.dependencies[packageName]);
                        const version = isInstalled ? result.dependencies[packageName].version : null;
                        
                        if (isInstalled) {
                            resolve({
                                tool,
                                installed: true,
                                version: version,
                                error: null,
                                source: 'npm'
                            });
                            return;
                        }
                    }
                } catch (error) {
                    // npm check failed, try global command
                }
                
                // If npm package not found, check for global command
                const globalCommand = tool === 'claude' ? 'claude' : 'gemini';
                const whichCommand = isWindows ? 'wsl' : 'which';
                const whichArgs = isWindows ? ['which', globalCommand] : [globalCommand];
                
                const whichProcess = spawn(whichCommand, whichArgs, {
                    shell: true,
                    stdio: 'pipe'
                });
                
                let whichOutput = '';
                whichProcess.stdout.on('data', (data) => {
                    whichOutput += data.toString();
                });
                
                whichProcess.on('close', (whichCode) => {
                    if (whichCode === 0 && whichOutput.trim()) {
                        // Get version
                        const versionCommand = isWindows ? 'wsl' : globalCommand;
                        const versionArgs = isWindows ? [globalCommand, '--version'] : ['--version'];
                        const versionProcess = spawn(versionCommand, versionArgs, {
                            shell: true,
                            stdio: 'pipe'
                        });
                        
                        let versionOutput = '';
                        versionProcess.stdout.on('data', (data) => {
                            versionOutput += data.toString();
                        });
                        
                        versionProcess.on('close', () => {
                            const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+)/);
                            resolve({
                                tool,
                                installed: true,
                                version: versionMatch ? versionMatch[1] : 'unknown',
                                error: null,
                                source: 'global'
                            });
                        });
                        
                        versionProcess.on('error', () => {
                            resolve({
                                tool,
                                installed: true,
                                version: 'unknown',
                                error: null,
                                source: 'global'
                            });
                        });
                    } else {
                        // Not found anywhere
                        resolve({
                            tool,
                            installed: false,
                            version: null,
                            error: 'Not installed'
                        });
                    }
                });
            });
            
            checkProcess.on('error', (error) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                
                console.error(`Error checking ${tool}:`, error.message);
                resolve({
                    tool,
                    installed: false,
                    version: null,
                    error: error.message
                });
            });
        });
    }
    
    async checkAllCLITools() {
        const [claudeResult, geminiResult] = await Promise.all([
            this.checkCLIInstallation('claude'),
            this.checkCLIInstallation('gemini')
        ]);
        
        return {
            claude: claudeResult,
            gemini: geminiResult
        };
    }
    
    stop() {
        // Clean up all sessions
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.process) {
                session.process.kill();
            }
        }
        this.sessions.clear();

        // Close WebSocket server
        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = LocalTerminalServer;