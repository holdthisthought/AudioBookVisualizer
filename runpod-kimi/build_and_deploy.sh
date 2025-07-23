#!/bin/bash

# Kimi-K2 RunPod Docker Image Build and Deploy Script

# Configuration
DOCKER_USERNAME="chester00000"
IMAGE_NAME="audiobook-visualizer-kimi"
TAG="latest"
FULL_IMAGE_NAME="${DOCKER_USERNAME}/${IMAGE_NAME}:${TAG}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Building Kimi-K2 RunPod Docker image...${NC}"

# Build the Docker image
echo -e "${YELLOW}Building image: ${FULL_IMAGE_NAME}${NC}"
docker build -t ${FULL_IMAGE_NAME} .

if [ $? -ne 0 ]; then
    echo -e "${RED}Docker build failed!${NC}"
    exit 1
fi

echo -e "${GREEN}Docker build successful!${NC}"

# Ask if user wants to push to Docker Hub
read -p "Do you want to push the image to Docker Hub? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Pushing to Docker Hub...${NC}"
    docker push ${FULL_IMAGE_NAME}
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}Docker push failed! Make sure you're logged in with: docker login${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}Successfully pushed to Docker Hub!${NC}"
    echo -e "${GREEN}Image available at: ${FULL_IMAGE_NAME}${NC}"
else
    echo -e "${YELLOW}Skipping Docker Hub push.${NC}"
fi

echo -e "\n${GREEN}Deployment Instructions:${NC}"
echo "1. Go to https://www.runpod.io/console/serverless"
echo "2. Click 'New Endpoint'"
echo "3. Select your configuration:"
echo "   - Container Image: ${FULL_IMAGE_NAME}"
echo "   - GPU Type: RTX A6000 or better (48GB+ VRAM recommended for Kimi-K2)"
echo "   - Container Disk: 100 GB"
echo "   - Max Workers: Based on your needs"
echo "4. Set environment variables if needed:"
echo "   - MODEL_NAME: MoonshotAI/Kimi-k1.5-4T (default)"
echo "5. Click 'Create Endpoint'"
echo "6. Copy the Endpoint ID and API Key for your application"