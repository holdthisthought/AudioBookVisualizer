#!/usr/bin/env python3
"""
Whisper RunPod Serverless Handler
Supports all Whisper models and returns transcription with timestamps
"""

import runpod
import os
import time
import base64
import tempfile
import json
import requests
from typing import Dict, Any, List, Optional
from faster_whisper import WhisperModel
import numpy as np

# Model cache to avoid reloading
MODEL_CACHE = {}

# Model download URLs - Using Hugging Face direct download links
MODEL_URLS = {
    "tiny": "https://huggingface.co/Systran/faster-whisper-tiny/resolve/main/model.bin",
    "tiny.en": "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/model.bin",
    "base": "https://huggingface.co/Systran/faster-whisper-base/resolve/main/model.bin",
    "base.en": "https://huggingface.co/Systran/faster-whisper-base.en/resolve/main/model.bin",
    "small": "https://huggingface.co/Systran/faster-whisper-small/resolve/main/model.bin",
    "small.en": "https://huggingface.co/Systran/faster-whisper-small.en/resolve/main/model.bin",
    "medium": "https://huggingface.co/Systran/faster-whisper-medium/resolve/main/model.bin",
    "medium.en": "https://huggingface.co/Systran/faster-whisper-medium.en/resolve/main/model.bin",
    "large-v1": "https://huggingface.co/Systran/faster-whisper-large-v1/resolve/main/model.bin",
    "large-v2": "https://huggingface.co/Systran/faster-whisper-large-v2/resolve/main/model.bin",
    "large-v3": "https://huggingface.co/Systran/faster-whisper-large-v3/resolve/main/model.bin",
    "large": "https://huggingface.co/Systran/faster-whisper-large-v3/resolve/main/model.bin"  # Alias for v3
}

# Config files needed for each model
CONFIG_FILES = [
    "config.json",
    "tokenizer.json",
    "vocabulary.txt",
    "preprocessor_config.json"
]

def download_model_files(model_size: str) -> str:
    """Download model files if not already present"""
    models_dir = os.environ.get('WHISPER_MODELS_DIR', '/models/whisper')
    model_dir = os.path.join(models_dir, model_size)
    
    # Check if model already exists
    model_bin_path = os.path.join(model_dir, "model.bin")
    if os.path.exists(model_bin_path):
        print(f"Model {model_size} already downloaded")
        return model_dir
    
    # Create model directory
    os.makedirs(model_dir, exist_ok=True)
    
    # Get base URL for the model
    model_name_map = {
        "tiny": "tiny",
        "base": "base",
        "small": "small",
        "medium": "medium",
        "large": "large-v3",
        "large-v3": "large-v3"
    }
    
    mapped_name = model_name_map.get(model_size, model_size)
    base_url = f"https://huggingface.co/Systran/faster-whisper-{mapped_name}/resolve/main"
    
    # Download model.bin
    print(f"Downloading {model_size} model from {base_url}...")
    model_url = f"{base_url}/model.bin"
    
    try:
        response = requests.get(model_url, stream=True)
        response.raise_for_status()
        
        total_size = int(response.headers.get('content-length', 0))
        downloaded = 0
        
        with open(model_bin_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        progress = (downloaded / total_size) * 100
                        print(f"Downloading model.bin: {progress:.1f}%", end='\r')
        
        print(f"\nModel binary downloaded successfully")
        
        # Download config files
        for config_file in CONFIG_FILES:
            config_url = f"{base_url}/{config_file}"
            config_path = os.path.join(model_dir, config_file)
            
            try:
                print(f"Downloading {config_file}...")
                response = requests.get(config_url)
                response.raise_for_status()
                
                with open(config_path, 'w') as f:
                    f.write(response.text)
                    
            except requests.exceptions.HTTPError as e:
                # Some config files might not exist for all models
                print(f"Warning: Could not download {config_file}: {e}")
        
        print(f"Model {model_size} downloaded successfully")
        return model_dir
        
    except Exception as e:
        print(f"Error downloading model: {e}")
        # Clean up partial download
        if os.path.exists(model_bin_path):
            os.remove(model_bin_path)
        raise

def get_model(model_size: str = "base", device: str = "cuda", compute_type: str = "float16") -> WhisperModel:
    """Get or create a Whisper model instance"""
    cache_key = f"{model_size}_{device}_{compute_type}"
    
    if cache_key not in MODEL_CACHE:
        print(f"Loading Whisper {model_size} model...")
        start_time = time.time()
        
        try:
            # Download model if needed
            model_path = download_model_files(model_size)
            
            # Load model from downloaded path
            model = WhisperModel(
                model_path,
                device=device,
                compute_type=compute_type,
                local_files_only=True  # Use only local files
            )
            
            MODEL_CACHE[cache_key] = model
            print(f"Model loaded in {time.time() - start_time:.2f} seconds")
        except Exception as e:
            print(f"Error loading model {model_size}: {e}")
            # Try with CPU and int8 as fallback
            if device == "cuda":
                print("Falling back to CPU with int8...")
                model_path = download_model_files(model_size)
                model = WhisperModel(
                    model_path,
                    device="cpu",
                    compute_type="int8",
                    local_files_only=True
                )
                MODEL_CACHE[cache_key] = model
            else:
                raise
    
    return MODEL_CACHE[cache_key]

def process_audio(audio_data: bytes, model_size: str, **kwargs) -> Dict[str, Any]:
    """Process audio and return transcription with metadata"""
    
    # Save audio to temporary file
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
        tmp_file.write(audio_data)
        tmp_file_path = tmp_file.name
    
    try:
        # Get model
        device = "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES") else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        model = get_model(model_size, device, compute_type)
        
        # Transcribe
        print(f"Transcribing audio with {model_size} model...")
        start_time = time.time()
        
        segments, info = model.transcribe(
            tmp_file_path,
            language=kwargs.get("language", None),
            task=kwargs.get("task", "transcribe"),
            beam_size=kwargs.get("beam_size", 5),
            best_of=kwargs.get("best_of", 5),
            temperature=kwargs.get("temperature", 0),
            word_timestamps=kwargs.get("word_timestamps", True),
            vad_filter=kwargs.get("vad_filter", True),
            vad_parameters=kwargs.get("vad_parameters", None)
        )
        
        # Process segments
        segments_list = []
        full_text = []
        
        for segment in segments:
            seg_dict = {
                "id": segment.id,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
                "tokens": segment.tokens,
                "temperature": segment.temperature,
                "avg_logprob": segment.avg_logprob,
                "compression_ratio": segment.compression_ratio,
                "no_speech_prob": segment.no_speech_prob
            }
            
            # Add word-level timestamps if available
            if hasattr(segment, 'words') and segment.words:
                seg_dict["words"] = [
                    {
                        "word": word.word,
                        "start": word.start,
                        "end": word.end,
                        "probability": word.probability
                    }
                    for word in segment.words
                ]
            
            segments_list.append(seg_dict)
            full_text.append(segment.text.strip())
        
        transcription_time = time.time() - start_time
        
        # Create response
        result = {
            "text": " ".join(full_text),
            "segments": segments_list,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "transcription_time": transcription_time,
            "model_size": model_size,
            "device": device,
            "audio_duration": info.duration,
            "processing_speed": info.duration / transcription_time if transcription_time > 0 else 0
        }
        
        # Add detected language info
        if hasattr(info, 'all_language_probs') and info.all_language_probs:
            result["all_language_probabilities"] = info.all_language_probs
        
        return result
        
    finally:
        # Clean up temp file
        if os.path.exists(tmp_file_path):
            os.unlink(tmp_file_path)

