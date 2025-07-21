// System Monitor Module
class SystemMonitor {
    constructor() {
        this.updateInterval = null;
        this.isElectron = typeof require !== 'undefined' && require('electron');
        
        if (this.isElectron) {
            this.ipcRenderer = require('electron').ipcRenderer;
        }
    }

    updateMonitorBar(barId, percentage) {
        const bar = document.getElementById(barId);
        if (bar) {
            bar.style.width = percentage + '%';
        }
    }

    async updateSystemStats() {
        try {
            if (this.isElectron && this.ipcRenderer) {
                // Get stats from main process
                const stats = await this.ipcRenderer.invoke('get-system-stats');
                
                if (stats && !stats.error) {
                    // Update Memory
                    const memoryUsage = document.getElementById('memory-usage');
                    if (memoryUsage) {
                        memoryUsage.textContent = stats.memory.percentage + '%';
                        this.updateMonitorBar('memory-bar', stats.memory.percentage);
                    }
                    
                    // Update CPU
                    const cpuUsage = document.getElementById('cpu-usage');
                    if (cpuUsage) {
                        cpuUsage.textContent = stats.cpu.percentage + '%';
                        this.updateMonitorBar('cpu-bar', stats.cpu.percentage);
                    }
                    
                    // Update GPU
                    const gpuUsage = document.getElementById('gpu-usage');
                    if (gpuUsage) {
                        gpuUsage.textContent = stats.gpu.percentage + '%';
                        this.updateMonitorBar('gpu-bar', stats.gpu.percentage);
                    }
                    
                    // Update VRAM
                    const vramUsage = document.getElementById('vram-usage');
                    if (vramUsage) {
                        vramUsage.textContent = stats.vram.percentage + '%';
                        this.updateMonitorBar('vram-bar', stats.vram.percentage);
                    }
                }
            }
        } catch (error) {
            console.error('Error updating system stats:', error);
        }
    }

    start() {
        // Initial update
        this.updateSystemStats();
        
        // Update every 1 second for more responsive monitoring
        this.updateInterval = setInterval(() => {
            this.updateSystemStats();
        }, 1000);
    }

    stop() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}

// Initialize system monitor when DOM is ready
if (typeof window !== 'undefined') {
    window.systemMonitor = new SystemMonitor();
    
    // Start monitoring when page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.systemMonitor.start();
        });
    } else {
        window.systemMonitor.start();
    }
}