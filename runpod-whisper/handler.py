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
from typing import Dict, Any, List, Optional
from faster_whisper import WhisperModel
import numpy as np

# Model cache to avoid reloading
MODEL_CACHE = {}

def get_model(model_size: str = "base", device: str = "cuda", compute_type: str = "float16") -> WhisperModel:
    """Get or create a Whisper model instance"""
    cache_key = f"{model_size}_{device}_{compute_type}"
    
    if cache_key not in MODEL_CACHE:
        print(f"Loading Whisper {model_size} model...")
        start_time = time.time()
        
        try:
            model = WhisperModel(
                model_size,
                device=device,
                compute_type=compute_type,
                download_root="/models/whisper",
                local_files_only=False  # Allow downloading if not present
            )
            
            MODEL_CACHE[cache_key] = model
            print(f"Model loaded in {time.time() - start_time:.2f} seconds")
        except Exception as e:
            print(f"Error loading model {model_size}: {e}")
            # Try with CPU and int8 as fallback
            if device == "cuda":
                print("Falling back to CPU with int8...")
                model = WhisperModel(
                    model_size,
                    device="cpu",
                    compute_type="int8",
                    download_root="/models/whisper",
                    local_files_only=False
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

# Preload a model for faster cold starts
if __name__ == "__main__":
    print("Preloading base model for faster cold starts...")
    get_model("base", "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES") else "cpu")
    print("Starting RunPod handler...")
    runpod.serverless.start({"handler": handler})