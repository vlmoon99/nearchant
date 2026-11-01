# nearchant video: LTX-2.5 /generate over the ComfyUI next to it (copy of advertisment_system gen-video, NOTICE.md).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY workflows ./workflows
ENV PORT=8104
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port $PORT --no-access-log"]
