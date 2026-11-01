# inf-image: OpenAI-shaped image API over ComfyUI (Qwen-Image-Edit-2511). Copied from the owner's
# inference_system/services/image (see NOTICE.md); kept byte-identical so fixes can flow both ways.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY workflows ./workflows
ENV BIND=0.0.0.0 PORT=8102
CMD ["sh", "-c", "exec uvicorn app:app --host $BIND --port $PORT --no-access-log"]
