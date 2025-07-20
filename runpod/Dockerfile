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

# Install unzip if not available
RUN apt-get update && apt-get install -y unzip wget

# Download and install ComfyUI-Manager (optional)
RUN wget -q https://github.com/ltdrdata/ComfyUI-Manager/archive/refs/heads/main.zip -O manager.zip && \
    unzip -q manager.zip && \
    rm manager.zip && \
    mv ComfyUI-Manager-main ComfyUI-Manager || true

# Download and install FLUX Kontext custom nodes
RUN wget -q https://github.com/melMass/ComfyUI-Flux-Kontext/archive/refs/heads/main.zip -O kontext.zip && \
    unzip -q kontext.zip && \
    rm kontext.zip && \
    mv ComfyUI-Flux-Kontext-main ComfyUI-Flux-Kontext && \
    cd ComfyUI-Flux-Kontext && \
    if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt || true; fi

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
cd /workspace\n\
python handler.py' > /workspace/start.sh && chmod +x /workspace/start.sh

# RunPod serverless entrypoint
CMD ["/workspace/start.sh"]