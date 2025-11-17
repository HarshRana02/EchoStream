document.addEventListener('DOMContentLoaded', () => {

    // --- Global State ---
    let isController = false;
    let localSID = null;
    let isSeeking = false; // Flag to prevent event loops during seek
    let isServerSyncing = false; // Flag to prevent event loops during server sync
    let antiDriftInterval = null;

    // --- DOM Elements ---
    const video = document.getElementById('video-player');
    const statusConnection = document.getElementById('connection-status');
    const statusRole = document.getElementById('role-status');
    const statusController = document.getElementById('controller-status');

    // Upload elements (visible to all)
    const uploadForm = document.getElementById('upload-form');
    const fileInput = document.getElementById('file-input');
    const uploadStatus = document.getElementById('upload-status');

    // --- WebSocket Connection (CRITICAL FIX) ---
    const socket = io({
        // --- FIX: 'transports' option REMOVED ---
        // This allows Socket.IO to fall back to HTTP long-polling
        // if the WebSocket connection is blocked by a firewall.
        // This makes the connection much more reliable and fixes errors.
        reconnectionAttempts: 5,
    });

    // --- Utility Functions ---

    /**
     * Updates the UI to reflect controller status.
     * Disables/enables controls based on role.
     */
    function updateControls() {
        if (isController) {
            statusRole.textContent = 'Controller';
            statusRole.className = 'controller';
            
            // Show native video controls
            video.controls = true; 

        } else {
            statusRole.textContent = 'Viewer';
            statusRole.className = 'viewer';
            
            // Viewers should *not* be able to control the video
            video.controls = false; 
        }
    }

    /**
     * Performs an anti-drift sync check.
     */
    function checkDrift() {
        if (isController || !video.src) {
            return;
        }
        socket.emit('request_sync');
    }

    /**
     * Synchronizes the client's video player to the server's state.
     */
    function syncToState(state) {
        console.log('Syncing to server state:', state);
        
        isServerSyncing = true;

        // 1. Sync Video Source
        if (state.video_file_url && video.src.endsWith(state.video_file_url) === false) {
            console.log(`Loading new video: ${state.video_file_url}`);
            video.src = state.video_file_url;
            video.load();
        }

        // 2. Sync Time (Drift Correction)
        const serverTime = parseFloat(state.current_time || 0.0);
        const clientTime = video.currentTime;
        const drift = Math.abs(serverTime - clientTime);

        if (drift > 0.350) { // 350ms threshold
            console.warn(`Correcting drift. Server: ${serverTime}, Client: ${clientTime}, Drift: ${drift}`);
            video.currentTime = serverTime;
        }

        // 3. Sync Play/Pause State
        if (state.is_playing && video.paused) {
            console.log('Server: Play');
            video.play().catch(e => console.error('Play interrupted:', e));
        } else if (!state.is_playing && !video.paused) {
            console.log('Server: Pause');
            video.pause();
        }

        // 4. Sync Controller Status
        isController = (state.controller_sid === localSID);
        statusController.textContent = state.controller_sid || 'None';
        updateControls();

        setTimeout(() => { isServerSyncing = false; }, 100);
    }


    // --- Socket.IO Event Handlers (Server -> Client) ---

    socket.on('connect', () => {
        localSID = socket.id;
        console.log(`Connected to server with SID: ${localSID}`);
        statusConnection.textContent = 'Connected';
        statusConnection.className = 'connected';
        
        if (antiDriftInterval) clearInterval(antiDriftInterval);
        antiDriftInterval = setInterval(checkDrift, 2000);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server.');
        statusConnection.textContent = 'Disconnected';
        statusConnection.className = 'disconnected';
        statusRole.textContent = 'Viewer';
        statusController.textContent = 'None';
        isController = false;
        updateControls();
        
        if (antiDriftInterval) clearInterval(antiDriftInterval);
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err.message);
        statusConnection.textContent = `Error: ${err.message}`;
        statusConnection.className = 'disconnected'; // Show error state
    });

    socket.on('sync_state', (state) => {
        syncToState(state);
    });

    socket.on('video_loaded', (data) => {
        console.log(`Server loaded new video: ${data.url}`);
        isServerSyncing = true;
        video.src = data.url;
        video.load();
        video.pause();
        video.currentTime = 0;
        // Clear any previous upload statuses
        if (uploadStatus) {
             uploadStatus.textContent = '';
             uploadStatus.className = '';
        }
        setTimeout(() => { isServerSyncing = false; }, 100);
    });

    socket.on('sync_play', (data) => {
        if (isController) return; // Controller already played locally
        console.log('Received PLAY command');
        isServerSyncing = true;
        video.currentTime = data.time;
        video.play().catch(e => console.error('Play interrupted:', e));
        setTimeout(() => { isServerSyncing = false; }, 100);
    });

    socket.on('sync_pause', (data) => {
        if (isController) return; // Controller already paused locally
        console.log('Received PAUSE command');
        isServerSyncing = true;
        video.pause();
        video.currentTime = data.time;
        setTimeout(() => { isServerSyncing = false; }, 100);
    });

    socket.on('sync_seek', (data) => {
        if (isController) return; // Controller already seeked locally
        console.log(`Received SEEK command to ${data.time}`);
        isServerSyncing = true;
        video.currentTime = data.time;
        setTimeout(() => { isServerSyncing = false; }, 100);
    });

    socket.on('controller_change', (data) => {
        console.log(`New controller: ${data.controller_sid}`);
        const oldIsController = isController;
        isController = (data.controller_sid === localSID);
        statusController.textContent = data.controller_sid || 'None';
        updateControls();

        // This is now the "success" message for uploading
        if (isController && !oldIsController) {
             uploadStatus.textContent = `Upload successful! You are the new controller.`;
             uploadStatus.className = 'success';
        }
    });


    // --- DOM Event Handlers (Client -> Server) ---

    // --- Video Element Event Listeners (for controller) ---
    video.addEventListener('play', () => {
        // We only send an event if we are the controller AND
        // the event was not triggered by the server.
        if (!isController || isServerSyncing || isSeeking) return;
        console.log('Video event: PLAY');
        socket.emit('play', { time: video.currentTime });
    });

    video.addEventListener('pause', () => {
        if (!isController || isServerSyncing || isSeeking) return;
        console.log('Video event: PAUSE');
        socket.emit('pause', { time: video.currentTime });
    });

    video.addEventListener('seeking', () => {
        if (!isController || isServerSyncing) return;
        isSeeking = true;
    });

    video.addEventListener('seeked', () => {
        if (!isController || isServerSyncing) return;
        isSeeking = false;
        console.log(`Video event: SEEKED to ${video.currentTime}`);
        socket.emit('seek', { time: video.currentTime });
    });
    

    // --- File Upload Handler ---
    if (uploadForm) {
        uploadForm.addEventListener('submit', (e) => {
            e.preventDefault();
            
            if (!fileInput.files || fileInput.files.length === 0) {
                uploadStatus.textContent = 'Please select a file first.';
                uploadStatus.className = 'error';
                return;
            }
            
            if (!localSID) {
                uploadStatus.textContent = 'Not connected to server. Cannot upload.';
                uploadStatus.className = 'error';
                return;
            }

            const file = fileInput.files[0];
            const formData = new FormData();
            formData.append('file', file);
            formData.append('sid', localSID); // Send our SID

            uploadStatus.textContent = 'Uploading...';
            uploadStatus.className = '';

            // "Fire-and-forget" the fetch request to prevent connection reset errors
            fetch('/upload', {
                method: 'POST',
                body: formData,
            })
            .then(response => response.json())
            .then(result => {
                if (!result.success) {
                    // Show an error if the upload *itself* failed
                    uploadStatus.textContent = `Upload failed: ${result.error}`;
                    uploadStatus.className = 'error';
                }
                // If it IS a success, we do nothing. We wait
                // for the 'controller_change' websocket event to confirm.
            })
            .catch(error => {
                // Handle network errors
                console.error('Upload error:', error);
                uploadStatus.textContent = `Upload failed: ${error.message}`;
                uploadStatus.className = 'error';
            });
        });
    }
});


