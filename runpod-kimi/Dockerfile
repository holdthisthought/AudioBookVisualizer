FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04

# Set working directory
WORKDIR /workspace

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt /workspace/
RUN pip install --no-cache-dir -r requirements.txt

# Install vLLM (required for efficient inference)
RUN pip install vllm>=0.5.0

# Note: The model will be downloaded on first run to avoid large image sizes
# This also allows flexibility in model selection via environment variables

# Copy the handler
COPY handler.py /workspace/

# Set environment variables
ENV MODEL_NAME="moonshotai/Kimi-K2-Instruct"
ENV DOWNLOAD_MODEL_ON_START="true"
ENV MODEL_PATH="/workspace/models"
ENV PYTHONPATH=/workspace

# RunPod serverless entrypoint
CMD ["python", "-u", "handler.py"]