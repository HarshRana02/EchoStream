EchoStream is a browser-based watch-party application for synchronizing video playback across multiple connected users. One connected client acts as the controller, while other viewers receive synchronized play, pause, seek, video-load, and controller-change events through Socket.IO and Redis.

### Stack
- **Language(s):** Python backend, JavaScript frontend, HTML templates, and CSS
- **Framework / runtime:** Flask 3 with Flask-SocketIO, running on Eventlet
- **Notable libraries:** Redis, Flask-SocketIO, python-socketio, Eventlet, Jinja2

## How it's organized

```text
server.py                 Flask application, upload route, Socket.IO handlers,
                          controller election, and Redis event listener
redis_config.py           Redis connection, shared state keys, Pub/Sub channel,
                          and state initialization
requirements.txt          Pinned Python dependencies

templates/
  index.html              Watch-party page, video player, upload form, status UI

static/
  js/
    client.js             Socket.IO client, playback synchronization, drift
                          correction, controller permissions, and uploads
  css/
    style.css             Application layout and UI styling
  videos/                 Runtime destination for uploaded MP4, WebM, and OGG files

guide.txt                 Local setup and Redis/Docker instructions
project structure.txt     Basic project layout documentation
LICENSE                   Project license
```

**How it fits together:** `server.py` serves `templates/index.html` and accepts uploaded videos at `/upload`. Each browser connects through Socket.IO; connection IDs are stored in Redis, and the shared playback state is kept in the `vidsync:state` Redis hash. Controller actions update Redis and publish events on `vidsync:events`; a background listener in `redis_event_listener()` broadcasts those events to all connected clients. `static/js/client.js` applies the events, periodically requests state to correct playback drift, and elects a replacement controller when the current controller disconnects.

The client uses a 250 ms drift threshold and a 200 ms play latency compensation offset. Only the current controller can emit `play`, `pause`, and `seek` events, while uploading a video automatically assigns controller status to the uploader.

## How to run it

Requirements:

- Python and `pip`
- Docker
- Redis running locally on port `6379`

```bash
# Start Redis
docker run -d --name EchoStream -p 6379:6379 redis:latest

# Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start the application
python3 server.py
```

Then open:

```text
http://localhost:5000
```
