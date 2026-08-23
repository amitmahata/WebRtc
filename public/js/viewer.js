/* ═══════════════════════════════════════════════════════════════════════════
   Viewer — Receive & Display Shared Screen via WebRTC
   Handles: join room, receive offer, create answer, display remote stream
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
    console.log('✅ Viewer connected to signaling server:', socket.id);
    if (roomId) {
      joinRoom(roomId);
    }
  });

  socket.on('connect_error', (err) => {
    console.warn('⚠️ Viewer socket connection error:', err);
  });

  // ── State ────────────────────────────────────────────────────────────────
  let peerConnection = null;
  let remoteStream = null;
  let hasAudio = false;
  const candidateQueue = [];

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
  const connectingEl    = document.getElementById('connecting');
  const endedEl         = document.getElementById('ended');
  const streamContainer = document.getElementById('stream-container');
  const viewerVideo     = document.getElementById('viewer-video');
  const statusText      = document.getElementById('status-text');
  const fullscreenBtn   = document.getElementById('fullscreen-btn');
  const unmuteBanner    = document.getElementById('unmute-banner');
  const unmuteBtn       = document.getElementById('unmute-btn');
  const muteToggleBtn   = document.getElementById('mute-toggle-btn');
  const chatControlBtn  = document.getElementById('chat-control-btn');
  const chatToggleBtn   = document.getElementById('chat-toggle-btn');

  // Chat Drawer Elements
  const chatDrawer           = document.getElementById('chat-drawer');
  const chatCloseBtn         = document.getElementById('chat-close-btn');
  const chatForm             = document.getElementById('chat-form');
  const chatInput            = document.getElementById('chat-input');
  const chatMessagesEl       = document.getElementById('chat-messages');
  const chatUnreadBadge      = document.getElementById('chat-unread');
  const downloadTranscriptBtn = document.getElementById('download-transcript-btn');

  // ── Chat State ───────────────────────────────────────────────────────────
  let chatHistory = [];
  let unreadCount = 0;
  let isChatOpen = false;
  const viewerNick = sessionStorage.getItem('instascreen_nick') || `Viewer-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  sessionStorage.setItem('instascreen_nick', viewerNick);

  // ── Extract Room ID from URL ─────────────────────────────────────────────
  const pathParts = window.location.pathname.split('/view/');
  const roomId = pathParts.length > 1 ? pathParts[1].replace(/\//g, '') : null;

  if (!roomId) {
    showError('Invalid link. No room ID found in the URL.');
  }

  // ── Join Room ────────────────────────────────────────────────────
  function joinRoom(id) {
    statusText.textContent = 'Joining the screen sharing session...';

    socket.emit('join-room', id, (response) => {
      if (response && response.error) {
        showError(response.error);
        return;
      }
      statusText.textContent = 'Connected to room! Establishing peer stream...';
      if (chatToggleBtn) chatToggleBtn.classList.remove('hidden');
    });
  }

  // ── Receive Offer from Presenter ─────────────────────────────────────────
  socket.on('offer', async ({ senderId, offer }) => {
    try {
      peerConnection = new RTCPeerConnection(ICE_CONFIG);

      // Create a fresh MediaStream to accumulate tracks
      remoteStream = new MediaStream();
      viewerVideo.srcObject = remoteStream;

      // When remote track arrives, add it to our stream
      peerConnection.ontrack = (event) => {
        console.log(`Received track: kind=${event.track.kind}, id=${event.track.id}`);

        // Add the track to our combined stream
        remoteStream.addTrack(event.track);

        if (event.track.kind === 'audio') {
          hasAudio = true;
        }

        // Show the stream container
        connectingEl.classList.add('hidden');
        endedEl.classList.add('hidden');
        streamContainer.classList.remove('hidden');
        if (chatToggleBtn) chatToggleBtn.classList.remove('hidden');

        // Force play (video starts muted for autoplay compliance)
        viewerVideo.play().then(() => {
          console.log('Video playback started successfully');
          if (hasAudio) {
            unmuteBanner.classList.remove('hidden');
            muteToggleBtn.textContent = '🔇';
          }
        }).catch(err => {
          console.error('Autoplay failed:', err);
          unmuteBanner.classList.remove('hidden');
          unmuteBtn.textContent = '▶ Click to Play';
        });

        // Update page title
        document.title = 'ScreenCast — Live Stream';

        event.track.onended = () => {
          console.log(`Track ended: ${event.track.kind}`);
        };
      };

      // Send ICE candidates to the presenter
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            targetId: senderId,
            candidate: event.candidate
          });
        }
      };

      // Log & manage connection state transitions gracefully
      let failTimer = null;

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        console.log(`📡 Peer connection state: ${state}`);

        if (state === 'connected') {
          console.log('✨ WebRTC connection established successfully!');
          if (failTimer) {
            clearTimeout(failTimer);
            failTimer = null;
          }
          // Ensure video view is shown and error/loading states are hidden
          connectingEl.classList.add('hidden');
          endedEl.classList.add('hidden');
          streamContainer.classList.remove('hidden');
        } else if (state === 'connecting') {
          if (failTimer) {
            clearTimeout(failTimer);
            failTimer = null;
          }
        } else if (state === 'failed') {
          // Give candidates a 6-second grace window to negotiate or recover
          if (!failTimer) {
            failTimer = setTimeout(() => {
              if (peerConnection && peerConnection.connectionState === 'failed') {
                showError('Connection failed across networks. Please refresh to retry.');
              }
            }, 6000);
          }
        } else if (state === 'disconnected') {
          console.log('Peer disconnected, waiting for reconnection...');
        }
      };

      // Set remote description (the offer) and create an answer
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

      // Process any buffered ICE candidates that arrived before the offer description was set
      while (candidateQueue.length > 0) {
        const cand = candidateQueue.shift();
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.warn('Buffered candidate error:', e);
        }
      }

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      // Send answer back to presenter
      socket.emit('answer', {
        targetId: senderId,
        answer: peerConnection.localDescription
      });

    } catch (err) {
      console.error('Error handling offer:', err);
      showError('Failed to connect to the stream. Please try refreshing the page.');
    }
  });

  // ── Receive ICE Candidate from Presenter ─────────────────────────────────
  socket.on('ice-candidate', async ({ senderId, candidate }) => {
    if (!candidate) return;

    if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('ICE candidate error:', err);
      }
    } else {
      // Buffer candidate until remote description is set
      candidateQueue.push(candidate);
    }
  });

  // ── Real-Time Chat System ─────────────────────────────────────────────────
  socket.on('chat-message', (data) => {
    chatHistory.push(data);
    appendChatMessage(data);

    if (!isChatOpen) {
      unreadCount++;
      if (chatUnreadBadge) {
        chatUnreadBadge.textContent = unreadCount;
        chatUnreadBadge.classList.remove('hidden');
      }
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
    const senderDisplay = isSelf ? `You (${viewerNick})` : (isHost ? 'Host' : (data.senderName || 'Viewer'));

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
      senderName: viewerNick
    });

    chatInput.value = '';
    chatInput.focus();
  });

  // Toggle chat
  function toggleChat() {
    isChatOpen = !isChatOpen;
    if (isChatOpen) {
      chatDrawer.classList.remove('hidden');
      unreadCount = 0;
      if (chatUnreadBadge) {
        chatUnreadBadge.textContent = '0';
        chatUnreadBadge.classList.add('hidden');
      }
      chatInput.focus();
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    } else {
      chatDrawer.classList.add('hidden');
    }
  }

  if (chatControlBtn) chatControlBtn.addEventListener('click', toggleChat);
  if (chatToggleBtn) chatToggleBtn.addEventListener('click', toggleChat);

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
      alert('No messages in chat history to export.');
      return;
    }

    const currentRoom = roomId || 'session';
    const timestampStr = new Date().toLocaleString();

    let content = `====================================================\n`;
    content += `InstaScreen Live Chat Transcript\n`;
    content += `Room ID: ${currentRoom}\n`;
    content += `Participant: ${viewerNick} (Viewer)\n`;
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
    a.download = `instascreen-transcript-${currentRoom}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

  // ── Stream Stopped ───────────────────────────────────────────────────────
  socket.on('sharing-stopped', () => {
    streamContainer.classList.add('hidden');
    connectingEl.classList.add('hidden');
    unmuteBanner.classList.add('hidden');
    endedEl.classList.remove('hidden');

    document.title = 'ScreenCast — Stream Ended';

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    remoteStream = null;
  });

  // ── Unmute / Mute Controls ───────────────────────────────────────────────
  unmuteBtn.addEventListener('click', () => {
    viewerVideo.muted = false;
    viewerVideo.play().catch(() => {});
    unmuteBanner.classList.add('hidden');
    muteToggleBtn.textContent = '🔊';
  });

  muteToggleBtn.addEventListener('click', () => {
    viewerVideo.muted = !viewerVideo.muted;
    muteToggleBtn.textContent = viewerVideo.muted ? '🔇' : '🔊';
  });

  // ── Fullscreen Toggle ────────────────────────────────────────────────────
  fullscreenBtn.addEventListener('click', () => {
    const target = streamContainer;
    if (!document.fullscreenElement) {
      if (target.requestFullscreen) {
        target.requestFullscreen();
      } else if (target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
      } else if (target.msRequestFullscreen) {
        target.msRequestFullscreen();
      }
    } else {
      document.exitFullscreen();
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────
  function showError(message) {
    connectingEl.classList.add('hidden');
    streamContainer.classList.add('hidden');
    unmuteBanner.classList.add('hidden');
    endedEl.classList.remove('hidden');

    const endedHeading = endedEl.querySelector('h2');
    const endedText = endedEl.querySelector('p');

    if (endedHeading) endedHeading.textContent = 'Unable to Connect';
    if (endedText) endedText.textContent = message;
  }

})();
