const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Health check endpoint for Render / cloud load balancers
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Route for viewer page — serves view.html for any /view/:roomId URL
app.get('/view/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

// ─── Room Management ───────────────────────────────────────────────────────────

const rooms = new Map();
// rooms: Map<roomId, { presenterId, viewers: Set<socketId> }>

io.on('connection', (socket) => {
  console.log(`✦ Client connected: ${socket.id}`);

  // ── Presenter creates a new room ──────────────────────────────────────────
  socket.on('create-room', (callback) => {
    const roomId = uuidv4().split('-')[0]; // Short 8-char ID
    rooms.set(roomId, {
      presenterId: socket.id,
      viewers: new Set()
    });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = 'presenter';
    console.log(`📺 Room created: ${roomId} by presenter ${socket.id}`);
    callback({ roomId });
  });

  // ── Viewer joins an existing room ─────────────────────────────────────────
  socket.on('join-room', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ error: 'Room not found. The sharing session may have ended.' });
      return;
    }
    room.viewers.add(socket.id);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = 'viewer';

    // Tell the presenter a new viewer arrived so it can create a peer connection
    io.to(room.presenterId).emit('viewer-joined', {
      viewerId: socket.id,
      viewerCount: room.viewers.size
    });

    console.log(`👁 Viewer ${socket.id} joined room ${roomId} (${room.viewers.size} viewers)`);
    callback({ success: true });
  });

  // ── WebRTC Signaling Relay ────────────────────────────────────────────────

  socket.on('offer', ({ targetId, offer }) => {
    io.to(targetId).emit('offer', { senderId: socket.id, offer });
  });

  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', { senderId: socket.id, answer });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', { senderId: socket.id, candidate });
  });

  // ── Presenter stops sharing ───────────────────────────────────────────────
  socket.on('stop-sharing', () => {
    const roomId = socket.roomId;
    if (roomId && rooms.has(roomId)) {
      io.to(roomId).emit('sharing-stopped');
      rooms.delete(roomId);
      console.log(`🛑 Room ${roomId} closed by presenter`);
    }
  });

  // ── Handle disconnects ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) {
      console.log(`✦ Client disconnected: ${socket.id}`);
      return;
    }

    const room = rooms.get(roomId);

    if (socket.role === 'presenter') {
      // Presenter left — notify all viewers and destroy the room
      io.to(roomId).emit('sharing-stopped');
      rooms.delete(roomId);
      console.log(`📺 Presenter disconnected → room ${roomId} destroyed`);
    } else if (socket.role === 'viewer') {
      room.viewers.delete(socket.id);
      // Tell presenter about the updated count
      io.to(room.presenterId).emit('viewer-left', {
        viewerId: socket.id,
        viewerCount: room.viewers.size
      });
      console.log(`👁 Viewer left room ${roomId} (${room.viewers.size} remaining)`);
    }
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🖥  Screen Share Server is running         ║');
  console.log(`║   🌐  http://localhost:${PORT}                  ║`);
  console.log('║   📺  Share your screen & send the link!     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
