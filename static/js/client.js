document.addEventListener('DOMContentLoaded', () => {

    // --- Global State ---
    let isController = false;
    let localSID = null;
    let isSeeking = false; 
    let isServerSyncing = false; 
    let antiDriftInterval = null;
    let hasJoined = false; 

    // --- Configuration ---
    // Add a small offset to account for network transmission time (200ms)
    const LATENCY_COMPENSATION = 0.2; 
    // Tighter drift threshold for better sync (250ms)
    const DRIFT_THRESHOLD = 0.25;

    // --- DOM Elements ---
    const video = document.getElementById('video-player');
    const statusConnection = document.getElementById('connection-status');
    const statusRole = document.getElementById('role-status');
    const statusController = document.getElementById('controller-status');
    const uploadForm = document.getElementById('upload-form');
    const fileInput = document.getElementById('file-input');
    const uploadStatus = document.getElementById('upload-status');
    const joinOverlay = document.getElementById('join-overlay');
    const joinBtn = document.getElementById('join-btn');

    // --- WebSocket Connection ---
    const socket = io({
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
    });

    // --- Join / Audio Unlock Logic ---
    if (joinBtn) {
        joinBtn.addEventListener('click', () => {
            video.play().then(() => {
                video.pause();
            }).catch(e => console.log("Audio unlock attempt:", e));
            
            hasJoined = true;
            joinOverlay.style.display = 'none';
            socket.emit('request_sync');
        });
    }

    // --- Utility Functions ---

    function updateControls() {
        if (isController) {
            statusRole.textContent = 'Controller';
            statusRole.className = 'controller';
            video.controls = true; 
        } else {
            statusRole.textContent = 'Viewer';
            statusRole.className = 'viewer';
            video.controls = false; 
        }
    }

    function checkDrift() {
        if (isController || !video.src || video.readyState < 1 || !hasJoined) return;
        socket.emit('request_sync');
    }

    function syncToState(state) {
        if (!hasJoined) return;

        // 1. Sync Video Source
        if (state.video_file_url && video.src.endsWith(state.video_file_url) === false) {
            console.log(`Loading new video: ${state.video_file_url}`);
            isServerSyncing = true;
            video.src = state.video_file_url;
            video.load();
            setTimeout(() => { isServerSyncing = false; }, 500);
            return;
        }

        // 2. Sync Time (Drift Correction)
        const serverTime = parseFloat(state.current_time || 0.0);
        const clientTime = video.currentTime;
        const drift = Math.abs(serverTime - clientTime);

        // We only correct drift if:
        // a. It is larger than our threshold
        // b. We are NOT currently in a "server sync" action (like seeking)
        if (drift > DRIFT_THRESHOLD && !isServerSyncing) { 
            console.warn(`Drift Correction: Server=${serverTime.toFixed(3)}, Client=${clientTime.toFixed(3)}, Drift=${drift.toFixed(3)}`);
            video.currentTime = serverTime;
        }

        // 3. Sync Play/Pause State
        if (state.is_playing && video.paused) {
            attemptPlay();
        } else if (!state.is_playing && !video.paused) {
            video.pause();
        }

        // 4. Sync Controller Status
        isController = (state.controller_sid === localSID);
        statusController.textContent = state.controller_sid || 'None';
        updateControls();
    }

    function attemptPlay() {
        if (!hasJoined) return;
        var playPromise = video.play();
        if (playPromise !== undefined) {
            playPromise.catch(error => {
                console.warn("Autoplay prevented or loading.");
            });
        }
    }

    // --- Socket.IO Event Handlers ---

    socket.on('connect', () => {
        localSID = socket.id;
        console.log(`Connected: ${localSID}`);
        statusConnection.textContent = 'Connected';
        statusConnection.className = 'connected';
        if (antiDriftInterval) clearInterval(antiDriftInterval);
        // Check drift more frequently (every 1s instead of 2s)
        antiDriftInterval = setInterval(checkDrift, 1000);
    });

    socket.on('disconnect', () => {
        statusConnection.textContent = 'Disconnected';
        statusConnection.className = 'disconnected';
        statusRole.textContent = 'Viewer';
        isController = false;
        updateControls();
        if (antiDriftInterval) clearInterval(antiDriftInterval);
    });

    socket.on('sync_state', (state) => syncToState(state));

    socket.on('video_loaded', (data) => {
        console.log(`Video Loaded Event: ${data.url}`);
        isServerSyncing = true;
        video.src = data.url;
        video.load();
        video.pause();
        video.currentTime = 0;
        if (uploadStatus) { uploadStatus.textContent = ''; uploadStatus.className = ''; }
        setTimeout(() => { isServerSyncing = false; }, 500);
    });

    socket.on('sync_play', (data) => {
        if (isController) return; 
        
        // Apply Latency Compensation
        const targetTime = data.time + LATENCY_COMPENSATION;
        console.log(`SYNC: PLAY at ${data.time} (+${LATENCY_COMPENSATION}s offset)`);
        
        // Only jump if we are significantly off, otherwise just play
        if (Math.abs(video.currentTime - targetTime) > DRIFT_THRESHOLD) {
            video.currentTime = targetTime;
        }
        attemptPlay();
    });

    socket.on('sync_pause', (data) => {
        if (isController) return; 
        console.log(`SYNC: PAUSE at ${data.time}`);
        video.pause();
        
        // Ensure we pause at the exact frame
        if (Math.abs(video.currentTime - data.time) > DRIFT_THRESHOLD) {
            video.currentTime = data.time; 
        }
    });

    socket.on('sync_seek', (data) => {
        if (isController) return; 
        console.log(`SYNC: SEEK to ${data.time}`);
        
        isServerSyncing = true;
        video.currentTime = data.time;
        
        // Force a re-sync shortly after the seek settles
        // This fixes the "stuck after forward" issue
        setTimeout(() => { 
            isServerSyncing = false; 
            socket.emit('request_sync');
        }, 1000);
    });

    socket.on('controller_change', (data) => {
        console.log(`New Controller: ${data.controller_sid}`);
        const oldIsController = isController;
        isController = (data.controller_sid === localSID);
        statusController.textContent = data.controller_sid || 'None';
        updateControls();

        if (isController && !oldIsController) {
             if (uploadStatus) {
                 uploadStatus.textContent = `Upload successful! You are the new controller.`;
                 uploadStatus.className = 'success';
             }
        }
    });


    // --- DOM Event Handlers ---

    video.addEventListener('play', () => {
        if (!isController || isServerSyncing || isSeeking) return;
        console.log("Emitting PLAY");
        socket.emit('play', { time: video.currentTime });
    });

    video.addEventListener('pause', () => {
        if (!isController || isServerSyncing || isSeeking) return;
        console.log("Emitting PAUSE");
        socket.emit('pause', { time: video.currentTime });
    });

    video.addEventListener('seeking', () => {
        if (!isController || isServerSyncing) return;
        isSeeking = true;
    });

    video.addEventListener('seeked', () => {
        if (!isController || isServerSyncing) return;
        isSeeking = false;
        console.log("Emitting SEEK");
        socket.emit('seek', { time: video.currentTime });
    });
    
    // Upload Form
    if (uploadForm) {
        uploadForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!fileInput.files.length) return;
            if (!localSID) return;

            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            formData.append('sid', localSID); 

            uploadStatus.textContent = 'Uploading...';
            uploadStatus.className = '';

            fetch('/upload', { method: 'POST', body: formData })
            .then(response => {
                if (!response.ok) {
                    return response.json().then(err => {
                         uploadStatus.textContent = `Error: ${err.error}`;
                         uploadStatus.className = 'error';
                    });
                }
            })
            .catch(error => {
                uploadStatus.textContent = `Error: ${error.message}`;
                uploadStatus.className = 'error';
            });
        });
    }
});