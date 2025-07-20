#!/usr/bin/env python3
"""
Download required models for FLUX.1 Kontext Dev
"""

import os
import subprocess
import sys

def download_file(url, destination):
    """Download a file using wget with progress bar"""
    print(f"Downloading {os.path.basename(destination)}...")
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    
    cmd = ["wget", "-O", destination, "--progress=bar:force", url]
    result = subprocess.run(cmd)
    
    if result.returncode != 0:
        print(f"Failed to download {url}")
        return False
    return True

def main():
    models_base = "/workspace/ComfyUI/models"
    
    # Create directories
    os.makedirs(f"{models_base}/unet", exist_ok=True)
    os.makedirs(f"{models_base}/clip", exist_ok=True)
    os.makedirs(f"{models_base}/vae", exist_ok=True)
    
    # Models to download
    models = [
        {
            "name": "FLUX.1 Kontext Dev",
            "url": "https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/flux1-kontext-dev.safetensors",
            "path": f"{models_base}/unet/flux1-kontext-dev.safetensors"
        },
        {
            "name": "T5-XXL FP8",
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors",
            "path": f"{models_base}/clip/t5xxl_fp8_e4m3fn.safetensors"
        },
        {
            "name": "CLIP-L",
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
            "path": f"{models_base}/clip/clip_l.safetensors"
        },
        {
            "name": "VAE",
            "url": "https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors",
            "path": f"{models_base}/vae/ae.safetensors"
        }
    ]
    
    print("Downloading required models for FLUX.1 Kontext Dev...")
    print("-" * 50)
    
    for model in models:
        if os.path.exists(model["path"]):
            print(f"✓ {model['name']} already exists")
            continue
        
        print(f"\nDownloading {model['name']}...")
        if download_file(model["url"], model["path"]):
            print(f"✓ {model['name']} downloaded successfully")
        else:
            print(f"✗ Failed to download {model['name']}")
            sys.exit(1)
    
    print("\n" + "-" * 50)
    print("All models downloaded successfully!")

if __name__ == "__main__":
    main()