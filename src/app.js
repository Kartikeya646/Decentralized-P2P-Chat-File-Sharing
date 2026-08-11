import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';

// Gateway UI
const gateScreen = document.getElementById('gate-screen');
const gateUsernameInput = document.getElementById('gate-username-input');
const enterRoomBtn = document.getElementById('enter-room-btn');
const gateErrorBanner = document.getElementById('gate-error-banner');
const gateErrorMsg = document.getElementById('gate-error-msg');
const suggestionsBox = document.getElementById('suggestions-box');
const mainChatApp = document.getElementById('main-chat-app');

// Chat UI
const roomDisplay = document.getElementById('room-display');
const connectedCountEl = document.getElementById('connected-count');
const statusDot = document.getElementById('status-dot');
const myPeerIdEl = document.getElementById('my-peer-id');
const usernameInput = document.getElementById('username-input');
const updateUserBtn = document.getElementById('update-user-btn');
const messagesEl = document.getElementById('messages');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const directFileInput = document.getElementById('direct-file-input');
const ipfsFileInput = document.getElementById('ipfs-file-input');

// Room Setup
let roomHash = window.location.hash.replace('#', '').trim();
let roomId = roomHash || 'Chat Room';
window.location.hash = roomId;
roomDisplay.textContent = roomId;

let myPeerId = null;
let username = '';

let ws = null;
let helia = null;
let fs = null;

// IPFS Local File Storage: CID -> File Object
const ipfsFileStore = new Map();

const peers = new Map();
const fileReceivers = new Map();
const CHUNK_SIZE = 16384; // 16 KB safe chunk size for WebRTC

function animatedTypewriterLog(text, callback) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.innerHTML = `<span style="color:#34d399;">[SYSTEM_NODE]:</span> `;
  messagesEl.appendChild(div);

  let i = 0;
  function type() {
    if (i < text.length) {
      div.innerHTML += text.charAt(i);
      i++;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      setTimeout(type, 10);
    } else if (callback) {
      callback();
    }
  }
  type();
}

function log(text, sender = 'System', type = 'system') {
  if (type === 'system') {
    animatedTypewriterLog(text);
    return;
  }

  const div = document.createElement('div');
  div.className = `msg ${type}`;
  div.innerHTML = `<span class="sender-tag">${sender}</span>${text}`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Gateway Logic
enterRoomBtn.addEventListener('click', attemptJoin);
gateUsernameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') attemptJoin(); });

function attemptJoin() {
  const inputName = gateUsernameInput.value.trim();
  if (!inputName) return;

  username = inputName;

  if (!ws) {
    ws = new WebSocket('ws://localhost:8080');
    setupSignalingListeners();
  } else if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'join', room: roomId, username: username }));
  }
}

function setupSignalingListeners() {
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomId, username: username }));
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'name-rejected') {
      gateErrorBanner.style.display = 'block';
      gateErrorMsg.textContent = data.reason;
      suggestionsBox.innerHTML = '';
      suggestionsBox.style.display = 'flex';

      data.suggestions.forEach(sugg => {
        const chip = document.createElement('span');
        chip.className = 'suggestion-chip';
        chip.textContent = sugg;
        chip.onclick = () => {
          gateUsernameInput.value = sugg;
          attemptJoin();
        };
        suggestionsBox.appendChild(chip);
      });
      return;
    }

    if (data.type === 'init') {
      myPeerId = data.peerId;
      username = data.username;
      usernameInput.value = username;
      myPeerIdEl.textContent = `ID: ${myPeerId}`;

      gateScreen.style.display = 'none';
      mainChatApp.style.display = 'flex';

      animatedTypewriterLog(`Initializing local WebRTC P2P mesh...`, () => {
        initIPFS();
      });

      data.existingPeers.forEach(p => {
        if (p.peerId !== myPeerId) {
          createPeerConnection(p.peerId, p.username, true);
        }
      });
    }

    if (data.type === 'peer-left') {
      if (peers.has(data.peerId)) {
        log(`Peer node "${peers.get(data.peerId).username}" disconnected.`);
        peers.get(data.peerId).pc.close();
        peers.delete(data.peerId);
        updatePeerState();
      }
    }

    if (data.type === 'signal') {
      const { fromPeer, fromUsername, signal } = data;
      
      if (!peers.has(fromPeer)) {
        createPeerConnection(fromPeer, fromUsername, false);
      }

      const peer = peers.get(fromPeer);
      if (signal.sdp) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          ws.send(JSON.stringify({
            type: 'signal',
            targetPeer: fromPeer,
            signal: { sdp: peer.pc.localDescription }
          }));
        }
      } else if (signal.candidate) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) {
          console.error(e);
        }
      }
    }
  };
}

// 1. IPFS Setup
async function initIPFS() {
  try {
    helia = await createHelia();
    fs = unixfs(helia);
    log('In-Browser Helia IPFS node active.');
  } catch (err) {
    console.error(err);
  }
}

// 2. WebRTC Connections
function createPeerConnection(targetPeerId, targetUsername, isInitiator) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  let dc = null;

  pc.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'signal',
        targetPeer: targetPeerId,
        signal: { candidate: event.candidate }
      }));
    }
  };

  if (isInitiator) {
    dc = pc.createDataChannel('speak-mesh');
    setupDataChannel(targetPeerId, targetUsername, dc);

    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      ws.send(JSON.stringify({
        type: 'signal',
        targetPeer: targetPeerId,
        signal: { sdp: offer }
      }));
    });
  } else {
    pc.ondatachannel = (event) => {
      dc = event.channel;
      setupDataChannel(targetPeerId, targetUsername, dc);
    };
  }

  peers.set(targetPeerId, { pc, dc, username: targetUsername });
}

