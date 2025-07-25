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
models_checked = False

def download_model_if_needed(model_name: str, model_path: str, download_url: str, hf_token: Optional[str] = None) -> bool:
    """Download a model if it doesn't exist."""
    if os.path.exists(model_path):
        logger.info(f"Model {model_name} already exists at {model_path}")
        return True
    
    logger.info(f"Downloading {model_name} from {download_url}")
    try:
        # Create directory if needed
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        
        # Check available space
        import shutil
        disk_usage = shutil.disk_usage(os.path.dirname(model_path))
        free_gb = disk_usage.free / (1024**3)
        logger.info(f"Free space before downloading {model_name}: {free_gb:.1f} GB")
        
        # Build wget command with optional auth header
        cmd = f"wget -O {model_path}"
        if hf_token:
            cmd += f" --header='Authorization: Bearer {hf_token}'"
        cmd += f" {download_url}"
        
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        if result.returncode == 0:
            logger.info(f"Successfully downloaded {model_name}")
            # Verify file size
            if os.path.exists(model_path):
                size_mb = os.path.getsize(model_path) / (1024 * 1024)
                logger.info(f"{model_name} size: {size_mb:.1f} MB")
            return True
        else:
            logger.error(f"Failed to download {model_name}: Exit code {result.returncode}")
            logger.error(f"STDOUT: {result.stdout}")
            logger.error(f"STDERR: {result.stderr}")
            # Clean up partial download
            if os.path.exists(model_path):
                os.remove(model_path)
            return False
    except Exception as e:
        logger.error(f"Error downloading {model_name}: {str(e)}")
        return False

def ensure_models(hf_token=None, weight_dtype="fp8"):
    """Ensure all required models are downloaded."""
    global models_checked
    
    # Check if Network Volume is mounted (RunPod mounts at /runpod-volume)
    if os.path.exists("/runpod-volume") and os.path.ismount("/runpod-volume"):
        models_base = "/runpod-volume/models"
        logger.info(f"Using Network Volume for models: {models_base}")
        
        # Ensure the models directory structure exists
        for subdir in ["", "unet", "clip", "vae", "checkpoints"]:
            os.makedirs(f"{models_base}/{subdir}", exist_ok=True)
    else:
        models_base = "/workspace/ComfyUI/models"
        logger.info(f"Using local storage for models: {models_base}")
        logger.warning("Network Volume not detected - may run out of disk space!")
    
    # Get Hugging Face token from environment if not provided
    if not hf_token:
        hf_token = os.environ.get('HF_TOKEN', os.environ.get('HUGGING_FACE_TOKEN', None))
    
    # Define required models including FLUX model based on precision
    required_models = [
        {
            "name": "clip_l.safetensors",
            "path": f"{models_base}/clip/clip_l.safetensors",
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
            "requires_auth": False
        },
        {
            "name": "ae.safetensors",
            "path": f"{models_base}/vae/ae.safetensors",
            "url": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev/resolve/main/ae.safetensors",
            "requires_auth": True
        }
    ]
    
    # Add the appropriate T5 model based on precision
    # 'default' weight_dtype means use native precision (FP16)
    if weight_dtype in ["fp16", "default"]:
        required_models.append({
            "name": "t5xxl_fp16.safetensors",
            "path": f"{models_base}/clip/t5xxl_fp16.safetensors",
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors",
            "requires_auth": False
        })
    else:
        required_models.append({
            "name": "t5xxl_fp8_e4m3fn.safetensors",
            "path": f"{models_base}/clip/t5xxl_fp8_e4m3fn.safetensors",
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors",
            "requires_auth": False
        })
    
    # Add the appropriate FLUX model based on requested precision
    if weight_dtype == "fp16":
        required_models.append({
            "name": "flux1-kontext-dev-fp16.safetensors",
            "path": f"{models_base}/unet/flux1-kontext-dev-fp16.safetensors",
            "url": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev/resolve/main/flux1-kontext-dev.safetensors",
            "requires_auth": True
        })
    else:
        # Default to FP8
        required_models.append({
            "name": "flux1-kontext-dev-fp8.safetensors",
            "path": f"{models_base}/unet/flux1-kontext-dev-fp8.safetensors",
            "url": "https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors",
            "requires_auth": False
        })
    
    # Download models if needed
    all_success = True
    for model in required_models:
        token_to_use = hf_token if model.get('requires_auth', False) else None
        if not download_model_if_needed(model["name"], model["path"], model["url"], token_to_use):
            logger.warning(f"Failed to download {model['name']}")
            all_success = False
    
    # Mark as checked only if all models downloaded successfully
    if all_success:
        models_checked = True
        logger.info("All models downloaded successfully")
    else:
        logger.warning("Some models failed to download")

