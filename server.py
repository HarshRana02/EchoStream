# IMPORTANT: Eventlet monkey patching must happen *before* any other imports
import eventlet
eventlet.monkey_patch()

import redis
import os
import time
import json
import logging
from flask import Flask, render_template, request, jsonify, url_for, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename

# Import our Redis client and configuration
from redis_config import r, STATE_KEY, USER_SET_KEY, SYNC_CHANNEL, initialize_redis_state

# --- Constants ---
UPLOAD_FOLDER = os.path.join('static', 'videos')
ALLOWED_EXTENSIONS = {'mp4', 'webm', 'ogg'}

# --- App Initialization ---
print("Starting server with eventlet async mode...")
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['SECRET_KEY'] = 'your-very-secret-key-change-this!' 
app.config['MAX_CONTENT_LENGTH'] = 1024 * 1024 * 500 

socketio = SocketIO(
    app,
    async_mode='eventlet',
    cors_allowed_origins="*",
    ping_timeout=10,
    ping_interval=5
)

# --- Utility Functions ---

def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def get_current_state():
    try:
        state_raw = r.hgetall(STATE_KEY)
        state = {k: v for k, v in state_raw.items()}
        
        is_playing = state.get("is_playing") == "1"
        base_time = float(state.get("current_time", 0.0))
        last_update = float(state.get("last_update_timestamp", 0.0))
        
        authoritative_time = base_time
        if is_playing:
            elapsed = time.time() - last_update
            authoritative_time += elapsed
            
        state["current_time"] = authoritative_time
        state["is_playing"] = is_playing
        state["controller_sid"] = state.get("controller_sid", "")
        state["video_file_url"] = state.get("video_file_url", "")
        return state
    except redis.exceptions.RedisError as e:
        print(f"Redis get_current_state error: {e}")
        return {}

def elect_new_controller():
    try:
        new_controller_sid = r.srandmember(USER_SET_KEY)
        if new_controller_sid:
            r.hset(STATE_KEY, "controller_sid", new_controller_sid)
            print(f"👑 New controller elected: {new_controller_sid}")
            r.publish(SYNC_CHANNEL, json.dumps({
                "event": "controller_change",
                "data": {"controller_sid": new_controller_sid}
            }))
        else:
            r.hset(STATE_KEY, "controller_sid", "")
            r.publish(SYNC_CHANNEL, json.dumps({
                "event": "controller_change",
                "data": {"controller_sid": ""}
            }))
        return new_controller_sid
    except redis.exceptions.RedisError as e:
        print(f"Redis elect_new_controller error: {e}")
        return None

def is_controller(sid):
    try:
        return r.hget(STATE_KEY, "controller_sid") == sid
    except redis.exceptions.RedisError:
        return False

# --- Redis Pub/Sub Listener (Robust Version) ---

def redis_event_listener():
    """
    Listens to the Redis SYNC_CHANNEL.
    Includes auto-restart logic to ensure the sync never dies.
    """
    print("🎧 Redis Pub/Sub Listener started. Waiting for events...")
    while True:
        try:
            pubsub = r.pubsub(ignore_subscribe_messages=True)
            pubsub.subscribe(SYNC_CHANNEL)
            
            for message in pubsub.listen():
                if message['type'] == 'message':
                    payload = json.loads(message['data'])
                    event_name = payload.get('event')
                    event_data = payload.get('data')
                    
                    print(f"📣 Broadcasting event: {event_name}")
                    socketio.emit(event_name, event_data)
        except Exception as e:
            print(f"❌ Redis Listener Error: {e}. Restarting in 2 seconds...")
            socketio.sleep(2)

