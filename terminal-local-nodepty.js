const WebSocket = require('ws');
const path = require('path');
const os = require('os');

// This implementation requires node-pty to be installed:
// npm install node-pty

let pty;
try {
    pty = require('node-pty');
} catch (error) {
    console.error('[Terminal] node-pty not installed. Run: npm install node-pty');
    console.error('[Terminal] Falling back to basic implementation');
}

class LocalTerminalServerNodePTY {
    constructor(port = 8003) {
        this.port = port;
        this.wss = null;
        this.sessions = new Map();
    }

    start() {
        if (!pty) {
            console.error('[Terminal] Cannot start PTY server - node-pty not installed');
            // Fall back to original implementation
            const LocalTerminalServer = require('./terminal-local');
            const fallback = new LocalTerminalServer(this.port);
            return fallback.start();
        }

        this.wss = new WebSocket.Server({ port: this.port });
        console.log(`[Terminal PTY] Server listening on ws://localhost:${this.port}`);

        this.wss.on('connection', (ws) => {
            console.log('[Terminal PTY] New connection');
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleMessage(ws, data);
                } catch (error) {
                    console.error('[Terminal PTY] Error handling message:', error);
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
                        if (session.ptyProcess) {
                            console.log(`[Terminal PTY] Killing PTY for session ${sessionId}`);
                            session.ptyProcess.kill();
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
        console.log(`[Terminal PTY] Initializing session ${sessionId} for tool: ${tool}`);
        
        // Clean up any existing session
        if (this.sessions.has(sessionId)) {
            const existingSession = this.sessions.get(sessionId);
            if (existingSession.ptyProcess) {
                existingSession.ptyProcess.kill();
            }
        }

        // Get working directory
        let cwd = process.cwd();
        if (process.cwd().includes('AudioBookVisualizer')) {
            const audiobooksPath = path.join(process.cwd(), 'audiobooks');
            if (require('fs').existsSync(audiobooksPath)) {
                cwd = audiobooksPath;
            }
        }

        const isWindows = process.platform === 'win32';
        let shell, args;

        if (tool === 'claude') {
            if (isWindows) {
                // On Windows, use WSL
                shell = 'wsl.exe';
                args = ['claude'];
            } else {
                // On Unix, run directly
                shell = 'claude';
                args = [];
            }
        } else if (tool === 'gemini') {
            if (isWindows) {
                shell = 'wsl.exe';
                args = ['gemini'];
            } else {
                shell = 'gemini';
                args = [];
            }
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                data: `Unknown tool: ${tool}`
            }));
            return;
        }

        console.log(`[Terminal PTY] Creating PTY with shell: ${shell}, args: ${args.join(' ')}`);

        try {
            // Create PTY process
            const ptyProcess = pty.spawn(shell, args, {
                name: 'xterm-256color',
                cols: 80,
                rows: 24,
                cwd: cwd,
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    FORCE_COLOR: '3'
                }
            });

            console.log(`[Terminal PTY] PTY created with PID: ${ptyProcess.pid}`);

            // Handle PTY data
            ptyProcess.onData((data) => {
                // Send output to frontend
                ws.send(JSON.stringify({
                    type: 'output',
                    data: data
                }));
            });

            // Handle PTY exit
            ptyProcess.onExit((exitCode) => {
                console.log(`[Terminal PTY] Process exited with code: ${exitCode.exitCode}`);
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `\r\nProcess exited with code ${exitCode.exitCode}\r\n`
                }));
                this.sessions.delete(sessionId);
            });

            // Store session
            this.sessions.set(sessionId, {
                ws,
                ptyProcess,
                tool
            });

            // Send initialization complete
            ws.send(JSON.stringify({
                type: 'initialized',
                data: `${tool} session initialized`
            }));

        } catch (error) {
            console.error('[Terminal PTY] Failed to create PTY:', error);
            ws.send(JSON.stringify({
                type: 'error',
                data: `Failed to start ${tool}: ${error.message}`
            }));
        }
    }

    sendInput(sessionId, input) {
        const session = this.sessions.get(sessionId);
        if (session && session.ptyProcess) {
            try {
                session.ptyProcess.write(input);
            } catch (error) {
                console.error('[Terminal PTY] Error writing to PTY:', error);
                if (session.ws) {
                    session.ws.send(JSON.stringify({
                        type: 'error',
                        data: `Error sending input: ${error.message}`
                    }));
                }
            }
        }
    }

    resizeTerminal(sessionId, cols, rows) {
        const session = this.sessions.get(sessionId);
        if (session && session.ptyProcess) {
            try {
                session.ptyProcess.resize(cols, rows);
                console.log(`[Terminal PTY] Resized to ${cols}x${rows}`);
            } catch (error) {
                console.error('[Terminal PTY] Error resizing PTY:', error);
            }
        }
    }

    async checkCLIInstallation(tool) {
        // Reuse the checking logic from the original implementation
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
            if (session.ptyProcess) {
                session.ptyProcess.kill();
            }
        }
        this.sessions.clear();

        // Close WebSocket server
        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = LocalTerminalServerNodePTY;