def start_comfyui():
    """Start ComfyUI server in the background"""
    global comfyui_process
    
    logger.info("Starting ComfyUI server...")
    
    # If Network Volume is available, symlink models
    if os.path.exists("/runpod-volume"):
        logger.info("Setting up Network Volume symlinks...")
        
        # Create models directory structure in Network Volume if needed
        volume_models = "/runpod-volume/models"
        for subdir in ["unet", "clip", "vae", "checkpoints"]:
            os.makedirs(f"{volume_models}/{subdir}", exist_ok=True)
        
        # Remove existing models directory and create symlink
        comfyui_models = "/workspace/ComfyUI/models"
        if os.path.exists(comfyui_models) and not os.path.islink(comfyui_models):
            subprocess.run(f"rm -rf {comfyui_models}", shell=True)
        
        if not os.path.exists(comfyui_models):
            os.symlink(volume_models, comfyui_models)
            logger.info(f"Created symlink: {comfyui_models} -> {volume_models}")
    
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

def upload_image(image_data: str, filename: str) -> Optional[str]:
    """Upload a base64 image to ComfyUI"""
    try:
        # Remove data:image/png;base64, prefix if present
        if image_data.startswith('data:'):
            image_data = image_data.split(',')[1]
        
        # Decode base64 to bytes
        image_bytes = base64.b64decode(image_data)
        
        # Create multipart form data
        files = {
            'image': (filename, image_bytes, 'image/png'),
            'type': (None, 'input'),
            'overwrite': (None, 'true')
        }
        
        response = requests.post(
            f"{COMFYUI_URL}/upload/image",
            files=files
        )
        
        if response.status_code == 200:
            result = response.json()
            uploaded_name = result.get('name', filename)
            logger.info(f"Successfully uploaded image: {uploaded_name}")
            return uploaded_name
        else:
            logger.error(f"Failed to upload image: Status {response.status_code}, Response: {response.text}")
            return None
    except Exception as e:
        logger.error(f"Error uploading image: {str(e)}")
        return None

def process_workflow_images(workflow: Dict[str, Any]) -> Dict[str, Any]:
    """Process LoadImage nodes in workflow and upload base64 images"""
    processed_workflow = workflow.copy()
    
    for node_id, node_data in processed_workflow.items():
        if node_data.get('class_type') == 'LoadImage':
            inputs = node_data.get('inputs', {})
            if 'image' in inputs and inputs.get('upload') == 'image':
                # This is a base64 image that needs to be uploaded
                image_data = inputs['image']
                if image_data and isinstance(image_data, str) and len(image_data) > 100:
                    # Generate a unique filename
                    filename = f"input_{node_id}_{int(time.time())}.png"
                    uploaded_name = upload_image(image_data, filename)
                    
                    if uploaded_name:
                        # Update the workflow to use the uploaded filename
                        processed_workflow[node_id]['inputs']['image'] = uploaded_name
                        # Remove the upload field as it's no longer needed
                        if 'upload' in processed_workflow[node_id]['inputs']:
                            del processed_workflow[node_id]['inputs']['upload']
                    else:
                        logger.error(f"Failed to upload image for node {node_id}")
    
    return processed_workflow

