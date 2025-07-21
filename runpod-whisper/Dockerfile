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
RUN pip install --no-cache-dir \
    runpod==1.6.2 \
    faster-whisper==1.0.3 \
    numpy \
    torch==2.1.0 --index-url https://download.pytorch.org/whl/cu118

# Create model directory
RUN mkdir -p /models/whisper

# Download all Whisper models during build
RUN python -c "from faster_whisper import WhisperModel; \
    import os; \
    os.environ['HF_HOME'] = '/models'; \
    print('Downloading Whisper models...'); \
    for size in ['tiny', 'base', 'small', 'medium', 'large-v3']: \
        print(f'Downloading {size} model...'); \
        model = WhisperModel(size, device='cpu', compute_type='float16', download_root='/models/whisper'); \
        del model; \
    print('All models downloaded!')"

# Set environment variable for model cache
ENV HF_HOME=/models
ENV WHISPER_CACHE=/models/whisper

# Copy handler
COPY handler.py /app/handler.py
WORKDIR /app

# RunPod handler
CMD ["python", "-u", "handler.py"]