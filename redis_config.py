# import redis
# import json

# # --- Configuration ---
# # Use a connection pool for high-performance, concurrent Redis connections
# REDIS_POOL = redis.ConnectionPool(host='localhost', port=6379, db=0, decode_responses=True)

# # --- Constants ---
# STATE_KEY = "vidsync:state"
# USER_SET_KEY = "vidsync:users"

# # --- Redis Client Instance ---
# try:
#     r = redis.Redis(connection_pool=REDIS_POOL)
#     r.ping()
#     print("✅ Successfully connected to Redis server.")
# except redis.exceptions.ConnectionError as e:
#     print(f"❌ CRITICAL: Could not connect to Redis.")
#     print("Please ensure the Redis server is running on localhost:6379.")
#     print(f"Error: {e}")
#     exit(1)

# # --- Helper Utilities ---

# def set_json(key, data):
#     """Serializes and sets a JSON object in Redis."""
#     try:
#         r.set(key, json.dumps(data))
#     except (redis.exceptions.RedisError, TypeError) as e:
#         print(f"Redis set_json error: {e}")

# def get_json(key):
#     """Fetches and deserializes a JSON object from Redis."""
#     try:
#         data = r.get(key)
#         return json.loads(data) if data else None
#     except (redis.exceptions.RedisError, TypeError) as e:
#         print(f"Redis get_json error: {e}")
#         return None

# def initialize_redis_state():
#     """Wipes and sets the default state in Redis on server start."""
#     print("🔄 Initializing Redis state...")
#     try:
#         # Use a pipeline for atomic initialization
#         pipe = r.pipeline()
        
#         # Clear previous state
#         pipe.delete(STATE_KEY)
#         pipe.delete(USER_SET_KEY)
        
#         # Set default video state
#         pipe.hset(STATE_KEY, mapping={
#             "video_file_url": "",
#             "is_playing": "0",
#             "current_time": "0.0",
#             "last_update_timestamp": "0.0",
#             "controller_sid": "" # Empty string means no controller
#         })
        
#         pipe.execute()
#         print("Redis state initialized.")
#     except redis.exceptions.RedisError as e:
#         print(f"❌ Failed to initialize Redis state: {e}")



import redis
import json

# --- Configuration ---
# Use a connection pool for high-performance, concurrent Redis connections
REDIS_POOL = redis.ConnectionPool(host='localhost', port=6379, db=0, decode_responses=True)

# --- Constants ---
STATE_KEY = "vidsync:state"
USER_SET_KEY = "vidsync:users"
SYNC_CHANNEL = "vidsync:events"  # <--- NEW: Dedicated channel for real-time sync

# --- Redis Client Instance ---
try:
    r = redis.Redis(connection_pool=REDIS_POOL)
    r.ping()
    print("✅ Successfully connected to Redis server.")
except redis.exceptions.ConnectionError as e:
    print(f"❌ CRITICAL: Could not connect to Redis.")
    print("Please ensure the Redis server is running on localhost:6379.")
    print(f"Error: {e}")
    exit(1)

# --- Helper Utilities ---

def set_json(key, data):
    """Serializes and sets a JSON object in Redis."""
    try:
        r.set(key, json.dumps(data))
    except (redis.exceptions.RedisError, TypeError) as e:
        print(f"Redis set_json error: {e}")

def get_json(key):
    """Fetches and deserializes a JSON object from Redis."""
    try:
        data = r.get(key)
        return json.loads(data) if data else None
    except (redis.exceptions.RedisError, TypeError) as e:
        print(f"Redis get_json error: {e}")
        return None

def initialize_redis_state():
    """Wipes and sets the default state in Redis on server start."""
    print("🔄 Initializing Redis state...")
    try:
        # Use a pipeline for atomic initialization
        pipe = r.pipeline()
        
        # Clear previous state
        pipe.delete(STATE_KEY)
        pipe.delete(USER_SET_KEY)
        
        # Set default video state
        pipe.hset(STATE_KEY, mapping={
            "video_file_url": "",
            "is_playing": "0",
            "current_time": "0.0",
            "last_update_timestamp": "0.0",
            "controller_sid": "" # Empty string means no controller
        })
        
        pipe.execute()
        print("Redis state initialized.")
    except redis.exceptions.RedisError as e:
        print(f"❌ Failed to initialize Redis state: {e}")