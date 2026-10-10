/* ═══════════════════════════════════════════════════════════════════════════
   Voice — Real-time group audio (mesh) shared by presenter & viewer pages
   Every participant in a room holds one audio-only RTCPeerConnection to every
   other participant. These are separate from the screen-share connection.

   - Newcomers always send the offer (server hands them the current peer list),
     so two peers never offer to each other at the same time.
   - Each connection is negotiated once with a sendrecv audio transceiver. The
     mic track is attached with replaceTrack() whenever it becomes available —
     no renegotiation needed.
   - Mute/unmute toggles track.enabled, so the browser never re-prompts.
   ═══════════════════════════════════════════════════════════════════════════ */

// Fetch optional TURN servers configured on the server (TURN_URLS etc.) and
// append them to the given ICE config. Resolves even if the request fails,
// so callers fall back to STUN-only.
window.loadIceServers = function loadIceServers(iceConfig) {
  if (!iceConfig.__loading) {
    iceConfig.__loading = fetch('/api/ice-servers')
      .then(r => (r.ok ? r.json() : { iceServers: [] }))
      .then(({ iceServers }) => {
        if (Array.isArray(iceServers)) iceConfig.iceServers.push(...iceServers);
      })
      .catch(() => {});
  }
  return iceConfig.__loading;
};

