import runpod
import torch
import os
import logging
import json

# Try to import vLLM, fall back to transformers if not available
try:
    from vllm import LLM, SamplingParams
    VLLM_AVAILABLE = True
    logger = logging.getLogger(__name__)
    logger.info("vLLM is available, using for inference")
except ImportError:
    VLLM_AVAILABLE = False
    from transformers import AutoModelForCausalLM, AutoTokenizer
    logger = logging.getLogger(__name__)
    logger.info("vLLM not available, using transformers instead")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global model instance
model = None

def load_model():
    """Load the Kimi-K2 model using vLLM or transformers"""
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
            if VLLM_AVAILABLE:
                # Use vLLM for efficient inference
                model = {
                    'llm': LLM(
                        model=model_name,
                        download_dir=model_path,
                        tensor_parallel_size=torch.cuda.device_count(),
                        dtype="auto",
                        trust_remote_code=True,
                        max_model_len=32768,
                        gpu_memory_utilization=0.95,
                    ),
                    'type': 'vllm'
                }
            else:
                # Fall back to transformers
                logger.info("Loading with transformers...")
                tokenizer = AutoTokenizer.from_pretrained(model_name, cache_dir=model_path, trust_remote_code=True)
                model_obj = AutoModelForCausalLM.from_pretrained(
                    model_name,
                    cache_dir=model_path,
                    torch_dtype=torch.float16,
                    device_map="auto",
                    trust_remote_code=True
                )
                model = {
                    'model': model_obj,
                    'tokenizer': tokenizer,
                    'type': 'transformers'
                }
            logger.info(f"Model loaded successfully using {model['type']}!")
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
        
        # Generate response based on backend
        logger.info(f"Generating response for prompt: {prompt[:100]}...")
        
        if llm['type'] == 'vllm':
            # vLLM generation
            sampling_params = SamplingParams(
                max_tokens=job_input.get("max_tokens", 2048),
                temperature=job_input.get("temperature", 0.7),
                top_p=job_input.get("top_p", 0.95),
                top_k=job_input.get("top_k", 50),
                stop=job_input.get("stop", None)
            )
            outputs = llm['llm'].generate([full_prompt], sampling_params)
            generated_text = outputs[0].outputs[0].text
        else:
            # Transformers generation
            tokenizer = llm['tokenizer']
            model = llm['model']
            
            inputs = tokenizer(full_prompt, return_tensors="pt").to(model.device)
            
            with torch.no_grad():
                outputs = model.generate(
                    **inputs,
                    max_new_tokens=job_input.get("max_tokens", 2048),
                    temperature=job_input.get("temperature", 0.7),
                    top_p=job_input.get("top_p", 0.95),
                    top_k=job_input.get("top_k", 50),
                    do_sample=True,
                    pad_token_id=tokenizer.eos_token_id
                )
            
            generated_text = tokenizer.decode(outputs[0][inputs['input_ids'].shape[1]:], skip_special_tokens=True)
        
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