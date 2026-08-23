/* ═══════════════════════════════════════════════════════════════════════════
   Presenter — Screen Capture + WebRTC
   Handles: getDisplayMedia, room creation, multi-viewer peer connections
   ═══════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    console.log('✅ Presenter connected to signaling server:', socket.id);
  });

  socket.on('connect_error', (err) => {
    console.warn('⚠️ Presenter socket connection error:', err);
  });

  // ── State ────────────────────────────────────────────────────────────────
  let localStream = null;
  const peerConnections = new Map(); // viewerId → RTCPeerConnection

  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' }
    ]
  };

  // ── DOM Elements ─────────────────────────────────────────────────────────
  const startBtn      = document.getElementById('start-btn');
  const stopBtn       = document.getElementById('stop-btn');
  const preShareEl    = document.getElementById('pre-share');
  const activeShareEl = document.getElementById('active-share');
  const previewVideo  = document.getElementById('preview-video');
  const shareLinkEl   = document.getElementById('share-link');
  const copyBtn       = document.getElementById('copy-btn');
  const viewerCountEl = document.getElementById('viewer-count');

  // Helper to ensure socket is connected
  function ensureConnected() {
    return new Promise((resolve, reject) => {
      if (socket.connected) return resolve();
      const timeout = setTimeout(() => {
        reject(new Error('Connecting to server took too long. Please refresh and try again.'));
      }, 8000);
      socket.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  // ── Start Sharing ────────────────────────────────────────────────────────
  startBtn.addEventListener('click', async () => {
    try {
      // Ensure socket is connected before requesting screen
      if (!socket.connected) {
        showToast('Connecting to server...', '⏳');
        await ensureConnected();
      }

      // Request screen/tab/window capture
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'browser'
        },
        audio: true
      });

      // Show preview
      previewVideo.srcObject = localStream;

      // Create a room on the signaling server
      socket.emit('create-room', ({ roomId }) => {
        const link = `${window.location.origin}/view/${roomId}`;
        shareLinkEl.value = link;

        // Switch UI to active-share state
        preShareEl.classList.add('hidden');
        activeShareEl.classList.add('visible');
        showToast('Screen sharing live! Link generated.', '🚀');
      });

      // If user clicks the browser-native "Stop sharing" button
      localStream.getVideoTracks()[0].addEventListener('ended', () => {
        stopSharing();
      });

    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        console.error('Screen share error:', err);
        showToast(err.message || 'Failed to start screen sharing. Please try again.', '❌');
      }
    }
  });

  // ── New Viewer Joined — Create Peer Connection ───────────────────────────
  socket.on('viewer-joined', async ({ viewerId, viewerCount }) => {
    updateViewerCount(viewerCount);

    try {
      const pc = new RTCPeerConnection(ICE_CONFIG);
      peerConnections.set(viewerId, pc);

      // Add all local tracks (video + audio) to this connection
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });

      // Send ICE candidates to the viewer
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            targetId: viewerId,
            candidate: event.candidate
          });
        }
      };

      // Log connection state for debugging
      pc.onconnectionstatechange = () => {
        console.log(`Peer ${viewerId}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') {
          pc.close();
          peerConnections.delete(viewerId);
        }
      };

      // Create offer and send to viewer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('offer', {
        targetId: viewerId,
        offer: pc.localDescription
      });

    } catch (err) {
      console.error(`Failed to create peer connection for viewer ${viewerId}:`, err);
    }
  });

  // ── Receive Answer from Viewer ───────────────────────────────────────────
  socket.on('answer', async ({ senderId, answer }) => {
    const pc = peerConnections.get(senderId);
    if (pc && pc.signalingState === 'have-local-offer') {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error(`Failed to set answer from ${senderId}:`, err);
      }
    }
  });

  // ── Receive ICE Candidate from Viewer ────────────────────────────────────
  socket.on('ice-candidate', async ({ senderId, candidate }) => {
    const pc = peerConnections.get(senderId);
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(`ICE candidate error from ${senderId}:`, err);
      }
    }
  });

  // ── Viewer Left ──────────────────────────────────────────────────────────
  socket.on('viewer-left', ({ viewerId, viewerCount }) => {
    updateViewerCount(viewerCount);
    const pc = peerConnections.get(viewerId);
    if (pc) {
      pc.close();
      peerConnections.delete(viewerId);
    }
  });

  // ── Stop Sharing ─────────────────────────────────────────────────────────
  function stopSharing() {
    // Notify server
    socket.emit('stop-sharing');

    // Close all peer connections
    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();

    // Stop all media tracks
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }

    // Reset UI
    previewVideo.srcObject = null;
    activeShareEl.classList.remove('visible');
    preShareEl.classList.remove('hidden');
    updateViewerCount(0);

    showToast('Screen sharing stopped.', '⏹');
  }

  stopBtn.addEventListener('click', stopSharing);

  // ── Copy Link ────────────────────────────────────────────────────────────
  copyBtn.addEventListener('click', () => {
    const link = shareLinkEl.value;
    navigator.clipboard.writeText(link).then(() => {
      showToast('Link copied to clipboard!', '✅');
    }).catch(() => {
      // Fallback: select the input
      shareLinkEl.select();
      document.execCommand('copy');
      showToast('Link copied!', '✅');
    });
  });

  // ── Helpers ──────────────────────────────────────────────────────────────
  function updateViewerCount(count) {
    viewerCountEl.textContent = count;
  }

  function showToast(message, icon = '✅') {
    const toast = document.getElementById('toast');
    const toastIcon = toast.querySelector('.toast-icon');
    const toastMsg = document.getElementById('toast-message');

    toastIcon.textContent = icon;
    toastMsg.textContent = message;
    toast.classList.add('show');

    setTimeout(() => toast.classList.remove('show'), 3000);
  }

})();
