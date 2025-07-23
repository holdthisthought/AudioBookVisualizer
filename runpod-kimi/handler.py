import runpod
import torch
from vllm import LLM, SamplingParams
import os
import logging
import json

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global model instance
model = None

def load_model():
    """Load the Kimi-K2 model using vLLM for efficient inference"""
    global model
    if model is None:
        model_name = os.environ.get("MODEL_NAME", "moonshotai/Kimi-K2-Instruct")
        model_path = os.environ.get("MODEL_PATH", "/workspace/models")
        
        logger.info(f"Loading model: {model_name}")
        
        # Check if we need to download the model first
        if os.environ.get("DOWNLOAD_MODEL_ON_START", "true").lower() == "true":
            logger.info("Downloading model if not cached...")
            from huggingface_hub import snapshot_download
            try:
                snapshot_download(model_name, cache_dir=model_path)
                logger.info("Model download complete")
            except Exception as e:
                logger.warning(f"Model download failed (may already exist): {e}")
        
        try:
            # Initialize vLLM with appropriate settings for Kimi-K2
            model = LLM(
                model=model_name,
                download_dir=model_path,
                tensor_parallel_size=torch.cuda.device_count(),  # Use all available GPUs
                dtype="auto",  # Let vLLM choose the best dtype
                trust_remote_code=True,  # Required for custom model architectures
                max_model_len=32768,  # Kimi supports long context
                gpu_memory_utilization=0.95,  # Use most of available VRAM
            )
            logger.info("Model loaded successfully!")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise
    return model

def handler(event):
    """
    RunPod serverless handler function
    
    Expected input format:
    {
        "input": {
            "prompt": "The text prompt for the model",
            "system_prompt": "Optional system prompt",
            "max_tokens": 2048,
            "temperature": 0.7,
            "top_p": 0.95,
            "top_k": 50,
            "stream": false
        }
    }
    """
    try:
        # Get the model
        llm = load_model()
        
        # Extract parameters from the event
        job_input = event.get("input", {})
        prompt = job_input.get("prompt", "")
        system_prompt = job_input.get("system_prompt", "")
        
        # Combine system prompt and user prompt if needed
        if system_prompt:
            full_prompt = f"{system_prompt}\n\nUser: {prompt}\n\nAssistant:"
        else:
            full_prompt = prompt
        
        # Sampling parameters
        sampling_params = SamplingParams(
            max_tokens=job_input.get("max_tokens", 2048),
            temperature=job_input.get("temperature", 0.7),
            top_p=job_input.get("top_p", 0.95),
            top_k=job_input.get("top_k", 50),
            stop=job_input.get("stop", None)
        )
        
        # Generate response
        logger.info(f"Generating response for prompt: {prompt[:100]}...")
        outputs = llm.generate([full_prompt], sampling_params)
        
        # Extract the generated text
        generated_text = outputs[0].outputs[0].text
        
        # Return the result
        result = {
            "text": generated_text,
            "model": os.environ.get("MODEL_NAME", "moonshotai/Kimi-K2-Instruct"),
            "usage": {
                "prompt_tokens": len(full_prompt.split()),  # Rough estimate
                "completion_tokens": len(generated_text.split()),  # Rough estimate
            }
        }
        
        logger.info("Generation completed successfully")
        return result
        
    except Exception as e:
        logger.error(f"Error in handler: {e}")
        return {"error": str(e)}

# RunPod serverless entrypoint
runpod.serverless.start({"handler": handler})