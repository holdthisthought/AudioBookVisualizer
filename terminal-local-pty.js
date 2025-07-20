const WebSocket = require('ws');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

// This is an alternative implementation that attempts to create a pseudo-TTY without node-pty
// by using different spawn options

class LocalTerminalServerPTY {
    constructor(port = 8003) {
        this.port = port;
        this.wss = null;
        this.sessions = new Map();
    }

    start() {
        this.wss = new WebSocket.Server({ port: this.port });
        console.log(`[PTY Terminal] Server listening on ws://localhost:${this.port}`);

        this.wss.on('connection', (ws) => {
            console.log('[PTY Terminal] New connection');
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleMessage(ws, data);
                } catch (error) {
                    console.error('[PTY Terminal] Error handling message:', error);
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
                            console.log(`[PTY Terminal] Killing process for session ${sessionId}`);
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
        console.log(`[PTY Terminal] Initializing session ${sessionId} for tool: ${tool}`);
        
        // Clean up any existing session
        if (this.sessions.has(sessionId)) {
            const existingSession = this.sessions.get(sessionId);
            if (existingSession.process) {
                existingSession.process.kill();
            }
        }

        const isWindows = process.platform === 'win32';
        let command, args, spawnOptions;

        // Get working directory
        let workingDir = process.cwd();
        if (process.cwd().includes('AudioBookVisualizer')) {
            const audiobooksPath = path.join(process.cwd(), 'audiobooks');
            if (require('fs').existsSync(audiobooksPath)) {
                workingDir = audiobooksPath;
            }
        }

        if (tool === 'claude') {
            if (isWindows) {
                // For Windows, we need to use a different approach
                // Try using winpty or conpty if available
                command = 'wsl';
                args = ['-e', 'script', '-q', '-c', 'claude', '/dev/null'];
                spawnOptions = {
                    cwd: workingDir,
                    env: {
                        ...process.env,
                        TERM: 'xterm-256color',
                        FORCE_COLOR: '1'
                    },
                    stdio: 'pipe',
                    shell: false
                };
            } else {
                // On Unix systems, use script command to allocate a PTY
                command = 'script';
                args = ['-q', '-c', 'claude', '/dev/null'];
                spawnOptions = {
                    cwd: workingDir,
                    env: {
                        ...process.env,
                        TERM: 'xterm-256color',
                        FORCE_COLOR: '1'
                    },
                    stdio: 'pipe',
                    shell: false
                };
            }
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                data: `Tool ${tool} not implemented in PTY mode yet`
            }));
            return;
        }

        console.log(`[PTY Terminal] Spawning: ${command} ${args.join(' ')}`);
        const childProcess = spawn(command, args, spawnOptions);

        if (!childProcess || !childProcess.pid) {
            console.error('[PTY Terminal] Failed to spawn process');
            ws.send(JSON.stringify({
                type: 'error',
                data: `Failed to start ${tool}`
            }));
            return;
        }

        console.log(`[PTY Terminal] Process spawned with PID: ${childProcess.pid}`);

        // Set up event handlers
        childProcess.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`[PTY Terminal] stdout (${output.length} bytes)`);
            ws.send(JSON.stringify({
                type: 'output',
                data: output
            }));
        });

        childProcess.stderr.on('data', (data) => {
            const output = data.toString();
            console.log(`[PTY Terminal] stderr: ${output}`);
            ws.send(JSON.stringify({
                type: 'output',
                data: output
            }));
        });

        childProcess.on('error', (error) => {
            console.error('[PTY Terminal] Process error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                data: `Process error: ${error.message}`
            }));
        });

        childProcess.on('exit', (code) => {
            console.log(`[PTY Terminal] Process exited with code ${code}`);
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

        ws.send(JSON.stringify({
            type: 'initialized',
            data: `${tool} session initialized`
        }));
    }

    sendInput(sessionId, input) {
        const session = this.sessions.get(sessionId);
        if (session && session.process && session.process.stdin && !session.process.stdin.destroyed) {
            try {
                session.process.stdin.write(input);
                console.log(`[PTY Terminal] Sent ${input.length} bytes to stdin`);
            } catch (error) {
                console.error('[PTY Terminal] Error writing to stdin:', error);
            }
        } else {
            console.error(`[PTY Terminal] Cannot send input - session or stdin not available`);
        }
    }

    resizeTerminal(sessionId, cols, rows) {
        // PTY resize would be handled here if we had proper PTY support
        console.log(`[PTY Terminal] Resize request for ${sessionId}: ${cols}x${rows}`);
    }

    stop() {
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.process) {
                session.process.kill();
            }
        }
        this.sessions.clear();

        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = LocalTerminalServerPTY;