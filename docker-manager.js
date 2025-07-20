const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

class DockerManager {
    constructor() {
        this.isBuilding = false;
        this.buildProcess = null;
        this.dockerPath = null;
    }

    async initialize() {
        // Check if Docker is installed
        this.dockerPath = await this.findDocker();
        return !!this.dockerPath;
    }

    async findDocker() {
        const possiblePaths = [
            'docker', // In PATH
            '/usr/local/bin/docker',
            '/usr/bin/docker',
            'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
            'C:\\Program Files\\Docker\\Docker\\resources\\docker.exe',
            path.join(os.homedir(), 'AppData\\Local\\Docker\\resources\\bin\\docker.exe')
        ];

        for (const dockerPath of possiblePaths) {
            try {
                await this.executeCommand(dockerPath, ['--version']);
                console.log(`Found Docker at: ${dockerPath}`);
                return dockerPath;
            } catch (error) {
                // Continue checking other paths
            }
        }

        return null;
    }

    executeCommand(command, args) {
        return new Promise((resolve, reject) => {
            const proc = spawn(command, args, {
                shell: process.platform === 'win32'
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(stderr || `Command failed with code ${code}`));
                }
            });

            proc.on('error', (error) => {
                reject(error);
            });
        });
    }

    async checkDockerRunning() {
        if (!this.dockerPath) {
            throw new Error('Docker not found');
        }

        try {
            await this.executeCommand(this.dockerPath, ['ps']);
            return true;
        } catch (error) {
            if (error.message.includes('daemon')) {
                throw new Error('Docker daemon is not running. Please start Docker Desktop.');
            }
            throw error;
        }
    }

    async checkDockerLogin(registry = 'docker.io') {
        try {
            const result = await this.executeCommand(this.dockerPath, ['system', 'info']);
            return result.includes('Username') || result.includes('Registry');
        } catch (error) {
            return false;
        }
    }

    async dockerLogin(username, accessToken, registry = 'docker.io') {
        try {
            // Use stdin to pass access token securely
            // Docker treats access tokens the same as passwords
            const proc = spawn(this.dockerPath, ['login', '--username', username, '--password-stdin', registry], {
                shell: process.platform === 'win32'
            });

            // Write access token to stdin
            proc.stdin.write(accessToken);
            proc.stdin.end();

            return new Promise((resolve, reject) => {
                let output = '';
                proc.stdout.on('data', (data) => {
                    output += data.toString();
                });
                proc.stderr.on('data', (data) => {
                    output += data.toString();
                });
                proc.on('close', (code) => {
                    if (code === 0) {
                        resolve({ success: true, message: 'Login successful' });
                    } else {
                        reject(new Error(output || 'Login failed'));
                    }
                });
            });
        } catch (error) {
            throw error;
        }
    }

    async buildImage(options) {
        const {
            dockerfilePath,
            imageName,
            tag = 'latest',
            buildArgs = {},
            onProgress
        } = options;

        if (this.isBuilding) {
            throw new Error('A build is already in progress');
        }

        this.isBuilding = true;

        try {
            await this.checkDockerRunning();

            const contextPath = path.dirname(dockerfilePath);
            const args = [
                'build',
                '-t', `${imageName}:${tag}`,
                '-f', dockerfilePath
            ];

            // Add build arguments
            for (const [key, value] of Object.entries(buildArgs)) {
                args.push('--build-arg', `${key}=${value}`);
            }

            // Add context path
            args.push(contextPath);

            console.log(`Building Docker image with args: ${args.join(' ')}`);

            return new Promise((resolve, reject) => {
                this.buildProcess = spawn(this.dockerPath, args, {
                    shell: process.platform === 'win32'
                });

                let lastProgress = 0;
                const startTime = Date.now();

                this.buildProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    console.log(output);

                    // Parse Docker build output for progress
                    if (output.includes('Step')) {
                        const match = output.match(/Step (\d+)\/(\d+)/);
                        if (match) {
                            const current = parseInt(match[1]);
                            const total = parseInt(match[2]);
                            const progress = Math.round((current / total) * 100);
                            
                            if (progress > lastProgress) {
                                lastProgress = progress;
                                if (onProgress) {
                                    onProgress({
                                        stage: 'building',
                                        progress,
                                        message: output.trim()
                                    });
                                }
                            }
                        }
                    }
                });

                this.buildProcess.stderr.on('data', (data) => {
                    const output = data.toString();
                    console.error(output);
                    
                    if (onProgress) {
                        onProgress({
                            stage: 'building',
                            progress: lastProgress,
                            message: output.trim(),
                            isError: true
                        });
                    }
                });

                this.buildProcess.on('close', (code) => {
                    this.isBuilding = false;
                    this.buildProcess = null;
                    
                    const duration = Math.round((Date.now() - startTime) / 1000);
                    
                    if (code === 0) {
                        resolve({
                            success: true,
                            duration,
                            imageName: `${imageName}:${tag}`
                        });
                    } else {
                        reject(new Error(`Build failed with code ${code}`));
                    }
                });

                this.buildProcess.on('error', (error) => {
                    this.isBuilding = false;
                    this.buildProcess = null;
                    reject(error);
                });
            });
        } catch (error) {
            this.isBuilding = false;
            throw error;
        }
    }

    async pushImage(options) {
        const {
            imageName,
            tag = 'latest',
            registry = '',
            onProgress
        } = options;

        try {
            await this.checkDockerRunning();

            const fullImageName = registry 
                ? `${registry}/${imageName}:${tag}`
                : `${imageName}:${tag}`;

            const args = ['push', fullImageName];

            console.log(`Pushing Docker image: ${fullImageName}`);

            return new Promise((resolve, reject) => {
                const pushProcess = spawn(this.dockerPath, args, {
                    shell: process.platform === 'win32'
                });

                const startTime = Date.now();
                let lastLayer = '';

                pushProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    console.log(output);

                    // Parse push progress
                    if (output.includes('Pushing') || output.includes('Pushed')) {
                        const lines = output.split('\n').filter(line => line.trim());
                        
                        for (const line of lines) {
                            if (line !== lastLayer) {
                                lastLayer = line;
                                if (onProgress) {
                                    onProgress({
                                        stage: 'pushing',
                                        message: line.trim()
                                    });
                                }
                            }
                        }
                    }
                });

                pushProcess.stderr.on('data', (data) => {
                    const output = data.toString();
                    console.error(output);
                    
                    if (onProgress) {
                        onProgress({
                            stage: 'pushing',
                            message: output.trim(),
                            isError: true
                        });
                    }
                });

                pushProcess.on('close', (code) => {
                    const duration = Math.round((Date.now() - startTime) / 1000);
                    
                    if (code === 0) {
                        resolve({
                            success: true,
                            duration,
                            imageName: fullImageName
                        });
                    } else {
                        reject(new Error(`Push failed with code ${code}`));
                    }
                });

                pushProcess.on('error', (error) => {
                    reject(error);
                });
            });
        } catch (error) {
            throw error;
        }
    }

    async tagImage(sourceName, targetName) {
        try {
            await this.executeCommand(this.dockerPath, ['tag', sourceName, targetName]);
            return true;
        } catch (error) {
            throw error;
        }
    }

    async imageExists(imageName) {
        try {
            await this.executeCommand(this.dockerPath, ['inspect', imageName]);
            return true;
        } catch (error) {
            return false;
        }
    }

    cancelBuild() {
        if (this.buildProcess) {
            this.buildProcess.kill('SIGTERM');
            this.isBuilding = false;
            this.buildProcess = null;
            return true;
        }
        return false;
    }

    async getDockerInfo() {
        try {
            const versionOutput = await this.executeCommand(this.dockerPath, ['version', '--format', 'json']);
            const version = JSON.parse(versionOutput);
            
            const infoOutput = await this.executeCommand(this.dockerPath, ['system', 'info', '--format', 'json']);
            const info = JSON.parse(infoOutput);
            
            return {
                version: version.Client?.Version || 'unknown',
                apiVersion: version.Client?.ApiVersion || 'unknown',
                os: info.OSType || 'unknown',
                architecture: info.Architecture || 'unknown',
                totalMemory: info.MemTotal || 0,
                cpus: info.NCPU || 0,
                serverVersion: version.Server?.Version || 'unknown'
            };
        } catch (error) {
            // Fallback for non-JSON format
            try {
                const versionText = await this.executeCommand(this.dockerPath, ['--version']);
                const match = versionText.match(/Docker version ([\d.]+)/);
                return {
                    version: match ? match[1] : 'unknown',
                    error: 'Could not get detailed info'
                };
            } catch (fallbackError) {
                throw new Error('Failed to get Docker info');
            }
        }
    }
}

module.exports = DockerManager;