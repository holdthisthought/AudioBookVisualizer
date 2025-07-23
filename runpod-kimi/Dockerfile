FROM runpod/pytorch:2.2.1-py3.10-cuda12.1.1-devel-ubuntu22.04

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

# Try to install vLLM, but don't fail the build if it doesn't work
# vLLM has complex dependencies that may conflict
RUN pip install --no-cache-dir vllm==0.5.0 || echo "Warning: vLLM installation failed, will use transformers instead"

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