window.createVoiceChat = function createVoiceChat({ socket, iceConfig, micButton, onError }) {
  const peers = new Map();             // peerId → { pc, sender, audioEl, candidates: [] }
  const earlyCandidates = new Map();   // peerId → candidates that arrived before the offer
  let micStream = null;
  let micState = 'off';                // 'off' | 'on' | 'muted' | 'blocked'
  let autoJoinTried = false;

  function micTrack() {
    return micStream ? micStream.getAudioTracks()[0] : null;
  }

  // The offerer adds the audio transceiver up front; the answerer adopts the
  // one created by the remote offer (see attachSender) — adding its own would
  // leave a second, unused transceiver and the answer would be recvonly.
  function createPeer(peerId, isOfferer) {
    closePeer(peerId);

    const pc = new RTCPeerConnection(iceConfig);

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.dataset.voicePeer = peerId;
    document.body.appendChild(audioEl);

    const peer = { pc, sender: null, audioEl, candidates: earlyCandidates.get(peerId) || [] };
    earlyCandidates.delete(peerId);
    peers.set(peerId, peer);
    if (isOfferer) attachSender(peer, pc.addTransceiver('audio', { direction: 'sendrecv' }));

    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0] || new MediaStream([event.track]);
      audioEl.play().catch(() => {
        // Autoplay blocked — resumeAudio() retries on the next user gesture
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('voice-ice', { targetId: peerId, candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`🎙 Voice peer ${peerId}: ${pc.connectionState}`);
    };

    return peer;
  }

  function attachSender(peer, transceiver) {
    transceiver.direction = 'sendrecv';
    peer.sender = transceiver.sender;
    if (micTrack()) peer.sender.replaceTrack(micTrack()).catch(() => {});
  }

  async function flushCandidates(peer) {
    while (peer.candidates.length > 0) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(peer.candidates.shift()));
      } catch (e) {
        console.warn('Voice buffered candidate error:', e);
      }
    }
  }

  function closePeer(peerId) {
    earlyCandidates.delete(peerId);
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.audioEl.srcObject = null;
    peer.audioEl.remove();
    peers.delete(peerId);
  }

  // ── Called by the page after joining a room: offer to everyone already there
  async function connectTo(peerIds) {
    await window.loadIceServers(iceConfig);
    for (const peerId of peerIds) {
      if (peerId === socket.id) continue;
      try {
        const peer = createPeer(peerId, true);
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        socket.emit('voice-offer', { targetId: peerId, offer: peer.pc.localDescription });
      } catch (err) {
        console.error(`Voice offer to ${peerId} failed:`, err);
      }
    }
  }

  // ── Signaling ────────────────────────────────────────────────────────────
  socket.on('voice-offer', async ({ senderId, offer }) => {
    try {
      await window.loadIceServers(iceConfig);
      const peer = createPeer(senderId, false);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
      attachSender(peer, peer.pc.getTransceivers()[0]);
      await flushCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('voice-answer', { targetId: senderId, answer: peer.pc.localDescription });
    } catch (err) {
      console.error(`Voice answer to ${senderId} failed:`, err);
    }
  });

  socket.on('voice-answer', async ({ senderId, answer }) => {
    const peer = peers.get(senderId);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushCandidates(peer);
    } catch (err) {
      console.error(`Voice answer from ${senderId} failed:`, err);
    }
  });

  socket.on('voice-ice', async ({ senderId, candidate }) => {
    if (!candidate) return;
    const peer = peers.get(senderId);
    if (peer && peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Voice ICE candidate error:', err);
      }
    } else if (peer) {
      peer.candidates.push(candidate);
    } else {
      // Offer still being processed — keep until the peer exists
      if (!earlyCandidates.has(senderId)) earlyCandidates.set(senderId, []);
      earlyCandidates.get(senderId).push(candidate);
    }
  });

  socket.on('participant-left', ({ participantId }) => {
    closePeer(participantId);
  });

  // ── Microphone ───────────────────────────────────────────────────────────
  async function acquireMic() {
    if (micStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access requires a secure HTTPS connection.');
    }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const track = micTrack();
    await Promise.all([...peers.values()].map(p => p.sender && p.sender.replaceTrack(track).catch(() => {})));
  }

  async function setMic(enabled) {
    if (enabled) await acquireMic();
    const track = micTrack();
    if (track) track.enabled = enabled;
    micState = enabled ? 'on' : (track ? 'muted' : 'off');
    resumeAudio();
    renderMicButton();
  }

  function toggleMic() {
    return setMic(micState !== 'on');
  }

  function micErrorMessage(err) {
    return err.name === 'NotAllowedError'
      ? 'Microphone is blocked. Allow mic access in your browser (address bar → site settings) to talk.'
      : (err.message || 'Could not access the microphone.');
  }

  // Turn the mic on as soon as someone joins. If permission is refused they
  // stay in the room as a listener and can retry with the button.
  async function autoJoin() {
    // Only once per page — a socket reconnect must not unmute someone who muted
    if (autoJoinTried) return;
    autoJoinTried = true;
    try {
      await setMic(true);
    } catch (err) {
      console.warn('Auto-join voice failed:', err);
      micState = 'blocked';
      renderMicButton();
    }
  }

  // ── Mic button UI ────────────────────────────────────────────────────────
  const MIC_UI = {
    off:     { icon: '🎙️', label: 'Join Voice',  title: 'Turn microphone on' },
    on:      { icon: '🎙️', label: 'Mic On',      title: 'Mute microphone (M)' },
    muted:   { icon: '🔇', label: 'Muted',       title: 'Unmute microphone (M)' },
    blocked: { icon: '🚫', label: 'Mic Blocked', title: 'Microphone permission was denied — click to retry' }
  };

  function renderMicButton() {
    if (!micButton) return;
    const ui = MIC_UI[micState];
    micButton.classList.toggle('mic-on', micState === 'on');
    micButton.classList.toggle('mic-blocked', micState === 'blocked');
    micButton.title = ui.title;
    micButton.querySelector('.mic-icon').textContent = ui.icon;
    micButton.querySelector('.mic-label').textContent = ui.label;
  }

  async function onMicButton() {
    if (!micButton || micButton.disabled) return;
    micButton.disabled = true;
    try {
      await toggleMic();
    } catch (err) {
      console.error('Microphone error:', err);
      micState = 'blocked';
      renderMicButton();
      if (onError) onError(micErrorMessage(err));
    } finally {
      micButton.disabled = false;
    }
  }

  if (micButton) {
    micButton.addEventListener('click', onMicButton);

    // Keyboard shortcut: M toggles the mic (ignored while typing in chat)
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (micButton.classList.contains('hidden')) return;
      onMicButton();
    });
  }

  // Retry playback of any remote audio blocked by autoplay policy
  function resumeAudio() {
    peers.forEach(p => {
      if (p.audioEl.srcObject && p.audioEl.paused) p.audioEl.play().catch(() => {});
    });
  }
  document.addEventListener('click', resumeAudio);
  document.addEventListener('touchend', resumeAudio);

  function show() {
    if (micButton) micButton.classList.remove('hidden');
  }

  function closeAll() {
    [...peers.keys()].forEach(closePeer);
    // Release the device so the browser's "mic in use" indicator turns off
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    micState = 'off';
    autoJoinTried = false; // a new session (e.g. presenter shares again) auto-joins again
    renderMicButton();
    if (micButton) micButton.classList.add('hidden');
  }

  return { connectTo, autoJoin, show, closeAll };
};
