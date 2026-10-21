# CPU by default. For NVIDIA GPUs build with:
#   docker build --build-arg BASE_IMAGE=pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime -t bolverse-api .
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

ENV HF_HOME=/models BOLVERSE_DATA_DIR=/data
EXPOSE 8000
# One worker: models live in process memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
