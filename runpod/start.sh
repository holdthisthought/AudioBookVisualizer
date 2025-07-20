#!/bin/bash
# Start script for RunPod ComfyUI worker

echo "Starting RunPod ComfyUI worker..."

# Set up environment
export PYTHONUNBUFFERED=1
export COMFYUI_PATH=/workspace/ComfyUI

# Ensure ComfyUI directory exists
if [ ! -d "$COMFYUI_PATH" ]; then
    echo "Error: ComfyUI not found at $COMFYUI_PATH"
    exit 1
fi

# Start the handler
cd /workspace
python handler.py