def queue_prompt(prompt: Dict[str, Any]) -> Optional[str]:
    """Submit a prompt to ComfyUI and return the prompt ID"""
    try:
        response = requests.post(
            f"{COMFYUI_URL}/prompt",
            json={"prompt": prompt}
        )
        
        if response.status_code == 200:
            data = response.json()
            prompt_id = data.get("prompt_id")
            if prompt_id:
                logger.info(f"Successfully queued prompt: {prompt_id}")
            return prompt_id
        else:
            logger.error(f"Failed to queue prompt: Status {response.status_code}, Response: {response.text}")
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
        
        # Extract HF token if provided
        hf_token = job_input.get('hf_token', None)
        
        # Parse workflow first to determine which models we need
        if "workflow" not in job_input:
            return {"error": "No workflow provided"}
        
        workflow = job_input["workflow"]
        if isinstance(workflow, str):
            workflow = json.loads(workflow)
        
        # Check workflow to determine which FLUX model precision is needed
        weight_dtype = "fp16"  # default
        for node in workflow.values():
            if node.get("class_type") == "UNETLoader":
                weight_dtype = node.get("inputs", {}).get("weight_dtype", "fp16")
                logger.info(f"Workflow requests {weight_dtype} precision")
                break
        
        # Map precision to model filenames
        # 'default' weight_dtype means use the model's native precision (FP16 for the FP16 model)
        is_fp16 = weight_dtype in ["fp16", "default"]
        flux_model_name = "flux1-kontext-dev-fp16.safetensors" if is_fp16 else "flux1-kontext-dev-fp8.safetensors"
        t5_model_name = "t5xxl_fp16.safetensors" if is_fp16 else "t5xxl_fp8_e4m3fn.safetensors"
        
        # Check if any critical models are missing
        # Use Network Volume if available
        if os.path.exists("/runpod-volume"):
            models_base = "/runpod-volume/models"
        else:
            models_base = "/workspace/ComfyUI/models"
        critical_models = [
            f"{models_base}/unet/{flux_model_name}",
            f"{models_base}/clip/{t5_model_name}",
            f"{models_base}/clip/clip_l.safetensors",
            f"{models_base}/vae/ae.safetensors"
        ]
        
        missing_models = [m for m in critical_models if not os.path.exists(m)]
        
        if missing_models:
            logger.info(f"Missing {len(missing_models)} critical models: {[os.path.basename(m) for m in missing_models]}")
            
            if hf_token:
                logger.info("Using HF token from job input")
                # Set it in environment
                os.environ['HF_TOKEN'] = hf_token
            
            logger.info(f"Downloading missing models for {weight_dtype} precision...")
            ensure_models(hf_token, weight_dtype)
            
            # Log model sizes after download attempt
            for model_path in critical_models:
                if os.path.exists(model_path):
                    size_mb = os.path.getsize(model_path) / (1024 * 1024)
                    logger.info(f"{os.path.basename(model_path)}: {size_mb:.1f} MB")
                else:
                    logger.info(f"{os.path.basename(model_path)}: NOT FOUND")
            
            # Wait a moment for filesystem to sync
            time.sleep(2)
            
            # Verify all models were downloaded and check sizes
            still_missing = []
            for model_path in critical_models:
                if not os.path.exists(model_path):
                    still_missing.append(model_path)
                else:
                    size_mb = os.path.getsize(model_path) / (1024 * 1024)
                    model_name = os.path.basename(model_path)
                    
                    # Check for corrupted downloads (files that are too small)
                    if model_name.startswith("flux1-kontext-dev") and size_mb < 1000:  # Should be much larger
                        logger.error(f"FLUX model is corrupted! Only {size_mb:.1f} MB")
                        # Delete the corrupted file so it can be re-downloaded
                        os.remove(model_path)
                        still_missing.append(model_path)
            
            if still_missing:
                logger.info(f"Need to download: {[os.path.basename(m) for m in still_missing]}")
                # Re-run ensure_models to download missing/corrupted files
                ensure_models(hf_token, weight_dtype)
                
                # Check again
                final_missing = [m for m in still_missing if not os.path.exists(m)]
                if final_missing:
                    return {"error": f"Failed to download models: {[os.path.basename(m) for m in final_missing]}"}
        
        # Parse workflow from input
        if "workflow" not in job_input:
            return {"error": "No workflow provided"}
        
        workflow = job_input["workflow"]
        if isinstance(workflow, str):
            workflow = json.loads(workflow)
        
        logger.info(f"Workflow has {len(workflow)} nodes")
        
        # Log workflow structure for debugging
        logger.info("Workflow nodes:")
        for node_id, node_data in workflow.items():
            logger.info(f"  Node {node_id}: {node_data.get('class_type', 'Unknown')}")
        
        # Process any base64 images in LoadImage nodes
        logger.info("Processing workflow images...")
        workflow = process_workflow_images(workflow)
        
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
                prompt_data = history[prompt_id]
                
                # Check if there was an error
                if "status" in prompt_data:
                    status = prompt_data.get("status")
                    if status and "status_str" in status:
                        logger.info(f"Prompt status: {status['status_str']}")
                        if status['status_str'] == "error":
                            error_msg = status.get("messages", ["Unknown error"])
                            logger.error(f"Workflow error: {error_msg}")
                            return {"error": f"Workflow failed: {error_msg}"}
                
                outputs = prompt_data.get("outputs", {})
                
                # Debug: log the entire history structure
                logger.info(f"Prompt data keys: {list(prompt_data.keys())}")
                logger.info(f"Output nodes: {list(outputs.keys())}")
                
                # If no outputs, check for execution info
                if not outputs:
                    logger.warning("No outputs found, checking execution data...")
                    if "execution" in prompt_data:
                        logger.info(f"Execution data: {prompt_data['execution']}")
                    
                    # Try to get the raw history
                    try:
                        raw_response = requests.get(f"{COMFYUI_URL}/history")
                        if raw_response.status_code == 200:
                            all_history = raw_response.json()
                            if prompt_id in all_history:
                                logger.info(f"Raw history data: {json.dumps(all_history[prompt_id], indent=2)}")
                    except Exception as e:
                        logger.error(f"Could not get raw history: {e}")
                
                for node_id, node_output in outputs.items():
                    logger.info(f"Node {node_id} output keys: {list(node_output.keys())}")
                
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

