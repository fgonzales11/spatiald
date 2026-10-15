FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libgdal-dev \
    && rm -rf /var/lib/apt/lists/*
COPY analysis_service/requirements.lock.txt ./requirements.lock.txt
RUN sed '/^torch==/d; /^torchvision==/d' requirements.lock.txt > /tmp/core-requirements.txt \
    && pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /tmp/core-requirements.txt \
    && pip install --no-cache-dir torch==2.14.1 torchvision==0.29.1 --index-url https://download.pytorch.org/whl/cpu
COPY analysis_service/ ./analysis_service/
COPY schemas/ ./schemas/
ENV ANALYSIS_DATA_DIR=/data
EXPOSE 5181
CMD ["uvicorn", "analysis_service.app:app", "--host", "0.0.0.0", "--port", "5181"]
