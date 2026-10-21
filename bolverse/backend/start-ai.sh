#!/usr/bin/env bash
# Starts the voice worker in the background, then the AI worker in front (RunPod polls GET /ping on $PORT).
set -e
mkdir -p "${HF_HOME:-/root/.cache/huggingface}" 2>/dev/null || export HF_HOME=/root/.cache/huggingface
/opt/voice/bin/python -m uvicorn voice_worker.worker:app --host 127.0.0.1 --port 8001 &
exec python -m uvicorn app.ai_server:app --host 0.0.0.0 --port "${PORT:-80}"