# Log ComfyUI version
try:
    with open('/workspace/comfyui_version.txt', 'r') as f:
        logger.info(f"ComfyUI version: {f.read().strip()}")
except:
    logger.info("ComfyUI version file not found")

# Check disk space
try:
    import shutil
    disk_usage = shutil.disk_usage("/workspace")
    free_gb = disk_usage.free / (1024**3)
    total_gb = disk_usage.total / (1024**3)
    logger.info(f"Disk space: {free_gb:.1f}GB free of {total_gb:.1f}GB total")
    
    # Check for Network Volume
    if os.path.exists("/runpod-volume"):
        vol_usage = shutil.disk_usage("/runpod-volume")
        vol_free_gb = vol_usage.free / (1024**3)
        vol_total_gb = vol_usage.total / (1024**3)
        logger.info(f"Network Volume: {vol_free_gb:.1f}GB free of {vol_total_gb:.1f}GB total")
except Exception as e:
    logger.warning(f"Could not check disk space: {e}")

# Try to download models on startup if HF token is in environment
logger.info("Checking for required models...")
hf_token_env = os.environ.get('HF_TOKEN', os.environ.get('HUGGING_FACE_TOKEN', None))
if hf_token_env:
    logger.info("Found HF token in environment, downloading models...")
    ensure_models(hf_token_env)
else:
    logger.info("No HF token in environment, will download on first job")

# Start ComfyUI
if not start_comfyui():
    logger.error("Failed to start ComfyUI, but continuing anyway...")

# Log available node types
try:
    response = requests.get(f"{COMFYUI_URL}/object_info")
    if response.status_code == 200:
        node_types = list(response.json().keys())
        flux_nodes = [n for n in node_types if 'flux' in n.lower() or 'FLUX' in n]
        logger.info(f"Available FLUX-related nodes: {flux_nodes}")
        # Check for specific nodes we need
        reference_nodes = [n for n in node_types if 'reference' in n.lower() or 'Reference' in n]
        logger.info(f"Available Reference nodes: {reference_nodes}")
        logger.info(f"ReferenceLatent available: {'ReferenceLatent' in node_types}")
        logger.info(f"Total nodes available: {len(node_types)}")
except Exception as e:
    logger.warning(f"Could not get node info: {e}")

# RunPod serverless handler
logger.info("Starting RunPod handler...")
runpod.serverless.start({"handler": handler})