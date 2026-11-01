# Headless ComfyUI for the GB10 (aarch64, CUDA 13). Base = the local vLLM image with a matching PyTorch build.
FROM vllm-node:latest
ARG COMFY_REF=v0.43.2
RUN git clone --depth 1 --branch ${COMFY_REF} https://github.com/comfyanonymous/ComfyUI /opt/ComfyUI \
 && cd /opt/ComfyUI \
 && grep -vE '^(torch|torchvision|torchaudio)([<>= ]|$)' requirements.txt > /tmp/req.txt \
 && pip install --no-cache-dir --break-system-packages -r /tmp/req.txt
WORKDIR /opt/ComfyUI
EXPOSE 8188
ENTRYPOINT ["python3", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-auto-launch"]
