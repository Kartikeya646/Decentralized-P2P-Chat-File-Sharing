import { WebSocketServer } from 'ws';

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });
const rooms = new Map(); // room -> Map(peerId -> { ws, username })

console.log('\n==================================================');
console.log('⚡ Speak in Silence - P2P Signaling Server');
console.log(`📡 WebSocket Signaling running on: ws://localhost:${PORT}`);
console.log('🚀 Open your App in Browser:        http://localhost:5173');
console.log('==================================================\n');

wss.on('connection', (ws) => {
  let currentRoom = null;
  let peerId = Math.random().toString(36).substring(2, 9);
  let username = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        currentRoom = data.room;
        if (!rooms.has(currentRoom)) {
          rooms.set(currentRoom, new Map());
        }

        const roomPeers = rooms.get(currentRoom);
        const requestedName = (data.username || `User_${roomPeers.size + 1}`).trim();

        // Duplicate handle check
        const existingNames = Array.from(roomPeers.values()).map(p => p.username.toLowerCase());
        
        if (existingNames.includes(requestedName.toLowerCase())) {
          const suggestions = [
            `${requestedName}_${Math.floor(10 + Math.random() * 89)}`,
            `${requestedName}_X`,
            `Ghost_${requestedName}`
          ];

          ws.send(JSON.stringify({
            type: 'name-rejected',
            reason: `Username "${requestedName}" is already taken in this room.`,
            suggestions: suggestions
          }));
          return;
        }

        username = requestedName;

        // Send confirmation + existing peer list
        const existingPeersList = [];
        roomPeers.forEach((p, id) => {
          existingPeersList.push({ peerId: id, username: p.username });
        });

        ws.send(JSON.stringify({
          type: 'init',
          peerId: peerId,
          username: username,
          existingPeers: existingPeersList
        }));

        roomPeers.set(peerId, { ws, username });
        console.log(`[${currentRoom}] ${username} (${peerId}) joined. Room size: ${roomPeers.size}`);
      }

      if (data.type === 'signal') {
        const roomPeers = rooms.get(currentRoom);
        if (roomPeers && roomPeers.has(data.targetPeer)) {
          const target = roomPeers.get(data.targetPeer);
          if (target.ws.readyState === 1) {
            target.ws.send(JSON.stringify({
              type: 'signal',
              fromPeer: peerId,
              fromUsername: username,
              signal: data.signal
            }));
          }
        }
      }
    } catch (e) {
      console.error('Signaling error:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom) && peerId) {
      const roomPeers = rooms.get(currentRoom);
      roomPeers.delete(peerId);

      roomPeers.forEach((p) => {
        if (p.ws.readyState === 1) {
          p.ws.send(JSON.stringify({
            type: 'peer-left',
            peerId: peerId
          }));
        }
      });

      if (roomPeers.size === 0) rooms.delete(currentRoom);
      console.log(`Peer ${peerId} left ${currentRoom}`);
    }
  });
});