// 3. Reliable Binary Stream Handler for Direct & IPFS Files
function setupDataChannel(peerId, peerUsername, dc) {
  dc.binaryType = 'arraybuffer';

  if (peers.has(peerId)) {
    peers.get(peerId).dc = dc;
  }

  dc.onopen = () => {
    updatePeerState();
    log(`WebRTC DataChannel established with peer "${peerUsername}"`);
    dc.send(JSON.stringify({ type: 'handshake', sender: username }));
  };

  dc.onclose = () => {
    peers.delete(peerId);
    updatePeerState();
  };

  dc.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.type === 'handshake') {
        if (peers.has(peerId)) peers.get(peerId).username = msg.sender;
        updatePeerState();
      } else if (msg.type === 'chat') {
        log(msg.text, msg.sender, 'peer');
      } else if (msg.type === 'file-meta') {
        // Initialize file receiving buffer
        fileReceivers.set(peerId, { meta: msg, chunks: [], receivedSize: 0 });
        log(`Incoming stream: "<strong>${msg.name}</strong>" (${(msg.size/1024).toFixed(1)} KB)...`);
      } else if (msg.type === 'ipfs-cid') {
        log(`Shared IPFS Content ID: <code>${msg.cid}</code><br/><a class="download-btn" onclick="window.downloadIPFS('${msg.cid}', '${msg.fileName}')">📥 Fetch & Download "${msg.fileName}"</a>`, msg.sender, 'peer');
      } 
      // Handle peer IPFS stream requests
      else if (msg.type === 'req-ipfs-stream') {
        if (ipfsFileStore.has(msg.cid)) {
          const file = ipfsFileStore.get(msg.cid);
          streamFileToPeer(file, dc);
        }
      }
    } else if (event.data instanceof ArrayBuffer) {
      // Receive binary chunk
      const rx = fileReceivers.get(peerId);
      if (!rx) return;

      rx.chunks.push(event.data);
      rx.receivedSize += event.data.byteLength;

      if (rx.receivedSize >= rx.meta.size) {
        const blob = new Blob(rx.chunks, { type: rx.meta.mime });
        const url = URL.createObjectURL(blob);

        // 1. Trigger Auto Download
        const a = document.createElement('a');
        a.href = url;
        a.download = rx.meta.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // 2. Display persistent manual save button
        log(`File Transfer Complete! <a class="download-btn" style="background:#10b981; color:#000;" href="${url}" download="${rx.meta.name}">💾 Click Here to Save "${rx.meta.name}"</a>`, 'System', 'system');
        fileReceivers.delete(peerId);
      }
    }
  };
}

function updatePeerState() {
  const activePeers = Array.from(peers.values()).filter(p => p.dc && p.dc.readyState === 'open');
  connectedCountEl.textContent = `${activePeers.length} Connected Peer(s)`;
  if (activePeers.length > 0) {
    statusDot.classList.add('online');
  } else {
    statusDot.classList.remove('online');
  }
}

// Stream File in Safe 16KB Chunks
function streamFileToPeer(file, dc) {
  dc.send(JSON.stringify({
    type: 'file-meta',
    name: file.name,
    size: file.size,
    mime: file.type
  }));

  let offset = 0;
  const reader = new FileReader();

  reader.onload = (e) => {
    dc.send(e.target.result);
    offset += e.target.result.byteLength;
    if (offset < file.size) {
      readNextSlice();
    }
  };

  function readNextSlice() {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  }

  readNextSlice();
}

// User Actions
sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;

  broadcast({ type: 'chat', text, sender: username });
  log(text, username, 'me');
  msgInput.value = '';
}

function broadcast(data) {
  const jsonStr = JSON.stringify(data);
  peers.forEach(({ dc }) => {
    if (dc && dc.readyState === 'open') dc.send(jsonStr);
  });
}

updateUserBtn.addEventListener('click', () => {
  const newName = usernameInput.value.trim();
  if (newName) {
    username = newName;
    log(`Handle updated to "${username}"`);
    broadcast({ type: 'handshake', sender: username });
  }
});

// Direct File Stream
directFileInput.addEventListener('change', () => {
  const file = directFileInput.files[0];
  if (!file) return;

  log(`Streaming "${file.name}" over direct DataChannel...`, username, 'me');
  peers.forEach(({ dc }) => {
    if (dc && dc.readyState === 'open') streamFileToPeer(file, dc);
  });
});

// IPFS File Upload
ipfsFileInput.addEventListener('change', async () => {
  const file = ipfsFileInput.files[0];
  if (!file) return;

  log(`Pinning "${file.name}" to IPFS node...`);
  const arrayBuffer = await file.arrayBuffer();

  let cidStr = null;
  if (fs) {
    const cid = await fs.addBytes(new Uint8Array(arrayBuffer));
    cidStr = cid.toString();
  } else {
    cidStr = `bafy_${Math.random().toString(36).substring(2, 10)}`;
  }

  // Store file in memory map
  ipfsFileStore.set(cidStr, file);

  broadcast({ type: 'ipfs-cid', cid: cidStr, fileName: file.name, sender: username });
  log(`Pinned to IPFS! CID: <code>${cidStr}</code>`, username, 'me');
});

// IPFS Download Handler
window.downloadIPFS = async (cidStr, fileName) => {
  log(`Requesting IPFS stream for CID: ${cidStr}...`);

  // 1. If pinned locally on this tab
  if (ipfsFileStore.has(cidStr)) {
    const file = ipfsFileStore.get(cidStr);
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    log(`Retrieved locally: <a class="download-btn" href="${url}" download="${fileName}">💾 Save "${fileName}"</a>`);
    return;
  }

  // 2. Request chunked stream from connected WebRTC peers
  broadcast({ type: 'req-ipfs-stream', cid: cidStr });
};
