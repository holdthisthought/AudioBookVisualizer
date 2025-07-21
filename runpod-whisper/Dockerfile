# Whisper RunPod Serverless Endpoint
# Use RunPod's PyTorch image to save space
FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install only essential system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (PyTorch already in base image)
RUN pip install --no-cache-dir \
    runpod==1.6.2 \
    faster-whisper==1.0.3 \
    numpy \
    requests

# Create model directory
RUN mkdir -p /models/whisper

# Set environment for model storage
ENV WHISPER_MODELS_DIR=/models/whisper

# Copy handler
COPY handler.py /app/handler.py
WORKDIR /app

# RunPod handler
CMD ["python", "-u", "handler.py"]