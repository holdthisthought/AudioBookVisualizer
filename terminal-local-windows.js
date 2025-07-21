const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

// Windows-specific terminal server that uses WSL's native PTY support
class LocalTerminalServerWindows {
    constructor(port = 8003) {
        this.port = port;
        this.wss = null;
        this.sessions = new Map();
    }

    start() {
        this.wss = new WebSocket.Server({ port: this.port });
        console.log(`[Terminal Windows] Server listening on ws://localhost:${this.port}`);

        this.wss.on('connection', (ws) => {
            console.log('[Terminal Windows] New connection');
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleMessage(ws, data);
                } catch (error) {
                    console.error('[Terminal Windows] Error handling message:', error);
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
                            console.log(`[Terminal Windows] Killing process for session ${sessionId}`);
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
            default:
                ws.send(JSON.stringify({
                    type: 'error',
                    data: `Unknown command: ${command}`
                }));
        }
    }

    initSession(ws, sessionId, tool) {
        console.log(`[Terminal Windows] Initializing session ${sessionId} for tool: ${tool}`);
        
        // Clean up any existing session
        if (this.sessions.has(sessionId)) {
            const existingSession = this.sessions.get(sessionId);
            if (existingSession.process) {
                console.log(`[Terminal Windows] Killing existing process for session ${sessionId}`);
                existingSession.process.kill();
            }
        }

        // Get working directory
        let workingDir = process.cwd();
        if (process.cwd().includes('AudioBookVisualizer')) {
            const audiobooksPath = path.join(process.cwd(), 'audiobooks');
            if (require('fs').existsSync(audiobooksPath)) {
                workingDir = audiobooksPath;
            }
        }

        // Convert Windows path to WSL path
        const wslWorkingDir = this.windowsToWSLPath(workingDir);
        console.log(`[Terminal Windows] Working directory: ${workingDir} -> WSL: ${wslWorkingDir}`);

        let command, args;

        if (tool === 'claude') {
            // Use wsl.exe with specific arguments for better PTY support
            command = 'wsl.exe';
            
            // Method 1: Use bash with explicit terminal allocation
            args = [
                '-e', 'bash', '-c',
                `cd "${wslWorkingDir}" && exec script -q -c claude /dev/null`
            ];
            
            console.log(`[Terminal Windows] Claude command: ${command} ${args.join(' ')}`);
        } else if (tool === 'gemini') {
            command = 'wsl.exe';
            args = [
                '-e', 'bash', '-c',
                `cd "${wslWorkingDir}" && exec script -q -c gemini /dev/null`
            ];
            console.log(`[Terminal Windows] Gemini command: ${command} ${args.join(' ')}`);
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                data: `Unknown tool: ${tool}`
            }));
            return;
        }

        console.log(`[Terminal Windows] Spawning process...`);
        
        // Spawn the process with Windows-specific options
        const childProcess = spawn(command, args, {
            env: {
                ...process.env,
                // WSL will handle terminal settings
                WSLENV: 'FORCE_COLOR/w:TERM/w',
                FORCE_COLOR: '1',
                TERM: 'xterm-256color'
            },
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        if (!childProcess || !childProcess.pid) {
            console.error('[Terminal Windows] Failed to spawn process');
            ws.send(JSON.stringify({
                type: 'error',
                data: `Failed to start ${tool}`
            }));
            return;
        }
        
        console.log(`[Terminal Windows] Process spawned with PID: ${childProcess.pid}`);
        
        // Handle spawn errors
        childProcess.on('error', (error) => {
            console.error(`[Terminal Windows] Process spawn error:`, error);
            ws.send(JSON.stringify({
                type: 'error',
                data: `Failed to start ${tool}: ${error.message}`
            }));
        });

        // Set up process event handlers
        childProcess.stdout.on('data', (data) => {
            const output = data.toString();
            // console.log(`[Terminal Windows] stdout (${output.length} bytes)`);
            ws.send(JSON.stringify({
                type: 'output',
                data: output
            }));
        });

        childProcess.stderr.on('data', (data) => {
            const output = data.toString();
            console.log(`[Terminal Windows] stderr: ${output}`);
            ws.send(JSON.stringify({
                type: 'output',
                data: output
            }));
        });

        childProcess.on('exit', (code) => {
            console.log(`[Terminal Windows] Process exited with code ${code}`);
            ws.send(JSON.stringify({
                type: 'output',
                data: `\r\nProcess exited with code ${code}\r\n`
            }));
            this.sessions.delete(sessionId);
        });

        // Store session
        this.sessions.set(sessionId, {
            ws,
            process: childProcess,
            tool
        });

        // Send initialization complete
        ws.send(JSON.stringify({
            type: 'initialized',
            data: `${tool} session initialized`
        }));
    }

    sendInput(sessionId, input) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            console.error(`[Terminal Windows] No session found for ${sessionId}`);
            return;
        }
        
        if (!session.process || !session.process.stdin) {
            console.error(`[Terminal Windows] No process/stdin for session ${sessionId}`);
            return;
        }
        
        if (session.process.stdin.destroyed) {
            console.error(`[Terminal Windows] stdin is destroyed for session ${sessionId}`);
            return;
        }
        
        try {
            // Write input to the process stdin
            session.process.stdin.write(input);
            // console.log(`[Terminal Windows] Sent ${input.length} bytes to stdin`);
        } catch (error) {
            console.error('[Terminal Windows] Error sending input:', error);
            if (session.ws) {
                session.ws.send(JSON.stringify({
                    type: 'error',
                    data: `Error sending input: ${error.message}`
                }));
            }
        }
    }

    resizeTerminal(sessionId, cols, rows) {
        // Terminal resize is handled by WSL internally
        console.log(`[Terminal Windows] Resize request for ${sessionId}: ${cols}x${rows}`);
    }

    // Convert Windows path to WSL path
    windowsToWSLPath(windowsPath) {
        // Convert C:\path\to\dir to /mnt/c/path/to/dir
        const normalized = windowsPath.replace(/\\/g, '/');
        const match = normalized.match(/^([A-Za-z]):(.*)/);
        if (match) {
            const drive = match[1].toLowerCase();
            const path = match[2];
            return `/mnt/${drive}${path}`;
        }
        return normalized;
    }

    // Reuse CLI checking from original implementation
    async checkCLIInstallation(tool) {
        const LocalTerminalServer = require('./terminal-local');
        const checker = new LocalTerminalServer();
        return checker.checkCLIInstallation(tool);
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

module.exports = LocalTerminalServerWindows;