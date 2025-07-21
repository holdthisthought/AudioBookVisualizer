#!/bin/bash

# Build Whisper RunPod Docker image locally
# The image will be automatically built and pushed to GitHub Container Registry
# when changes are pushed to the repository

IMAGE_NAME="audiobook-whisper-runpod"
TAG="latest"

echo "Building Whisper RunPod Docker image locally..."
docker build -t $IMAGE_NAME:$TAG .

echo "Done! Image built as: $IMAGE_NAME:$TAG"
echo ""
echo "To use this image on RunPod:"
echo "1. Push your changes to GitHub to trigger the workflow"
echo "2. The image will be available at: ghcr.io/YOUR_GITHUB_USERNAME/audiobook-whisper-runpod:latest"
echo "3. Go to https://www.runpod.io/console/serverless"
echo "4. Click 'New Endpoint'"
echo "5. Container Image: ghcr.io/YOUR_GITHUB_USERNAME/audiobook-whisper-runpod:latest"
echo "6. Select GPU: RTX 3060 or higher (12GB+ VRAM recommended for Large model)"
echo "7. Container Disk: 20 GB"
echo "8. Timeout: 600 seconds (for long audio files)"
echo "9. Active Workers: 0, Max Workers: 3"
echo "10. Idle Timeout: 60 seconds"
echo "11. Flash Boot: Enabled"
echo ""
echo "Note: Replace YOUR_GITHUB_USERNAME with your actual GitHub username"