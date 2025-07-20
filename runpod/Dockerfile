# RunPod ComfyUI with FLUX.1 Kontext Dev
FROM runpod/pytorch:2.2.1-py3.10-cuda12.1.1-devel-ubuntu22.04

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    git-lfs \
    wget \
    curl \
    vim \
    unzip \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    libgoogle-perftools4 \
    libtcmalloc-minimal4 \
    ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Clone ComfyUI
RUN git clone https://github.com/comfyanonymous/ComfyUI.git /workspace/ComfyUI

# Install ComfyUI requirements
WORKDIR /workspace/ComfyUI
RUN pip install --no-cache-dir \
    torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 \
    && pip install --no-cache-dir -r requirements.txt

# Install custom nodes for FLUX Kontext
WORKDIR /workspace/ComfyUI/custom_nodes

# Create empty directory for custom nodes (will be populated at runtime)
RUN mkdir -p ComfyUI-Flux-Kontext

# Create a script to install custom nodes at runtime
RUN cat > /workspace/install_custom_nodes.sh << 'EOF'
#!/bin/bash
echo "Custom nodes check skipped - using standard ComfyUI nodes"
EOF

RUN chmod +x /workspace/install_custom_nodes.sh

# Create model directories and Network Volume mount point
RUN mkdir -p /workspace/ComfyUI/models/unet \
    /workspace/ComfyUI/models/clip \
    /workspace/ComfyUI/models/vae \
    /workspace/ComfyUI/models/checkpoints \
    /runpod-volume

# Copy scripts from current directory
COPY download_models.py /workspace/download_models.py
COPY handler.py /workspace/handler.py

# Download models during build (optional - can be done at runtime)
# RUN python /workspace/download_models.py

# Install RunPod SDK
RUN pip install --no-cache-dir runpod

# Set working directory back to workspace
WORKDIR /workspace

# Create start script inline using heredoc
RUN cat > /workspace/start.sh << 'EOF'
#!/bin/bash
echo "Starting RunPod ComfyUI worker..."
export PYTHONUNBUFFERED=1
export COMFYUI_PATH=/workspace/ComfyUI
# Install custom nodes if needed
/workspace/install_custom_nodes.sh
cd /workspace
python handler.py
EOF

RUN chmod +x /workspace/start.sh

# RunPod serverless entrypoint
CMD ["/workspace/start.sh"]