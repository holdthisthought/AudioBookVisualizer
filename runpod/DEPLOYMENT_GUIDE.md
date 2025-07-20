# RunPod FLUX.1 Kontext Dev Deployment Guide

This guide will walk you through deploying a serverless ComfyUI worker on RunPod that supports FLUX.1 Kontext Dev for your AudioBook Visualizer application.

## Prerequisites

1. RunPod account with credits
2. AudioBook Visualizer application installed

## Step 1: Use Pre-built Docker Image

We provide a pre-built Docker image that includes everything you need:

**Image**: `chester00000/audiobook-visualizer-flux:latest`

This image includes:
- ComfyUI with FLUX.1 Kontext Dev support
- All required models (downloaded on first run)
- Optimized settings for RunPod
- Regular updates and maintenance

No Docker installation or building required!

## Step 2: Create RunPod Serverless Endpoint

1. Log in to [RunPod Console](https://www.runpod.io/console)

2. Navigate to **Serverless** → **Custom Workers**

3. Click **New Endpoint**

4. Configure the endpoint:
   - **Endpoint Name**: `audiobook-flux-kontext`
   - **Select Worker Image**: 
     - Container Image: `yourdockerhub/comfyui-flux-kontext:latest`
     - Container Registry Credentials: (if private registry)
   
   - **GPU Configuration**:
     - GPU Type: **NVIDIA RTX 3090** (24GB VRAM, good balance of cost/performance)
     - Alternative: **NVIDIA A4000** (16GB VRAM, cheaper but may need FP8 models)
   
   - **Worker Configuration**:
     - Max Workers: 3
     - Idle Timeout: 60 seconds
     - Flash Boot: **Enabled** (faster cold starts)
     - Active Workers: 0 (scales to zero when idle)
   
   - **Environment Variables** (optional but recommended):
     ```
     COMFYUI_PREVIEW_METHOD=none
     PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
     HF_TOKEN=your_huggingface_token_here
     ```
     
     **Note**: The HF_TOKEN is required to download the VAE model from Hugging Face. Get your token from https://huggingface.co/settings/tokens

5. Click **Create**

6. Copy the **Endpoint ID** (you'll need this for the app)

## Step 3: Configure Network Volume (REQUIRED)

To store models persistently and avoid disk space issues:

1. Go to RunPod **Storage** → **Network Volumes**

2. Create a new Network Volume:
   - Region: Same as your endpoint
   - Size: 50GB (minimum)
   - Name: `flux-models`

3. In your endpoint settings:
   - Click **Edit**
   - Under **Volume**, select your network volume
   - Mount Path: `/runpod-volume`
   - Click **Update**

4. The handler will automatically:
   - Detect the Network Volume
   - Store models in `/runpod-volume/models`
   - Create symlinks for ComfyUI compatibility

5. Benefits:
   - Models persist between container restarts
   - No "disk full" errors
   - Faster cold starts after first download

## Step 4: Test the Endpoint

Use the test script to verify your deployment:

```bash
cd /path/to/AudioBookVisualizer/runpod
python test_endpoint.py --endpoint-id YOUR_ENDPOINT_ID --api-key YOUR_API_KEY
```

## Step 5: Configure AudioBook Visualizer

1. Open AudioBook Visualizer
2. Go to Settings (⚙️)
3. Select "RunPod Cloud GPU"
4. Enter:
   - API Key: Your RunPod API key
   - Endpoint ID: The endpoint ID from Step 2
5. Click "Test Connection"
6. Save settings

## Cost Optimization

### GPU Selection Guide

| GPU | VRAM | Cost/hr | Best For |
|-----|------|---------|----------|
| RTX 3090 | 24GB | ~$0.44 | Full quality, all features |
| RTX 4090 | 24GB | ~$0.84 | Fastest generation |
| A4000 | 16GB | ~$0.34 | Budget option (FP8 only) |
| A5000 | 24GB | ~$0.52 | Professional workloads |

### Cost Saving Tips

1. **Use FP8 Models**: Reduces VRAM usage and allows cheaper GPUs
2. **Set Idle Timeout**: 60 seconds recommended
3. **Scale to Zero**: Enable "Active Workers: 0"
4. **Use Flash Boot**: Reduces cold start time
5. **Monitor Usage**: Check RunPod dashboard regularly

## Troubleshooting

### "Endpoint not found"
- Verify the endpoint ID is correct
- Check that the endpoint is in "Ready" state
- Ensure your API key has access to the endpoint

### "Out of Memory" errors
- Switch to FP8 models in app settings
- Use a GPU with more VRAM
- Reduce image resolution

### Slow cold starts
- Enable Flash Boot
- Use a persistent volume for models
- Keep at least 1 active worker during busy hours

### Generation timeouts
- Increase the timeout in handler.py
- Check RunPod logs for errors
- Verify all models are downloaded

## Model Management

The Docker image will automatically download required models on first run:

- **FLUX.1 Kontext Dev**: Main model (~24GB)
- **T5-XXL FP8**: Text encoder (~5GB)
- **CLIP-L**: Text encoder (~250MB)
- **VAE**: Image decoder (~335MB)

Total: ~30GB (ensure your volume is at least 50GB)

## Advanced Configuration

### Custom Models

To add custom models, modify the `download_models.py` script:

```python
models.append({
    "name": "Your Model",
    "url": "https://huggingface.co/...",
    "path": f"{models_base}/checkpoints/your_model.safetensors"
})
```

### Environment Variables

You can set these in RunPod endpoint configuration:

- `COMFYUI_TEMP_DIR`: Custom temp directory
- `COMFYUI_MAX_UPLOAD_SIZE`: Max upload size (default 100MB)
- `PYTORCH_CUDA_ALLOC_CONF`: CUDA memory settings

### Monitoring

View logs in RunPod console:
1. Go to your endpoint
2. Click on a worker
3. View "Logs" tab

## Security Notes

- API keys are encrypted locally in the app
- All communication uses HTTPS
- Models are downloaded from official sources
- No data is stored on RunPod servers

## Support

For issues:
1. Check RunPod logs first
2. Verify models are downloaded
3. Test with the provided test script
4. Check the AudioBook Visualizer logs

Need help? 
- RunPod Discord: https://discord.gg/runpod
- RunPod Docs: https://docs.runpod.io