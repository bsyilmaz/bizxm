// BizXM Signaling Server for WebRTC
// For hosting on Glitch.com
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Create Express app
const app = express();
app.use(cors());

// Create HTTP server
const server = http.createServer(app);

// Set up Socket.IO with CORS enabled
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Store room data
const rooms = new Map();

// Root route to verify server is running
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>BizXM Signaling Server</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
          }
          h1 { color: #4f46e5; }
          .card {
            background: #f9f9f9;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          code {
            background: #eee;
            padding: 2px 5px;
            border-radius: 4px;
          }
          .rooms {
            margin-top: 20px;
          }
        </style>
      </head>
      <body>
        <h1>BizXM Signaling Server</h1>
        <div class="card">
          <p>✅ Server is running!</p>
          <p>This server handles WebRTC signaling for BizXM application. It doesn't serve any UI components.</p>
          <p>Active rooms: ${rooms.size}</p>
          <p>Server time: ${new Date().toISOString()}</p>
        </div>
        <div class="card">
          <h2>Usage</h2>
          <p>In your BizXM app, set the signaling server URL to:</p>
          <code>${req.protocol}://${req.get('host')}</code>
        </div>
      </body>
    </html>
  `);
});

// Status route for monitoring
app.get('/status', (req, res) => {
  const roomsInfo = [];
  
  rooms.forEach((room, roomId) => {
    roomsInfo.push({
      id: roomId,
      participants: room.participants.size,
      hasPassword: !!room.password,
      host: room.host
    });
  });
  
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeRooms: rooms.size,
    timestamp: new Date().toISOString(),
    rooms: roomsInfo
  });
});

// Socket.io connection logic
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Create a new room
  socket.on('create-room', ({ username, password }, callback) => {
    try {
      // Generate a random room ID
      const roomId = Math.random().toString(16).substring(2, 10);
      
      // Create the room with the user as host
      rooms.set(roomId, {
        host: socket.id,
        password: password || null,
        participants: new Map([[socket.id, { username, isHost: true }]]),
        lastActivity: Date.now(),
        screenSharing: false
      });
      
      // Join the socket to the room
      socket.join(roomId);
      socket.room = roomId;
      
      // Send back the room info
      callback({
        success: true,
        roomId,
        isHost: true
      });
      
      console.log(`Room created: ${roomId} by ${username}`);
    } catch (error) {
      console.error('Error creating room:', error);
      callback({ success: false, error: 'Server error creating room' });
    }
  });
  
  // Join an existing room
  socket.on('join-room', ({ roomId, username, password }, callback) => {
    try {
      const room = rooms.get(roomId);
      
      // Check if the room exists
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }
      
      // Check if password matches
      if (room.password && room.password !== password) {
        return callback({ success: false, error: 'Incorrect password' });
      }
      
      // Update room activity
      room.lastActivity = Date.now();
      
      // Join the socket to the room
      socket.join(roomId);
      socket.room = roomId;
      
      // Add user to the participants list
      room.participants.set(socket.id, { 
        username, 
        isHost: false 
      });
      
      // Get all participants for the room
      const participants = Array.from(room.participants).map(([id, data]) => ({
        id,
        username: data.username,
        isHost: id === room.host
      }));
      
      // Notify everyone in the room about the new participant
      socket.to(roomId).emit('user-joined', { userId: socket.id, username });
      
      // Send back the room info
      callback({
        success: true,
        roomId,
        isHost: socket.id === room.host,
        participants,
        screenSharing: room.screenSharing
      });
      
      console.log(`User ${username} joined room: ${roomId}`);
    } catch (error) {
      console.error('Error joining room:', error);
      callback({ success: false, error: 'Server error joining room' });
    }
  });
  
  // Signal exchange
  socket.on('signal', ({ to, signal }) => {
    if (socket.room) {
      const room = rooms.get(socket.room);
      if (room && room.participants.has(socket.id)) {
        const participant = room.participants.get(socket.id);
        if (participant) {
          room.lastActivity = Date.now();
          io.to(to).emit('signal', { 
            from: socket.id, 
            username: participant.username, 
            signal 
          });
        }
      }
    }
  });
  
  // Mute/unmute update
  socket.on('mute-update', ({ muted }) => {
    if (socket.room) {
      const room = rooms.get(socket.room);
      if (room) {
        room.lastActivity = Date.now();
        socket.to(socket.room).emit('user-mute-update', { userId: socket.id, muted });
      }
    }
  });
  
  // Screen sharing update
  socket.on('screen-sharing', ({ active }) => {
    if (socket.room) {
      const room = rooms.get(socket.room);
      if (room && room.participants.has(socket.id)) {
        const participant = room.participants.get(socket.id);
        if (participant) {
          room.screenSharing = active;
          room.lastActivity = Date.now();
          socket.to(socket.room).emit('screen-sharing-update', { 
            userId: socket.id, 
            username: participant.username, 
            active 
          });
        }
      }
    }
  });
  
  // Leave room
  socket.on('leave-room', () => {
    handleDisconnect();
  });
  
  // Heartbeat to keep the room active
  socket.on('heartbeat', () => {
    if (socket.room && rooms.has(socket.room)) {
      rooms.get(socket.room).lastActivity = Date.now();
    }
  });
  
  // Disconnection
  socket.on('disconnect', () => {
    handleDisconnect();
  });
  
  // Helper function to handle disconnection/leaving
  function handleDisconnect() {
    if (socket.room) {
      const room = rooms.get(socket.room);
      if (room) {
        // Get the user's info before removing them
        const userData = room.participants.get(socket.id);
        
        // Remove user from participants
        room.participants.delete(socket.id);
        
        // Notify others about the user leaving
        if (userData) {
          socket.to(socket.room).emit('user-left', { userId: socket.id, username: userData.username });
          console.log(`User ${userData.username} left room: ${socket.room}`);
        }
        
        // Check if the room is empty
        if (room.participants.size === 0) {
          // Delete the room if it's empty
          rooms.delete(socket.room);
          console.log(`Room deleted: ${socket.room} (empty)`);
        }
        // Or if the host left
        else if (socket.id === room.host) {
          // Notify everyone and close the room
          socket.to(socket.room).emit('room-closed', { reason: 'Host left the room' });
          rooms.delete(socket.room);
          console.log(`Room deleted: ${socket.room} (host left)`);
        }
      }
      
      // Leave the room
      socket.leave(socket.room);
      socket.room = null;
    }
  }
});

// Cleanup inactive rooms every hour
setInterval(() => {
  const now = Date.now();
  const inactiveTime = 60 * 60 * 1000; // 1 hour
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.lastActivity && now - room.lastActivity > inactiveTime) {
      // Notify all participants
      io.to(roomId).emit('room-closed', { reason: 'Room closed due to inactivity' });
      
      // Remove all participants from the room
      for (const participantId of room.participants.keys()) {
        const socket = io.sockets.sockets.get(participantId);
        if (socket) {
          socket.leave(roomId);
          socket.room = null;
        }
      }
      
      // Delete the room
      rooms.delete(roomId);
      console.log(`Room deleted: ${roomId} (inactive)`);
    }
  }
}, 60 * 60 * 1000); // 1 hour

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});

// Log startup information
console.log(`Server starting up at ${new Date().toISOString()}`);
console.log(`Node.js version: ${process.version}`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

// Handle process termination
process.on('SIGINT', () => {
  console.log('Shutting down signaling server');
  server.close(() => {
    process.exit(0);
  });
}); 