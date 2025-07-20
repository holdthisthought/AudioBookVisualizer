// Terminal component using xterm.js for AI CLI integration
// In Electron renderer, we can use require directly
const Terminal = require('xterm').Terminal;
const FitAddon = require('xterm-addon-fit').FitAddon;
const WebLinksAddon = require('xterm-addon-web-links').WebLinksAddon;

class AITerminal {
    constructor() {
        this.ws = null;
        this.sessionId = null;
        this.currentTool = null; // null, 'claude' or 'gemini'
        this.terminalElement = null;
        this.isConnected = false;
        this.terminal = null;
        this.fitAddon = null;
    }

    async init(containerId) {
        // Create terminal UI
        const container = document.getElementById(containerId);
        container.innerHTML = `
            <div class="ai-terminal">
                <div class="terminal-header">
                    <div class="terminal-title">AI Assistant Terminal</div>
                    <div class="terminal-controls">
                        <button id="ai-tool-gemini" class="terminal-tool-btn ${this.currentTool === 'gemini' ? 'active' : ''}" data-tool="gemini">
                            <span class="tool-status-dot"></span>
                            Gemini CLI
                        </button>
                        <button id="ai-tool-claude" class="terminal-tool-btn ${this.currentTool === 'claude' ? 'active' : ''}" data-tool="claude">
                            <span class="tool-status-dot"></span>
                            Claude Code
                        </button>
                        <div class="terminal-separator"></div>
                        <button id="terminal-clear" class="terminal-btn">Clear</button>
                        <button id="terminal-toggle" class="terminal-btn">▼</button>
                    </div>
                </div>
                <div class="terminal-body" id="terminal-container"></div>
            </div>
        `;

        this.terminalElement = container.querySelector('.ai-terminal');

        // Initialize xterm.js
        this.terminal = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
            theme: {
                background: '#1e1e1e',
                foreground: '#cccccc',
                cursor: '#ffffff',
                black: '#000000',
                red: '#cd3131',
                green: '#0dbc79',
                yellow: '#e5e510',
                blue: '#2472c8',
                magenta: '#bc3fbc',
                cyan: '#11a8cd',
                white: '#e5e5e5',
                brightBlack: '#666666',
                brightRed: '#f14c4c',
                brightGreen: '#23d18b',
                brightYellow: '#f5f543',
                brightBlue: '#3b8eea',
                brightMagenta: '#d670d6',
                brightCyan: '#29b8db',
                brightWhite: '#e5e5e5'
            },
            allowTransparency: false,
            windowsMode: process.platform === 'win32',
            // Enable application cursor keys mode for proper arrow key handling
            applicationCursor: true,
            // Ensure we're in the correct input mode
            screenReaderMode: false,
            // Handle all input properly
            logLevel: 'off'
        });

        // Add addons
        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        
        const webLinksAddon = new WebLinksAddon();
        this.terminal.loadAddon(webLinksAddon);

        // Open terminal in container
        const terminalContainer = document.getElementById('terminal-container');
        this.terminal.open(terminalContainer);
        this.fitAddon.fit();

        // Set up event listeners
        this.setupEventListeners();

        // Clear terminal and show initial message
        this.terminal.clear();
        this.terminal.writeln('\x1b[33mPlease select an AI Assistant (Claude Code or Gemini CLI) to start.\x1b[0m');
        
        // Start with terminal collapsed by default
        this.terminalElement.classList.add('collapsed');
        const toggleBtn = document.getElementById('terminal-toggle');
        if (toggleBtn) {
            toggleBtn.textContent = '▲';
        }
        
        // Check CLI installation status
        this.checkCLIStatus();
    }

    setupEventListeners() {
        // Tool buttons
        document.getElementById('ai-tool-gemini').addEventListener('click', async () => {
            await this.switchToolWithRestart('gemini');
        });
        
        document.getElementById('ai-tool-claude').addEventListener('click', async () => {
            await this.switchToolWithRestart('claude');
        });

        // Clear button
        document.getElementById('terminal-clear').addEventListener('click', () => {
            this.terminal.clear();
        });

        // Toggle button
        document.getElementById('terminal-toggle').addEventListener('click', () => {
            this.toggle();
        });

        // Handle terminal input
        this.terminal.onData((data) => {
            if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Debug special keys
                if (data.length > 1 || data.charCodeAt(0) < 32) {
                    const codes = Array.from(data).map(c => 
                        `${c.charCodeAt(0).toString(16).padStart(2, '0')}`
                    ).join(' ');
                    console.log('[Terminal] Special key pressed:', codes, 'Raw:', JSON.stringify(data));
                }
                
                // Send raw input directly to the WebSocket
                this.ws.send(JSON.stringify({
                    command: 'input',
                    sessionId: this.sessionId,
                    data: data
                }));
            } else if (!this.isConnected || !this.ws) {
                // Show error if not connected
                this.terminal.write('\r\n\x1b[31mNot connected to AI tool. Please select Claude Code or Gemini CLI.\x1b[0m\r\n');
            }
        });
        
        // Handle special keys including arrow keys
        this.terminal.attachCustomKeyEventHandler((event) => {
            // Check for Ctrl+V
            if (event.ctrlKey && event.key === 'v' && event.type === 'keydown') {
                event.preventDefault();
                navigator.clipboard.readText().then(text => {
                    if (this.isConnected && this.ws) {
                        // Send pasted text to the terminal
                        this.ws.send(JSON.stringify({
                            command: 'input',
                            sessionId: this.sessionId,
                            data: text
                        }));
                    }
                }).catch(err => {
                    console.error('Failed to read clipboard:', err);
                });
                return false; // Prevent default handling
            }
            
            // Let xterm.js handle all other keys normally, including arrow keys
            // This ensures proper ANSI escape sequence generation
            return true;
        });
        
        // Also handle browser paste event on the terminal element
        this.terminalElement.addEventListener('paste', (event) => {
            event.preventDefault();
            const pastedText = event.clipboardData.getData('text');
            if (pastedText && this.isConnected && this.ws) {
                this.ws.send(JSON.stringify({
                    command: 'input',
                    sessionId: this.sessionId,
                    data: pastedText
                }));
            }
        });
        
        // Add right-click context menu for paste
        this.terminalElement.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            
            // Remove any existing context menu
            const existingMenu = document.querySelector('.terminal-context-menu');
            if (existingMenu) {
                existingMenu.remove();
            }
            
            // Create context menu
            const menu = document.createElement('div');
            menu.className = 'terminal-context-menu';
            menu.style.cssText = `
                position: fixed;
                left: ${event.clientX}px;
                top: ${event.clientY}px;
                background: #2a2a2a;
                border: 1px solid #444;
                border-radius: 4px;
                padding: 4px 0;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                z-index: 10000;
            `;
            
            const pasteOption = document.createElement('div');
            pasteOption.textContent = 'Paste';
            pasteOption.style.cssText = `
                padding: 6px 16px;
                cursor: pointer;
                color: #fff;
                font-size: 14px;
                font-family: 'Segoe UI', Arial, sans-serif;
            `;
            pasteOption.onmouseover = () => pasteOption.style.background = '#3a3a3a';
            pasteOption.onmouseout = () => pasteOption.style.background = 'transparent';
            pasteOption.onclick = async () => {
                try {
                    const text = await navigator.clipboard.readText();
                    if (text && this.isConnected && this.ws) {
                        this.ws.send(JSON.stringify({
                            command: 'input',
                            data: text
                        }));
                    }
                } catch (err) {
                    console.error('Failed to read clipboard:', err);
                }
                menu.remove();
            };
            
            menu.appendChild(pasteOption);
            document.body.appendChild(menu);
            
            // Remove menu when clicking elsewhere
            const removeMenu = () => {
                menu.remove();
                document.removeEventListener('click', removeMenu);
            };
            setTimeout(() => document.addEventListener('click', removeMenu), 0);
        });
        
        // Handle terminal resize
        this.terminal.onResize((dimensions) => {
            if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionId) {
                this.ws.send(JSON.stringify({
                    command: 'resize',
                    sessionId: this.sessionId,
                    cols: dimensions.cols,
                    rows: dimensions.rows
                }));
            }
        });

        // Handle window resize
        window.addEventListener('resize', () => {
            if (this.fitAddon) {
                this.fitAddon.fit();
            }
        });

        // Fit terminal when toggling
        const observer = new ResizeObserver(() => {
            if (this.fitAddon) {
                this.fitAddon.fit();
            }
        });
        observer.observe(this.terminalElement);
    }

    async connect() {
        if (this.currentTool === null) {
            this.terminal.writeln('\x1b[31mNo AI Assistant selected. Please choose Claude Code or Gemini CLI.\x1b[0m');
            return;
        }
        
        try {
            this.ws = new WebSocket('ws://localhost:8003');
            
            this.ws.onopen = () => {
                this.isConnected = true;
                this.sessionId = this.generateSessionId();
                
                // Initialize session
                this.ws.send(JSON.stringify({
                    command: 'init',
                    sessionId: this.sessionId,
                    tool: this.currentTool
                }));
                
                // Send terminal dimensions immediately after init
                setTimeout(() => {
                    if (this.fitAddon) {
                        const dims = this.fitAddon.proposeDimensions();
                        if (dims && this.ws && this.ws.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({
                                command: 'resize',
                                sessionId: this.sessionId,
                                cols: dims.cols || 80,
                                rows: dims.rows || 24
                            }));
                        }
                    }
                    // Focus terminal after connection
                    this.terminal.focus();
                }, 100);
                
                this.terminal.writeln(`\x1b[32mConnected to ${this.currentTool === 'claude' ? 'Claude Code' : 'Gemini CLI'}...\x1b[0m`);
                this.terminal.writeln('\x1b[90mTip: Use Ctrl+V or right-click to paste\x1b[0m');
                this.terminal.writeln('');
            };

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                
                if (data.type === 'output') {
                    // Debug logging for Gemini
                    if (this.currentTool === 'gemini') {
                        console.log('Gemini raw output:', JSON.stringify(data.data));
                        // Log each character code
                        const chars = Array.from(data.data).map(c => {
                            const code = c.charCodeAt(0);
                            return `${c} (${code}/0x${code.toString(16)})`;
                        });
                        console.log('Characters:', chars.join(' '));
                    }
                    
                    // Filter problematic sequences from Gemini
                    let output = data.data;
                    if (this.currentTool === 'gemini') {
                        // Log all escape sequences found
                        const escapeSequences = output.match(/\x1b\[[^m]*[mHJKL]/g) || [];
                        if (escapeSequences.length > 0) {
                            console.log('Escape sequences found:', escapeSequences.map(seq => {
                                return seq.replace(/\x1b/g, 'ESC');
                            }));
                        }
                        
                        // Remove the 'w' spam - these might be width detection attempts
                        if (output.match(/^w+$/) || output.match(/^w+\r?\n?$/)) {
                            console.log('Filtering out w spam');
                            return;
                        }
                        
                        // Also filter if it's just a bunch of w's at the start
                        if (output.match(/^w{5,}/)) {
                            output = output.replace(/^w+/, '');
                            console.log('Removed leading w characters');
                        }
                        
                        // Comprehensive filtering of problematic escape sequences
                        const sequencesToFilter = [
                            /\x1b\[\?1049[hl]/g,     // Alternate screen buffer
                            /\x1b\[\d*J/g,           // Clear screen variants (0J, 1J, 2J, 3J)
                            /\x1b\[\d*;\d*H/g,       // Cursor positioning
                            /\x1b\[H/g,              // Cursor home
                            /\x1b\[\?25[hl]/g,       // Hide/show cursor
                            /\x1b\[\d*K/g,           // Clear line variants
                            /\x1b\[m/g,              // Reset attributes (sometimes causes issues)
                            /\x1bc/g,                // Reset terminal
                            /\x1b\[\?1[hl]/g,        // Application cursor keys
                            /\x1b\[\?47[hl]/g,       // Alternate screen (older variant)
                            /\x1b\[\?1047[hl]/g,     // Alternate screen with clear
                        ];
                        
                        let originalOutput = output;
                        sequencesToFilter.forEach(regex => {
                            output = output.replace(regex, '');
                        });
                        
                        // Log what we filtered
                        if (output !== originalOutput) {
                            console.log('Filtered output:', JSON.stringify(output));
                            console.log('Removed sequences:', originalOutput.match(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g));
                        }
                    }
                    
                    // Write output to terminal
                    if (output.length > 0) {
                        this.terminal.write(output);
                    }
                } else if (data.type === 'initialized') {
                    this.terminal.writeln('\x1b[32mSession initialized. Ready for commands.\x1b[0m');
                    this.terminal.focus();
                    
                    // Force a clear and reset for Gemini to ensure clean state
                    if (this.currentTool === 'gemini') {
                        setTimeout(() => {
                            // Send a newline to trigger Gemini's prompt
                            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                                this.ws.send(JSON.stringify({
                                    command: 'input',
                                    data: '\n'
                                }));
                            }
                        }, 500);
                    } else if (this.currentTool === 'claude') {
                        // For Claude, ensure the terminal is ready for input
                        setTimeout(() => {
                            this.terminal.focus();
                            // Send a newline to ensure Claude shows its prompt
                            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                                this.ws.send(JSON.stringify({
                                    command: 'input',
                                    data: '\n'
                                }));
                            }
                        }, 500);
                    }
                } else if (data.type === 'error') {
                    this.terminal.writeln(`\x1b[31m${data.data}\x1b[0m`);
                }
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.terminal.writeln('\x1b[31mWebSocket connection error\x1b[0m');
            };

            this.ws.onclose = () => {
                this.isConnected = false;
                this.terminal.writeln('\x1b[31mDisconnected from terminal server.\x1b[0m');
            };
        } catch (error) {
            console.error('Failed to connect to terminal server:', error);
            this.terminal.writeln(`\x1b[31mFailed to connect: ${error.message}\x1b[0m`);
        }
    }

    async switchToolWithRestart(tool) {
        const wasNull = this.currentTool === null;
        
        if (this.currentTool === tool) {
            // Already on this tool, but restart anyway for fresh environment
            this.terminal.writeln(`\x1b[33mRestarting ${tool === 'gemini' ? 'Gemini CLI' : 'Claude Code'}...\x1b[0m`);
        } else {
            this.currentTool = tool;
            if (wasNull) {
                this.terminal.writeln(`\x1b[33mStarting ${tool === 'gemini' ? 'Gemini CLI' : 'Claude Code'}...\x1b[0m`);
            } else {
                this.terminal.writeln(`\x1b[33mSwitching to ${tool === 'gemini' ? 'Gemini CLI' : 'Claude Code'}...\x1b[0m`);
            }
        }
        
        // Update button states
        document.querySelectorAll('.terminal-tool-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.getElementById(`ai-tool-${tool}`).classList.add('active');
        
        // Show loading state
        this.terminal.writeln('\x1b[33mSwitching AI tool...\x1b[0m');
        
        try {
            // Close current connection
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
                this.isConnected = false;
                // Wait for close to complete
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            // Clear terminal for fresh start (but not for Gemini - it does its own clearing)
            if (this.currentTool !== 'gemini') {
                this.terminal.clear();
            }
            
            // No need to restart local services
            
            // Wait for the service to be ready with status updates
            this.terminal.writeln('\x1b[33mWaiting for service to be ready...\x1b[0m');
            
            // Poll for service readiness
            let attempts = 0;
            const maxAttempts = 20; // 20 seconds max
            
            while (attempts < maxAttempts) {
                try {
                    // Try to connect
                    const testWs = new WebSocket('ws://localhost:8003');
                    await new Promise((resolve, reject) => {
                        testWs.onopen = () => {
                            testWs.close();
                            resolve();
                        };
                        testWs.onerror = reject;
                        setTimeout(() => reject(new Error('Timeout')), 1000);
                    });
                    
                    // If we get here, service is ready
                    this.terminal.writeln('\x1b[32mService is ready!\x1b[0m');
                    break;
                } catch (e) {
                    // Not ready yet
                    if (attempts % 4 === 0) {
                        this.terminal.write('.');
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    attempts++;
                }
            }
            
            if (attempts >= maxAttempts) {
                this.terminal.writeln('\n\x1b[31mService took too long to start.\x1b[0m');
                return;
            }
            
            // Reconnect to the selected tool
            this.terminal.writeln(`\x1b[33mConnecting to ${this.currentTool === 'gemini' ? 'Gemini CLI' : 'Claude Code'}...\x1b[0m`);
            await this.connect();
        } catch (error) {
            this.terminal.writeln(`\x1b[31mFailed to restart service: ${error.message}\x1b[0m`);
        }
    }

    async checkCLIStatus() {
        try {
            const { ipcRenderer } = require('electron');
            const result = await ipcRenderer.invoke('check-cli-tools');
            if (result.success) {
                // Update UI with installation status
                const claudeBtn = document.getElementById('ai-tool-claude');
                const geminiBtn = document.getElementById('ai-tool-gemini');
                
                if (claudeBtn) {
                    const statusDot = claudeBtn.querySelector('.tool-status-dot');
                    if (result.tools.claude.installed) {
                        statusDot.style.backgroundColor = '#4CAF50';
                        claudeBtn.title = `Claude Code - Installed (${result.tools.claude.version || 'version unknown'})`;
                    } else {
                        statusDot.style.backgroundColor = '#f44336';
                        claudeBtn.title = 'Claude Code - Not installed. In WSL, run: npm install -g @anthropic-ai/claude-code';
                    }
                }
                
                if (geminiBtn) {
                    const statusDot = geminiBtn.querySelector('.tool-status-dot');
                    if (result.tools.gemini.installed) {
                        statusDot.style.backgroundColor = '#4CAF50';
                        geminiBtn.title = `Gemini CLI - Installed (${result.tools.gemini.version || 'version unknown'})`;
                    } else {
                        statusDot.style.backgroundColor = '#f44336';
                        geminiBtn.title = 'Gemini CLI - Not installed. In WSL, run: npm install @google/gemini-cli';
                    }
                }
                
                return result.tools;
            }
        } catch (error) {
            console.error('Failed to check CLI status:', error);
        }
        return null;
    }
    
    toggle() {
        this.terminalElement.classList.toggle('collapsed');
        const toggleBtn = document.getElementById('terminal-toggle');
        toggleBtn.textContent = this.terminalElement.classList.contains('collapsed') ? '▲' : '▼';
        
        // Only refit if terminal is being expanded
        if (!this.terminalElement.classList.contains('collapsed')) {
            // Refit terminal after toggle animation completes
            setTimeout(() => {
                if (this.fitAddon && this.terminal) {
                    this.fitAddon.fit();
                    // Force a refresh to ensure content is visible
                    this.terminal.refresh(0, this.terminal.rows - 1);
                }
            }, 350);
        }
    }

    generateSessionId() {
        return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    
    sendCommand(command, options = {}) {
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send command: terminal not connected');
            return false;
        }
        
        // Check if we should use non-interactive mode
        const useNonInteractive = options.nonInteractive || false;
        const useYolo = options.yolo || false;
        
        console.log(`[Terminal] sendCommand called: tool=${this.currentTool}, nonInteractive=${useNonInteractive}, command="${command.substring(0, 50)}..."`)
        
        if ((this.currentTool === 'gemini' || this.currentTool === 'claude') && useNonInteractive) {
            let cliCommand;
            
            if (this.currentTool === 'gemini') {
                // For Gemini non-interactive mode, wrap the command with gemini -p
                cliCommand = `gemini -p "${command.replace(/"/g, '\\"')}"`;
                
                // Add YOLO mode if requested
                if (useYolo) {
                    cliCommand = `gemini --yolo -p "${command.replace(/"/g, '\\"')}"`;
                }
            } else if (this.currentTool === 'claude') {
                // For Claude non-interactive mode, use -p flag
                cliCommand = `claude -p "${command.replace(/"/g, '\\"')}"`;
                
                // Add YOLO mode if requested (--dangerously-skip-permissions)
                if (useYolo) {
                    cliCommand = `claude --dangerously-skip-permissions -p "${command.replace(/"/g, '\\"')}"`;
                }
                
                // Add allowed tools if specified
                if (options.allowedTools && options.allowedTools.length > 0) {
                    const toolsList = options.allowedTools.join(',');
                    cliCommand = cliCommand.replace('claude', `claude --allowed-tools ${toolsList}`);
                }
            }
            
            // Display the command in the terminal
            this.terminal.writeln('$ ' + cliCommand);
            
            // Send the wrapped command
            console.log(`[Terminal] Sending non-interactive command: ${cliCommand}`);
            this.ws.send(JSON.stringify({
                command: 'input',
                sessionId: this.sessionId,
                data: cliCommand + '\n'
            }));
        } else {
            // For interactive mode, we need to wait for the prompt
            if (this.currentTool === 'claude') {
                // Don't echo the command for Claude - it will show in the prompt
                // Wait a bit to ensure Claude's prompt is ready
                setTimeout(() => {
                    // Send the command directly to Claude's prompt
                    console.log(`[Terminal] Sending to Claude interactive prompt: ${command}`);
                    this.ws.send(JSON.stringify({
                        command: 'input',
                        sessionId: this.sessionId,
                        data: command + '\n'
                    }));
                }, 200);
            } else {
                // Original behavior for interactive Gemini
                this.terminal.writeln('$ ' + command);
                
                // Send the command
                this.ws.send(JSON.stringify({
                    command: 'input',
                    data: command + '\n'
                }));
                
                // For Gemini interactive mode, send an extra Enter
                if (this.currentTool === 'gemini' && !useNonInteractive) {
                    setTimeout(() => {
                        this.ws.send(JSON.stringify({
                            command: 'input',
                            data: '\n'
                        }));
                    }, 100);
                }
            }
        }
        
        return true;
    }
    
    // Helper method to execute commands with Gemini in non-interactive mode
    executeGeminiCommand(prompt, options = {}) {
        if (this.currentTool !== 'gemini') {
            console.error('executeGeminiCommand can only be used with Gemini CLI');
            return false;
        }
        
        // Default to non-interactive mode for this method
        const commandOptions = {
            nonInteractive: true,
            yolo: options.yolo || false,
            ...options
        };
        
        return this.sendCommand(prompt, commandOptions);
    }
    
    // Helper method to execute commands with Claude in non-interactive mode
    executeClaudeCommand(prompt, options = {}) {
        if (this.currentTool !== 'claude') {
            console.error('executeClaudeCommand can only be used with Claude Code');
            return false;
        }
        
        // Default to non-interactive mode for this method
        const commandOptions = {
            nonInteractive: true,
            yolo: options.yolo || false,
            allowedTools: options.allowedTools || [],
            ...options
        };
        
        return this.sendCommand(prompt, commandOptions);
    }
    
    // Generic helper for non-interactive execution
    executeAICommand(prompt, options = {}) {
        if (!this.currentTool) {
            console.error('No AI tool selected');
            return false;
        }
        
        const commandOptions = {
            nonInteractive: true,
            ...options
        };
        
        return this.sendCommand(prompt, commandOptions);
    }
    
    // Send command to Claude's interactive prompt
    sendToClaudePrompt(command) {
        if (this.currentTool !== 'claude') {
            console.error('sendToClaudePrompt can only be used with Claude Code');
            return false;
        }
        
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send command: terminal not connected');
            return false;
        }
        
        // For Claude interactive mode, send directly without wrapping
        // This assumes Claude's prompt is ready and waiting
        console.log(`[Terminal] Sending to Claude prompt: "${command}"`);
        
        // Send the command directly - Claude will show it in the prompt box
        this.ws.send(JSON.stringify({
            command: 'input',
            sessionId: this.sessionId,
            data: command + '\n'
        }));
        
        return true;
    }
    
    // Method to switch between interactive and non-interactive modes
    setAIMode(mode) {
        if (!this.currentTool) {
            console.error('No AI tool selected');
            return;
        }
        
        this.aiMode = mode; // 'interactive' or 'non-interactive'
        console.log(`${this.currentTool === 'claude' ? 'Claude' : 'Gemini'} mode set to: ${mode}`);
    }
    
    // Install Whisper.cpp
    async installWhisper() {
        // Make sure terminal is visible
        if (this.terminalElement.classList.contains('collapsed')) {
            this.toggle();
        }
        
        // Clear terminal
        this.terminal.clear();
        this.terminal.writeln('\x1b[32mStarting OpenAI Whisper installation...\x1b[0m');
        this.terminal.writeln('\x1b[90m(Python version - no compilation required)\x1b[0m');
        this.terminal.writeln('');
        
        // Connect directly for whisper installation (no tool needed)
        if (!this.isConnected) {
            try {
                this.ws = new WebSocket('ws://localhost:8003');
                
                this.ws.onopen = () => {
                    this.isConnected = true;
                    this.sessionId = this.generateSessionId();
                    
                    // Send install command immediately
                    this.ws.send(JSON.stringify({
                        command: 'install-whisper',
                        sessionId: this.sessionId
                    }));
                };
                
                this.ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    if (data.type === 'output') {
                        this.terminal.write(data.data);
                    }
                };
                
                this.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                    this.terminal.writeln('\x1b[31mWebSocket connection error\x1b[0m');
                };
                
                this.ws.onclose = () => {
                    this.isConnected = false;
                    this.terminal.writeln('\n\x1b[33mInstallation process completed.\x1b[0m');
                };
            } catch (error) {
                console.error('Failed to connect to terminal server:', error);
                this.terminal.writeln(`\x1b[31mFailed to connect: ${error.message}\x1b[0m`);
            }
        } else {
            // Already connected, just send the command
            this.ws.send(JSON.stringify({
                command: 'install-whisper',
                sessionId: this.sessionId || this.generateSessionId()
            }));
        }
    }
}

// Export for use in main app
window.AITerminal = AITerminal;