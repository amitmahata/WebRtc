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
  const candidateQueues = new Map(); // viewerId → Array<RTCIceCandidateInit>

  // STUN servers for cross-network / symmetric NAT traversal
  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ],
    iceCandidatePoolSize: 10
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

  // Chat DOM Elements
  const chatToggleBtn        = document.getElementById('chat-toggle-btn');
  const chatDrawer           = document.getElementById('chat-drawer');
  const chatCloseBtn         = document.getElementById('chat-close-btn');
  const chatForm             = document.getElementById('chat-form');
  const chatInput            = document.getElementById('chat-input');
  const chatMessagesEl       = document.getElementById('chat-messages');
  const chatUnreadBadge      = document.getElementById('chat-unread');
  const downloadTranscriptBtn = document.getElementById('download-transcript-btn');

  // ── Chat State ───────────────────────────────────────────────────────────
  let currentRoomId = null;
  let chatHistory = [];
  let unreadCount = 0;
  let isChatOpen = false;

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

  // Helper to detect mobile/tablet (iOS, iPadOS, Android)
  function isMobileOrTablet() {
    return /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) || 
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // Multi-tier screen capture fallback for Cross-Platform compatibility (Windows, Mac, iPad, iPhone, Android)
  async function requestScreenCapture() {
    // Check if mediaDevices API is available (requires HTTPS or localhost)
    if (!navigator.mediaDevices) {
      throw new Error('Media capture requires a secure HTTPS connection or localhost.');
    }

    const isMobile = isMobileOrTablet();

    // 1. If getDisplayMedia is supported:
    if (navigator.mediaDevices.getDisplayMedia) {
      if (isMobile) {
        // Mobile / iPad Safari / Android: Do NOT pass audio or desktop-specific constraints
        try {
          return await navigator.mediaDevices.getDisplayMedia({
            video: true
          });
        } catch (mobileErr) {
          console.warn('Mobile getDisplayMedia({ video: true }) failed:', mobileErr);
          if (mobileErr.name === 'NotAllowedError' || mobileErr.name === 'AbortError') {
            throw mobileErr;
          }
        }
      } else {
        // Desktop: Try with audio and browser tab hints
        try {
          return await navigator.mediaDevices.getDisplayMedia({
            video: {
              cursor: 'always',
              displaySurface: 'browser'
            },
            audio: true
          });
        } catch (desktopErr) {
          console.warn('Desktop getDisplayMedia with audio failed, falling back to clean video:', desktopErr);
          if (desktopErr.name === 'NotAllowedError' || desktopErr.name === 'AbortError') {
            throw desktopErr;
          }
          // Fallback to video only
          try {
            return await navigator.mediaDevices.getDisplayMedia({ video: true });
          } catch (fallbackErr) {
            if (fallbackErr.name === 'NotAllowedError' || fallbackErr.name === 'AbortError') {
              throw fallbackErr;
            }
          }
        }
      }
    }

    // 2. Camera feed fallback for mobile in-app browsers / devices without getDisplayMedia
    if (navigator.mediaDevices.getUserMedia) {
      const wantCamera = confirm('Native screen sharing is not supported in this mobile browser. Would you like to share your camera feed instead?');
      if (wantCamera) {
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: true
        });
      }
    }

    throw new Error('Screen sharing is not supported in this browser. Please open in Safari (iOS/iPad) or Chrome (Android).');
  }

  // ── Start Sharing ────────────────────────────────────────────────────────
  startBtn.addEventListener('click', async () => {
    try {
      // CRITICAL FOR SAFARI / IPAD / MOBILE:
      // Must request getDisplayMedia synchronously in the click call stack WITHOUT prior await
      // to preserve transient user activation gesture!
      const stream = await requestScreenCapture();
      localStream = stream;

      // Show preview with mobile inline autoplay compliance
      previewVideo.muted = true;
      previewVideo.playsInline = true;
      previewVideo.srcObject = localStream;
      previewVideo.play().catch(e => console.warn('Preview video play warning:', e));

      // Ensure socket is connected before emitting room creation
      if (!socket.connected) {
        showToast('Connecting to server...', '⏳');
        await ensureConnected();
      }

      // Create a room on the signaling server
      socket.emit('create-room', ({ roomId }) => {
        currentRoomId = roomId;
        const link = `${window.location.origin}/view/${roomId}`;
        shareLinkEl.value = link;

        // Switch UI to active-share state
        preShareEl.classList.add('hidden');
        activeShareEl.classList.add('visible');
        chatToggleBtn.classList.remove('hidden');

        showToast('Screen sharing live! Link generated.', '🚀');
      });

      // If user clicks the browser-native "Stop sharing" button
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          stopSharing();
        });
      }

    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
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
      candidateQueues.set(viewerId, []);

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

      // Log & manage connection state transitions gracefully
      let failTimer = null;

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`📡 Peer ${viewerId} connection state: ${state}`);
        if (state === 'connected') {
          console.log(`✨ Connected to viewer ${viewerId} successfully!`);
          if (failTimer) {
            clearTimeout(failTimer);
            failTimer = null;
          }
        } else if (state === 'connecting') {
          if (failTimer) {
            clearTimeout(failTimer);
            failTimer = null;
          }
        } else if (state === 'failed') {
          if (!failTimer) {
            failTimer = setTimeout(() => {
              if (pc.connectionState === 'failed') {
                console.warn(`Connection failed with ${viewerId}, closing.`);
                pc.close();
                peerConnections.delete(viewerId);
                candidateQueues.delete(viewerId);
              }
            }, 6000);
          }
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

        // Flush any buffered ICE candidates that arrived before the answer
        const queue = candidateQueues.get(senderId) || [];
        while (queue.length > 0) {
          const candidate = queue.shift();
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.warn('Buffered candidate error:', e);
          }
        }
      } catch (err) {
        console.error(`Failed to set answer from ${senderId}:`, err);
      }
    }
  });

  // ── Receive ICE Candidate from Viewer ────────────────────────────────────
  socket.on('ice-candidate', async ({ senderId, candidate }) => {
    if (!candidate) return;
    const pc = peerConnections.get(senderId);

    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(`ICE candidate error from ${senderId}:`, err);
      }
    } else {
      // Buffer until remote answer is applied
      if (!candidateQueues.has(senderId)) {
        candidateQueues.set(senderId, []);
      }
      candidateQueues.get(senderId).push(candidate);
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

  // ── Real-Time Chat System ─────────────────────────────────────────────────
  socket.on('chat-message', (data) => {
    chatHistory.push(data);
    appendChatMessage(data);

    if (!isChatOpen) {
      unreadCount++;
      chatUnreadBadge.textContent = unreadCount;
      chatUnreadBadge.classList.remove('hidden');
    }
  });

  function appendChatMessage(data) {
    const isSelf = data.senderId === socket.id;

    // Remove empty state placeholder if present
    const emptyEl = chatMessagesEl.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    const msgEl = document.createElement('div');
    msgEl.className = `msg-item ${isSelf ? 'msg-self' : 'msg-other'}`;

    const isHost = data.role === 'presenter';
    const senderDisplay = isSelf ? 'You (Host)' : (isHost ? 'Host' : (data.senderName || 'Viewer'));

    msgEl.innerHTML = `
      <div class="msg-meta">
        <span class="msg-sender ${isHost ? 'host-tag' : ''}">${escapeHTML(senderDisplay)}</span>
        <span class="msg-time">${data.timestamp}</span>
      </div>
      <div class="msg-bubble">${escapeHTML(data.message)}</div>
    `;

    chatMessagesEl.appendChild(msgEl);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  // Send message
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !socket.connected) return;

    socket.emit('send-chat', {
      message: text,
      senderName: 'Host (Presenter)'
    });

    chatInput.value = '';
    chatInput.focus();
  });

  // Toggle chat drawer
  chatToggleBtn.addEventListener('click', () => {
    isChatOpen = !isChatOpen;
    if (isChatOpen) {
      chatDrawer.classList.remove('hidden');
      unreadCount = 0;
      chatUnreadBadge.textContent = '0';
      chatUnreadBadge.classList.add('hidden');
      chatInput.focus();
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    } else {
      chatDrawer.classList.add('hidden');
    }
  });

  chatCloseBtn.addEventListener('click', () => {
    isChatOpen = false;
    chatDrawer.classList.add('hidden');
  });

  // ── Download Chat Transcript ──────────────────────────────────────────────
  downloadTranscriptBtn.addEventListener('click', () => {
    downloadChatTranscript();
  });

  function downloadChatTranscript() {
    if (chatHistory.length === 0) {
      showToast('No messages in chat history to export.', 'ℹ️');
      return;
    }

    const roomId = currentRoomId || 'session';
    const timestampStr = new Date().toLocaleString();

    let content = `====================================================\n`;
    content += `InstaScreen Live Chat Transcript\n`;
    content += `Room ID: ${roomId}\n`;
    content += `Exported: ${timestampStr}\n`;
    content += `Total Messages: ${chatHistory.length}\n`;
    content += `====================================================\n\n`;

    chatHistory.forEach((msg) => {
      const sender = msg.role === 'presenter' ? `${msg.senderName} [Host]` : msg.senderName;
      content += `[${msg.timestamp}] ${sender}: ${msg.message}\n`;
    });

    content += `\n====================================================\n`;
    content += `End of Transcript - Generated by InstaScreen\n`;

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `instascreen-transcript-${roomId}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('Chat transcript downloaded!', '📥');
  }

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
    );
  }

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
    chatToggleBtn.classList.add('hidden');
    chatDrawer.classList.add('hidden');
    isChatOpen = false;
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
