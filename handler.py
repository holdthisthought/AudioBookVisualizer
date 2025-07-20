#!/usr/bin/env python3
"""
RunPod Serverless Handler for ComfyUI
"""

import json
import os
import sys
import subprocess
import time
import base64
import requests
from typing import Dict, Any

# Add ComfyUI to path
sys.path.append('/workspace/ComfyUI')

# Start ComfyUI server
def start_comfyui():
    """Start ComfyUI server in the background"""
    cmd = [
        "python3",
        "/workspace/ComfyUI/main.py",
        "--listen",
        "0.0.0.0",
        "--port", "8188"
    ]
    
    # Start ComfyUI in background
    process = subprocess.Popen(cmd)
    
    # Wait for server to be ready
    for i in range(30):  # 30 second timeout
        try:
            response = requests.get("http://localhost:8188/system_stats")
            if response.status_code == 200:
                print("ComfyUI server is ready")
                return process
        except:
            pass
        time.sleep(1)
    
    raise Exception("ComfyUI server failed to start")

# Initialize ComfyUI on container start
comfyui_process = start_comfyui()

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
        
        # Parse workflow from input
        if "workflow" in job_input:
            workflow = json.loads(job_input["workflow"]) if isinstance(job_input["workflow"], str) else job_input["workflow"]
        else:
            return {"error": "No workflow provided"}
        
        # Submit workflow to ComfyUI
        prompt_response = requests.post(
            "http://localhost:8188/prompt",
            json={"prompt": workflow}
        )
        
        if prompt_response.status_code != 200:
            return {"error": f"Failed to submit prompt: {prompt_response.text}"}
        
        prompt_data = prompt_response.json()
        prompt_id = prompt_data["prompt_id"]
        
        # Poll for completion
        max_attempts = 120  # 10 minutes
        for attempt in range(max_attempts):
            history_response = requests.get(f"http://localhost:8188/history/{prompt_id}")
            
            if history_response.status_code == 200:
                history = history_response.json()
                
                if prompt_id in history:
                    outputs = history[prompt_id]["outputs"]
                    
                    # Look for saved images
                    for node_id, node_output in outputs.items():
                        if "images" in node_output:
                            images = []
                            for image_info in node_output["images"]:
                                # Get image data
                                image_response = requests.get(
                                    f"http://localhost:8188/view",
                                    params={
                                        "filename": image_info["filename"],
                                        "subfolder": image_info.get("subfolder", ""),
                                        "type": image_info.get("type", "output")
                                    }
                                )
                                
                                if image_response.status_code == 200:
                                    # Convert to base64
                                    image_base64 = base64.b64encode(image_response.content).decode('utf-8')
                                    images.append(image_base64)
                            
                            if images:
                                return {
                                    "images": images,
                                    "prompt_id": prompt_id
                                }
            
            time.sleep(5)  # Wait 5 seconds before next check
        
        return {"error": "Generation timeout"}
        
    except Exception as e:
        return {"error": str(e)}

# RunPod serverless handler
def run(job):
    return handler(job)