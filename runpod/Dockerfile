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

# Create placeholder directories for custom nodes
# These will be populated at runtime if needed
RUN mkdir -p ComfyUI-Manager ComfyUI-Flux-Kontext

# Create a script to install custom nodes at runtime
RUN echo '#!/bin/bash\n\
echo "Checking for custom nodes..."\n\
cd /workspace/ComfyUI/custom_nodes\n\
if [ ! -f ComfyUI-Flux-Kontext/.installed ]; then\n\
    echo "Installing ComfyUI-Flux-Kontext..."\n\
    rm -rf ComfyUI-Flux-Kontext\n\
    git clone https://github.com/melMass/ComfyUI-Flux-Kontext.git 2>/dev/null || \\\n\
    wget -q https://github.com/melMass/ComfyUI-Flux-Kontext/archive/refs/heads/main.zip -O k.zip && \\\n\
    unzip -q k.zip && rm k.zip && mv ComfyUI-Flux-Kontext-main ComfyUI-Flux-Kontext\n\
    cd ComfyUI-Flux-Kontext && touch .installed\n\
    if [ -f requirements.txt ]; then pip install -q -r requirements.txt 2>/dev/null || true; fi\n\
fi\n\
echo "Custom nodes ready"' > /workspace/install_custom_nodes.sh && \
    chmod +x /workspace/install_custom_nodes.sh

# Create model directories
RUN mkdir -p /workspace/ComfyUI/models/unet \
    /workspace/ComfyUI/models/clip \
    /workspace/ComfyUI/models/vae \
    /workspace/ComfyUI/models/checkpoints

# Copy scripts from current directory
COPY download_models.py /workspace/download_models.py
COPY handler.py /workspace/handler.py

# Download models during build (optional - can be done at runtime)
# RUN python /workspace/download_models.py

# Install RunPod SDK
RUN pip install --no-cache-dir runpod

# Set working directory back to workspace
WORKDIR /workspace

# Create start script inline
RUN echo '#!/bin/bash\n\
echo "Starting RunPod ComfyUI worker..."\n\
export PYTHONUNBUFFERED=1\n\
export COMFYUI_PATH=/workspace/ComfyUI\n\
# Install custom nodes if needed\n\
/workspace/install_custom_nodes.sh\n\
cd /workspace\n\
python handler.py' > /workspace/start.sh && chmod +x /workspace/start.sh

# RunPod serverless entrypoint
CMD ["/workspace/start.sh"]