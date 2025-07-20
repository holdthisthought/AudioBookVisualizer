const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class FluxManager {
    constructor() {
        this.serviceName = 'audiobook-flux-service';
        this.serviceDir = path.join(__dirname, 'flux-service');
        this.dockerComposeFile = path.join(this.serviceDir, 'docker-compose.yml');
    }

    // Check if Docker is installed and running
    async checkDocker() {
        return new Promise((resolve) => {
            exec('docker version', (error) => {
                if (error) {
                    resolve({ installed: false, running: false });
                } else {
                    exec('docker ps', (error) => {
                        resolve({ installed: true, running: !error });
                    });
                }
            });
        });
    }

    // Check if the FLUX service container exists and its status
    async getServiceStatus() {
        return new Promise((resolve) => {
            exec(`docker ps -a --filter name=${this.serviceName} --format "{{.Status}}"`, (error, stdout) => {
                if (error || !stdout.trim()) {
                    resolve({ exists: false, running: false });
                } else {
                    const status = stdout.trim().toLowerCase();
                    resolve({
                        exists: true,
                        running: status.startsWith('up'),
                        status: status
                    });
                }
            });
        });
    }

    // Check if the FLUX service is healthy
    async checkServiceHealth() {
        try {
            const response = await fetch('http://localhost:8001/');
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    // Get complete setup status
    async getSetupStatus() {
        const docker = await this.checkDocker();
        const service = await this.getServiceStatus();
        const healthy = service.running ? await this.checkServiceHealth() : false;

        return {
            docker,
            service: {
                ...service,
                healthy
            }
        };
    }

    // Start the FLUX service
    async startService(progressCallback) {
        return new Promise(async (resolve, reject) => {
            try {
                progressCallback({ progress: 0, message: 'Checking Docker status...' });
                
                const docker = await this.checkDocker();
                if (!docker.installed) {
                    reject(new Error('Docker is not installed'));
                    return;
                }
                if (!docker.running) {
                    reject(new Error('Docker is not running'));
                    return;
                }

                progressCallback({ progress: 10, message: 'Checking FLUX service...' });
                
                const serviceStatus = await this.getServiceStatus();
                
                if (serviceStatus.exists && serviceStatus.running) {
                    progressCallback({ progress: 90, message: 'Service already running' });
                    const healthy = await this.waitForHealth();
                    if (healthy) {
                        progressCallback({ progress: 100, message: 'Service is ready!' });
                        resolve({ success: true });
                    } else {
                        reject(new Error('Service is running but not healthy'));
                    }
                    return;
                }

                // If container exists but not running, start it
                if (serviceStatus.exists && !serviceStatus.running) {
                    progressCallback({ progress: 30, message: 'Starting existing container...' });
                    exec(`docker start ${this.serviceName}`, async (error) => {
                        if (error) {
                            reject(new Error(`Failed to start container: ${error.message}`));
                            return;
                        }
                        
                        progressCallback({ progress: 70, message: 'Waiting for service to be ready...' });
                        const healthy = await this.waitForHealth(progressCallback);
                        if (healthy) {
                            progressCallback({ progress: 100, message: 'Service is ready!' });
                            resolve({ success: true });
                        } else {
                            reject(new Error('Service started but not healthy'));
                        }
                    });
                    return;
                }

                // Container doesn't exist, use docker-compose to create and start
                progressCallback({ progress: 20, message: 'Building FLUX service container...' });
                
                const composeProcess = spawn('docker-compose', ['up', '-d'], {
                    cwd: this.serviceDir,
                    shell: true
                });

                let errorOutput = '';
                
                composeProcess.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                    // Update progress based on docker-compose output
                    if (data.toString().includes('Creating')) {
                        progressCallback({ progress: 40, message: 'Creating container...' });
                    } else if (data.toString().includes('Starting')) {
                        progressCallback({ progress: 60, message: 'Starting container...' });
                    }
                });

                composeProcess.on('close', async (code) => {
                    if (code !== 0) {
                        reject(new Error(`Docker-compose failed: ${errorOutput}`));
                        return;
                    }

                    // Wait a moment for docker-compose to fully complete container creation
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // Verify the container was actually created and is running
                    const serviceStatus = await this.getServiceStatus();
                    if (!serviceStatus.exists || !serviceStatus.running) {
                        reject(new Error('Container was not created or started properly. Please try starting the service again.'));
                        return;
                    }

                    progressCallback({ progress: 80, message: 'Waiting for service to be ready...' });
                    const healthy = await this.waitForHealth(progressCallback);
                    if (healthy) {
                        progressCallback({ progress: 100, message: 'Service is ready!' });
                        resolve({ success: true });
                    } else {
                        reject(new Error('Service started but not healthy'));
                    }
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    // Wait for service to be healthy
    async waitForHealth(progressCallback) {
        const maxAttempts = 60; // 5 minutes
        let attempts = 0;
        
        while (attempts < maxAttempts) {
            const healthy = await this.checkServiceHealth();
            if (healthy) {
                return true;
            }
            
            if (progressCallback && attempts % 6 === 0) {
                progressCallback({ 
                    progress: 80 + Math.min(15, (attempts / maxAttempts) * 15), 
                    message: `Waiting for service... (${attempts}s)` 
                });
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }
        
        return false;
    }

    // Stop the service
    async stopService() {
        return new Promise((resolve, reject) => {
            exec(`docker stop ${this.serviceName}`, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve({ success: true });
                }
            });
        });
    }

    // Get service logs
    async getLogs(lines = 100) {
        return new Promise((resolve, reject) => {
            exec(`docker logs --tail ${lines} ${this.serviceName}`, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }
}

module.exports = FluxManager;