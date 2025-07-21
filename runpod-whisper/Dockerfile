# Whisper RunPod Serverless Endpoint
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3.10 \
    python3-pip \
    git \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set Python 3.10 as default
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.10 1
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.10 1

# Upgrade pip
RUN python -m pip install --upgrade pip

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Install PyTorch first with CUDA 11.8
RUN pip install --no-cache-dir torch==2.1.0 torchvision==0.16.0 --index-url https://download.pytorch.org/whl/cu118

# Install other dependencies
RUN pip install --no-cache-dir \
    runpod==1.6.2 \
    faster-whisper==1.0.3 \
    numpy \
    requests

# Create model directory
RUN mkdir -p /models/whisper

# Download all Whisper models during build
RUN python -c "\
from faster_whisper import WhisperModel; \
import os; \
os.environ['HF_HOME'] = '/models'; \
print('Downloading Whisper models...'); \
for size in ['tiny', 'base', 'small', 'medium', 'large-v3']: \
    try: \
        print(f'Downloading {size} model...'); \
        model = WhisperModel(size, device='cpu', compute_type='int8', download_root='/models/whisper'); \
        del model; \
        print(f'{size} model downloaded successfully'); \
    except Exception as e: \
        print(f'Warning: Failed to download {size} model: {e}'); \
print('Model download complete!');"

# Set environment variable for model cache
ENV HF_HOME=/models
ENV WHISPER_CACHE=/models/whisper

# Copy handler
COPY handler.py /app/handler.py
WORKDIR /app

# RunPod handler
CMD ["python", "-u", "handler.py"]