# --- HTTP Routes ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_video():
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No file part"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"success": False, "error": "No selected file"}), 400
        
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        save_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        file.save(save_path)
        
        video_url = url_for('static', filename=f'videos/{filename}')
        uploader_sid = request.form.get('sid')
        
        if not uploader_sid:
            return jsonify({"success": False, "error": "No client SID"}), 400

        try:
            pipe = r.pipeline()
            pipe.hset(STATE_KEY, "video_file_url", video_url)
            pipe.hset(STATE_KEY, "is_playing", "0")
            pipe.hset(STATE_KEY, "current_time", "0.0")
            pipe.hset(STATE_KEY, "last_update_timestamp", str(time.time()))
            pipe.hset(STATE_KEY, "controller_sid", uploader_sid)
            pipe.execute()

            print(f"💾 Video uploaded by {uploader_sid}. Publishing events...")

            r.publish(SYNC_CHANNEL, json.dumps({
                "event": "video_loaded",
                "data": {"url": video_url, "sid": uploader_sid}
            }))
            
            r.publish(SYNC_CHANNEL, json.dumps({
                "event": "controller_change",
                "data": {"controller_sid": uploader_sid}
            }))
            
            return ('', 204)
            
        except Exception as e:
            print(f"Upload error: {e}")
            return jsonify({"success": False, "error": "Server error"}), 500

    return jsonify({"success": False, "error": "File type not allowed"}), 400

# --- Socket.IO Event Handlers ---

@socketio.on('connect')
def handle_connect():
    sid = request.sid
    try:
        r.sadd(USER_SET_KEY, sid)
        # Send current state to the new user immediately
        emit('sync_state', get_current_state(), to=sid)
    except Exception as e:
        print(f"Connect error: {e}")

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    try:
        r.srem(USER_SET_KEY, sid)
        if is_controller(sid):
            elect_new_controller()
    except Exception as e:
        print(f"Disconnect error: {e}")

@socketio.on('request_sync')
def handle_request_sync():
    emit('sync_state', get_current_state())

# --- Playback Control Events ---

@socketio.on('play')
def handle_play(data):
    sid = request.sid
    if not is_controller(sid): 
        print(f"⚠️ Ignored PLAY from non-controller: {sid}")
        return

    current_time = float(data.get('time', 0.0))
    print(f"▶️ Controller {sid} PLAY at {current_time}")

    pipe = r.pipeline()
    pipe.hset(STATE_KEY, "is_playing", "1")
    pipe.hset(STATE_KEY, "current_time", str(current_time))
    pipe.hset(STATE_KEY, "last_update_timestamp", str(time.time()))
    pipe.execute()

    r.publish(SYNC_CHANNEL, json.dumps({
        "event": "sync_play",
        "data": {"time": current_time, "sid": sid}
    }))

@socketio.on('pause')
def handle_pause(data):
    sid = request.sid
    if not is_controller(sid): 
        print(f"⚠️ Ignored PAUSE from non-controller: {sid}")
        return

    current_time = float(data.get('time', 0.0))
    print(f"⏸️ Controller {sid} PAUSE at {current_time}")

    pipe = r.pipeline()
    pipe.hset(STATE_KEY, "is_playing", "0")
    pipe.hset(STATE_KEY, "current_time", str(current_time))
    pipe.hset(STATE_KEY, "last_update_timestamp", str(time.time()))
    pipe.execute()

    r.publish(SYNC_CHANNEL, json.dumps({
        "event": "sync_pause",
        "data": {"time": current_time, "sid": sid}
    }))

@socketio.on('seek')
def handle_seek(data):
    sid = request.sid
    if not is_controller(sid): 
        return

    current_time = float(data.get('time', 0.0))
    print(f"⏩ Controller {sid} SEEK to {current_time}")

    pipe = r.pipeline()
    pipe.hset(STATE_KEY, "current_time", str(current_time))
    pipe.hset(STATE_KEY, "last_update_timestamp", str(time.time()))
    pipe.execute()

    r.publish(SYNC_CHANNEL, json.dumps({
        "event": "sync_seek",
        "data": {"time": current_time, "sid": sid}
    }))


def main():
    try:
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        initialize_redis_state()
        
        # Start the Redis listener in a background thread
        socketio.start_background_task(redis_event_listener)
        
        print(f"🚀 Server starting on http://0.0.0.0:5000")
        socketio.run(app, host='0.0.0.0', port=5000, log_output=True, use_reloader=False)
        
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        r.delete(STATE_KEY)
        r.delete(USER_SET_KEY)

if __name__ == '__main__':
    main()