# nearchant tts: English Kokoro-82M + polish + faster-whisper /transcribe, CPU only (copy of advertisment_system
# gen-tts, NOTICE.md). Weights are mounted at /weights, never baked in.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py polish.py ./
ENV PORT=8105 OMP_NUM_THREADS=8
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port $PORT --no-access-log"]
