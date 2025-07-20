#!/usr/bin/env python3
"""
RunPod Serverless Handler for ComfyUI with FLUX.1 Kontext Dev
"""

import runpod
import json
import os
import sys
import subprocess
import time
import base64
import requests
import logging
from typing import Dict, Any, Optional

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Add ComfyUI to path
sys.path.append('/workspace/ComfyUI')

# Global ComfyUI process
comfyui_process = None
COMFYUI_URL = "http://127.0.0.1:8188"

def download_model_if_needed(model_name: str, model_path: str, download_url: str) -> bool:
    """Download a model if it doesn't exist."""
    if os.path.exists(model_path):
        logger.info(f"Model {model_name} already exists at {model_path}")
        return True
    
    logger.info(f"Downloading {model_name} from {download_url}")
    try:
        # Create directory if needed
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        
        # Download with wget for better progress tracking
        cmd = f"wget -O {model_path} {download_url}"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        if result.returncode == 0:
            logger.info(f"Successfully downloaded {model_name}")
            return True
        else:
            logger.error(f"Failed to download {model_name}: {result.stderr}")
            return False
    except Exception as e:
        logger.error(f"Error downloading {model_name}: {str(e)}")
        return False

def ensure_models():
    """Ensure all required models are downloaded."""
    models_base = "/workspace/ComfyUI/models"
    
    # Define required models
    required_models = [
        {
            "name": "flux1-kontext-dev.safetensors",
            "path": f"{models_base}/unet/flux1-kontext-dev.safetensors",
            "url": "https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/flux1-kontext-dev.safetensors"
        },
        {
            "name": "t5xxl_fp8_e4m3fn.safetensors",
            "path": f"{models_base}/clip/t5xxl_fp8_e4m3fn.safetensors",
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors"
        },
        {
            "name": "clip_l.safetensors",
            "path": f"{models_base}/clip/clip_l.safetensors",
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors"
        },
        {
            "name": "ae.safetensors",
            "path": f"{models_base}/vae/ae.safetensors",
            "url": "https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors"
        }
    ]
    
    # Download models if needed
    for model in required_models:
        if not download_model_if_needed(model["name"], model["path"], model["url"]):
            logger.warning(f"Failed to download {model['name']}, continuing anyway...")

def start_comfyui():
    """Start ComfyUI server in the background"""
    global comfyui_process
    
    logger.info("Starting ComfyUI server...")
    
    # Kill any existing ComfyUI process
    subprocess.run("pkill -f 'python.*main.py'", shell=True)
    time.sleep(2)
    
    cmd = [
        "python",
        "/workspace/ComfyUI/main.py",
        "--listen", "127.0.0.1",
        "--port", "8188",
        "--preview-method", "none",
        "--disable-smart-memory"
    ]
    
    # Start ComfyUI in background
    comfyui_process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    # Wait for server to be ready
    for i in range(60):  # 60 second timeout
        try:
            response = requests.get(f"{COMFYUI_URL}/system_stats", timeout=2)
            if response.status_code == 200:
                logger.info("ComfyUI server is ready")
                return True
        except:
            pass
        time.sleep(1)
    
    logger.error("ComfyUI server failed to start")
    return False

def queue_prompt(prompt: Dict[str, Any]) -> Optional[str]:
    """Submit a prompt to ComfyUI and return the prompt ID"""
    try:
        response = requests.post(
            f"{COMFYUI_URL}/prompt",
            json={"prompt": prompt}
        )
        
        if response.status_code == 200:
            data = response.json()
            return data.get("prompt_id")
        else:
            logger.error(f"Failed to queue prompt: {response.text}")
            return None
    except Exception as e:
        logger.error(f"Error queuing prompt: {str(e)}")
        return None

def get_history(prompt_id: str) -> Optional[Dict[str, Any]]:
    """Get the history for a specific prompt"""
    try:
        response = requests.get(f"{COMFYUI_URL}/history/{prompt_id}")
        if response.status_code == 200:
            return response.json()
        return None
    except Exception as e:
        logger.error(f"Error getting history: {str(e)}")
        return None

def get_image(filename: str, subfolder: str = "", folder_type: str = "output") -> Optional[bytes]:
    """Get an image from ComfyUI"""
    try:
        response = requests.get(
            f"{COMFYUI_URL}/view",
            params={
                "filename": filename,
                "subfolder": subfolder,
                "type": folder_type
            }
        )
        if response.status_code == 200:
            return response.content
        return None
    except Exception as e:
        logger.error(f"Error getting image: {str(e)}")
        return None

def handler(job):
    """
    RunPod serverless handler function
    
    Args:
        job: Contains the input data for the job
    
    Returns:
        Dictionary containing the job results
    """
    try:
        job_input = job["input"]
        logger.info(f"Received job with input keys: {list(job_input.keys())}")
        
        # Parse workflow from input
        if "workflow" not in job_input:
            return {"error": "No workflow provided"}
        
        workflow = job_input["workflow"]
        if isinstance(workflow, str):
            workflow = json.loads(workflow)
        
        logger.info(f"Workflow has {len(workflow)} nodes")
        
        # Queue the prompt
        prompt_id = queue_prompt(workflow)
        if not prompt_id:
            return {"error": "Failed to queue prompt"}
        
        logger.info(f"Queued prompt with ID: {prompt_id}")
        
        # Poll for completion
        max_attempts = 180  # 15 minutes
        for attempt in range(max_attempts):
            history = get_history(prompt_id)
            
            if history and prompt_id in history:
                logger.info(f"Prompt completed after {attempt * 5} seconds")
                outputs = history[prompt_id].get("outputs", {})
                
                # Look for saved images
                images = []
                for node_id, node_output in outputs.items():
                    if "images" in node_output:
                        for image_info in node_output["images"]:
                            # Get image data
                            image_data = get_image(
                                image_info["filename"],
                                image_info.get("subfolder", ""),
                                image_info.get("type", "output")
                            )
                            
                            if image_data:
                                # Convert to base64
                                image_base64 = base64.b64encode(image_data).decode('utf-8')
                                images.append({
                                    "type": "base64",
                                    "data": image_base64,
                                    "filename": image_info["filename"]
                                })
                
                if images:
                    # Return in the format expected by the AudioBookVisualizer
                    return {
                        "images": images,
                        "prompt_id": prompt_id
                    }
                else:
                    return {"error": "No images generated"}
            
            # Check for errors in queue
            try:
                queue_response = requests.get(f"{COMFYUI_URL}/queue")
                if queue_response.status_code == 200:
                    queue_data = queue_response.json()
                    # Check if our prompt failed
                    for item in queue_data.get("queue_running", []):
                        if item[1] == prompt_id:
                            logger.info(f"Prompt still running... ({attempt * 5}s)")
                            break
            except:
                pass
            
            time.sleep(5)  # Wait 5 seconds before next check
        
        return {"error": "Generation timeout after 15 minutes"}
        
    except Exception as e:
        logger.error(f"Handler error: {str(e)}", exc_info=True)
        return {"error": str(e)}

# Initialize on container start
logger.info("Initializing ComfyUI for RunPod...")

# Ensure models are downloaded
logger.info("Checking for required models...")
ensure_models()

# Start ComfyUI
if not start_comfyui():
    logger.error("Failed to start ComfyUI, but continuing anyway...")

# RunPod serverless handler
logger.info("Starting RunPod handler...")
runpod.serverless.start({"handler": handler})