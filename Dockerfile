FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY follow.py list_chats.py login.py ./

# Session is stored in /data (mount a volume) so login persists across restarts.
ENV SESSION_NAME=/data/follow_session
VOLUME ["/data"]

CMD ["python", "follow.py"]
