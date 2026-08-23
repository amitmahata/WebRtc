# WebRTC Screen Sharing Debugging & Analysis Guide

This guide describes how to run, debug, and analyze the signalling server and client-side WebRTC connections in this application.

---

## 1. Server-Side Debugging (Node.js / Socket.IO)

The signalling server is implemented in [server.js](file:///c:/Users/amitm/source/repos/WebRtc/server.js) using Express and Socket.IO.

### Option A: VS Code Debugger Configuration (Recommended)
To debug [server.js](file:///c:/Users/amitm/source/repos/WebRtc/server.js) directly inside VS Code:
1. Create a folder named `.vscode` in the project root.
2. Inside `.vscode`, create a `launch.json` file with the following configuration:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Signalling Server",
      "skipFiles": ["<node_internals>/**"],
      "program": "${workspaceFolder}/server.js",
      "env": {
        "PORT": "3000"
      },
      "console": "integratedTerminal"
    }
  ]
}
```
3. Open [server.js](file:///c:/Users/amitm/source/repos/WebRtc/server.js) and click in the margin to the left of the line numbers to set **breakpoints** (e.g., inside the `connection` listener or the `join-room` events).
4. Press `F5` or select **Run and Debug** -> **Debug Signalling Server** to start.

### Option B: Node Inspector via Command Line
Alternatively, you can run the server with the inspect flag:
```bash
node --inspect server.js
```
Open Chrome and navigate to `chrome://inspect`. Click **Open dedicated DevTools for Node** to debug and set breakpoints in the server code.

---

## 2. Client-Side Debugging (Presenter & Viewer)

The client code resides in:
* **Presenter UI & Logic**: [presenter.js](file:///c:/Users/amitm/source/repos/WebRtc/public/js/presenter.js)
* **Viewer UI & Logic**: [viewer.js](file:///c:/Users/amitm/source/repos/WebRtc/public/js/viewer.js)

### Browser Developer Tools
1. Open your browser (Chrome, Firefox, or Edge).
2. Press `F12` (or right-click anywhere and select **Inspect**) to open Developer Tools.

#### 🖥️ The Console Tab
* Look for socket connection logs or runtime script errors.
* The script logs the WebRTC connection state changes (e.g., `Peer <id>: connected`, `Connection state: connected`).
* Check for autoplay issues or permission errors here (e.g., if `navigator.mediaDevices.getDisplayMedia` is denied).

#### 🌐 The Network & WebSocket Tab
1. Open the **Network** tab.
2. Filter by **WS** (WebSockets) to view the Socket.IO traffic.
3. Select the socket connection (usually starts with `socket.io/?EIO=...`).
4. Click the **Messages** (or **Frames**) sub-tab. Here you will see the exact frames exchanged:
   * `create-room`
   * `viewer-joined`
   * `offer` (containing SDP)
   * `answer` (containing SDP)
   * `ice-candidate`

---

## 3. WebRTC Diagnostics (Crucial)

Since WebRTC peer connections are negotiated peer-to-peer, standard network logs don't capture media streams. Browser makers provide dedicated internal debuggers.

### 🌐 Chrome / Edge: `chrome://webrtc-internals`
This is the most powerful tool for analyzing WebRTC.
1. Open a new browser tab.
2. Navigate to `chrome://webrtc-internals/`.
3. In other tabs/windows, start a screen share session and connect a viewer.
4. Go back to the `chrome://webrtc-internals/` tab. You will see:
   * **Active PeerConnections**: Lists both the local presenter connection and the remote viewer connection.
   * **SDP Exchanges**: Shows the exact Offer and Answer SDP text. You can trace if codecs, video/audio tracks, or candidates are correctly configured.
   * **Real-time Graphs**: Track bandwidth, frame rate, packets lost, jitter, and resolution.
   * **ICE Candidate Pair**: Shows which candidate pairs (local IP vs. STUN/TURN public IP) are being nominated and succeeded.

### 🦊 Firefox: `about:webrtc`
If using Firefox, navigate to `about:webrtc` to see active peer connection details, ICE statistics, and connection logs.

---

## 4. Key Troubleshooting Scenarios

### 🔒 WebRTC Requires Secure Contexts (HTTPS / Localhost)
> [!IMPORTANT]
> WebRTC API calls like `navigator.mediaDevices.getDisplayMedia` are blocked by browsers in insecure contexts.
> * **Local Testing**: Works fine on `http://localhost:3000`.
> * **Remote Testing**: If hosting on a server, accessing it via HTTP (e.g., `http://192.168.1.15:3000`) will fail. You must use HTTPS or proxy it.
> * **Workaround for Dev Testing**: You can bypass this in Chrome by enabling the flag:
>   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
>   Add your IP (e.g. `http://192.168.1.15:3000`) and toggle it to **Enabled**.

### 🧊 ICE Candidate & NAT Issues
* **Symptom**: Signaling completes (Offer/Answer exchanged) but connection state stays on `connecting` or changes to `failed` without displaying video.
* **Why**: The peers are behind symmetric NATs or firewalls, and the configured STUN servers in [presenter.js](file:///c:/Users/amitm/source/repos/WebRtc/public/js/presenter.js#L15-L22) cannot establish a direct path.
* **Solution**: For local networks and public internet with open NAT, STUN is sufficient. For production or restrictive networks, you will need to add a **TURN server** (e.g., coturn) configuration to the `iceServers` array.

### 🔇 Autoplay Policies
* **Symptom**: Viewer connects but the video screen remains frozen or black.
* **Why**: Modern browsers prevent media with audio from autoplaying without user interaction.
* **Solution**: Notice in [viewer.js](file:///c:/Users/amitm/source/repos/WebRtc/public/js/viewer.js#L84-L97) that the video starts muted, and an "Unmute Banner" is displayed to let the user unmute via interaction. Ensure this logic triggers properly.

---

## 5. Step-by-Step Testing Loop

1. Run the server:
   ```powershell
   npm run dev
   ```
2. Open a standard Chrome window to `http://localhost:3000`. This will be your **Presenter**.
3. Click **Start Sharing** and choose a screen, tab, or window.
4. Copy the shareable viewer link generated in the input box.
5. Open an **Incognito Chrome Window** (or a different browser like Firefox or Edge) and paste the viewer link.
6. Open browser DevTools on both sides (`F12`) to verify the socket events and WebRTC connection transition to `connected`.
7. Go to `chrome://webrtc-internals` to view stats.
