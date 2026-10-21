# Build from the backend folder:  docker build -f voice_worker/Dockerfile -t bolverse-voice .
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY voice_worker/requirements.txt voice_worker/requirements.txt
RUN pip install --no-cache-dir -r voice_worker/requirements.txt
COPY app/__init__.py app/languages.py app/
COPY voice_worker voice_worker
ENV HF_HOME=/models
EXPOSE 8001
CMD ["uvicorn", "voice_worker.worker:app", "--host", "0.0.0.0", "--port", "8001"]
