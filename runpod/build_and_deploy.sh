#!/bin/bash
# Build and deploy script for RunPod ComfyUI FLUX Kontext

set -e

# Configuration
DOCKER_USERNAME="${DOCKER_USERNAME:-your-docker-username}"
IMAGE_NAME="comfyui-flux-kontext"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_IMAGE="${DOCKER_USERNAME}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "RunPod ComfyUI FLUX Kontext Deployment Script"
echo "============================================="
echo ""

# Check if Docker username is set
if [ "$DOCKER_USERNAME" == "your-docker-username" ]; then
    echo "Error: Please set DOCKER_USERNAME environment variable or edit this script"
    echo "Example: export DOCKER_USERNAME=myusername"
    exit 1
fi

echo "Building Docker image: ${FULL_IMAGE}"
echo ""

# Build the image
docker build -t ${FULL_IMAGE} .

echo ""
echo "Build complete! Pushing to Docker Hub..."
echo ""

# Login to Docker Hub if not already logged in
docker login

# Push the image
docker push ${FULL_IMAGE}

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Go to https://www.runpod.io/console/serverless"
echo "2. Create a new endpoint with this image: ${FULL_IMAGE}"
echo "3. Configure your AudioBook Visualizer with the endpoint ID"
echo ""
echo "For detailed instructions, see DEPLOYMENT_GUIDE.md"