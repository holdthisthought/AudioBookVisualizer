# AudioBook Visualizer RunPod Docker Image

This directory contains the Docker configuration for the AudioBook Visualizer RunPod serverless endpoint.

## Pre-built Image

Users should use the pre-built image:
```
chester00000/audiobook-visualizer-flux:latest
```

This image is automatically built and maintained via GitHub Actions.

## For Developers

If you need to build the image locally for development:

```bash
# Build
docker build -t audiobook-visualizer-flux:dev .

# Test locally
docker run -p 8000:8000 audiobook-visualizer-flux:dev

# Push (requires permissions)
docker push chestnutmediagroup/audiobook-visualizer-flux:dev
```

## Image Contents

- ComfyUI with FLUX.1 Kontext Dev support
- Required custom nodes (Flux-Kontext)
- Automatic model downloading
- RunPod serverless handler
- Optimized for RTX 3090 GPUs

## Required Environment Variables

When deploying on RunPod, set the following environment variable:
- `HF_TOKEN` - Your Hugging Face access token (required for VAE model download)

Get your token from: https://huggingface.co/settings/tokens

## Versioning

- `latest` - Stable release (recommended)
- `dev` - Development builds
- `vX.Y.Z` - Specific versions

## Updates

The image is automatically rebuilt when:
- Changes are made to files in this directory
- New releases are tagged
- Manual trigger via GitHub Actions

Last update: Initial setup