def handler(job: Dict[str, Any]) -> Dict[str, Any]:
    """RunPod serverless handler"""
    try:
        job_input = job.get("input", {})
        
        # Validate model size
        model_size = job_input.get("model_size", "base").lower()
        valid_sizes = ["tiny", "base", "small", "medium", "large-v3", "large"]
        
        # Handle "large" as "large-v3"
        if model_size == "large":
            model_size = "large-v3"
        
        if model_size not in valid_sizes:
            return {
                "error": f"Invalid model size: {model_size}. Valid sizes: {valid_sizes}"
            }
        
        # Get audio data
        audio_data = None
        
        if "audio_base64" in job_input:
            # Decode base64 audio
            try:
                audio_data = base64.b64decode(job_input["audio_base64"])
            except Exception as e:
                return {"error": f"Failed to decode base64 audio: {str(e)}"}
        
        elif "audio_url" in job_input:
            # Download audio from URL
            import requests
            try:
                response = requests.get(job_input["audio_url"], timeout=300)
                response.raise_for_status()
                audio_data = response.content
            except Exception as e:
                return {"error": f"Failed to download audio: {str(e)}"}
        
        else:
            return {"error": "No audio data provided. Use 'audio_base64' or 'audio_url'"}
        
        # Process audio
        result = process_audio(
            audio_data,
            model_size=model_size,
            language=job_input.get("language"),
            task=job_input.get("task", "transcribe"),
            beam_size=job_input.get("beam_size", 5),
            best_of=job_input.get("best_of", 5),
            temperature=job_input.get("temperature", 0),
            word_timestamps=job_input.get("word_timestamps", True),
            vad_filter=job_input.get("vad_filter", True),
            vad_parameters=job_input.get("vad_parameters")
        )
        
        return result
        
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "traceback": traceback.format_exc()
        }

# Start RunPod handler
if __name__ == "__main__":
    print("Starting RunPod Whisper handler...")
    print("Models will be downloaded on first use")
    runpod.serverless.start({"handler": handler})