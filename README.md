# Meshlix XMTP Backend

Node.js backend bridge for the Meshlix Flutter app. This service initializes XMTP clients from wallet credentials provided by the authenticated app session, exposes a small REST API for chat operations, and pushes real-time updates over WebSocket.

## Overview

This backend is responsible for:

- creating and managing XMTP clients per wallet session
- exposing REST endpoints for messaging and sync
- maintaining in-memory app sessions
- pushing new message and delivery events over WebSocket
- translating XMTP V3 conversation data into a Flutter-friendly payload shape

## Architecture

```text
Flutter app -> REST + WebSocket -> Meshlix backend -> XMTP network
```

The backend is intentionally ephemeral:

- no database
- no persistent key storage
- no persistent message storage
- no session persistence across restarts
- all active sessions and XMTP clients live in memory only

## Tech Stack

- Node.js
- Express
- WebSocket (`ws`)
- XMTP Node SDK
- Ethers
- CORS
- dotenv

## Requirements

- Node.js `>= 22.0.0`
- valid wallet private key supplied by the Flutter app during session init
- network access to XMTP

## Project Structure

```text
backend/
+- src/
   +- index.js                # Express server, session lifecycle, REST API
   +- websocket-manager.js    # WebSocket registration and event fanout
   +- xmtp-client.js          # XMTP V3 wrapper and payload normalization
+- scripts/
   +- fix-xmtp-proto-imports.mjs
+- .env.example
+- package.json
```

## Installation

From the `backend/` directory:

```bash
npm install
```

## Environment Variables

Create a `.env` file by copying `.env.example`.

PowerShell:

```bash
Copy-Item .env.example .env
```

Example:

```env
PORT=3000
XMTP_ENV=dev
```

Supported variables:

`PORT`
- HTTP and WebSocket server port.
- Defaults to `3000`.

`XMTP_ENV`
- XMTP environment.
- Use `dev` for development/testing and `production` for mainnet.
- Defaults to `dev`.

`SESSION_TTL_MS`
- Idle session timeout in milliseconds.
- Defaults to `1800000` (30 minutes).

`XMTP_POLL_INTERVAL_MS`
- Polling interval used alongside the XMTP message stream to catch missed messages.
- Defaults to `5000`.

## Running The Server

Development:

```bash
npm run dev
```

Production-style start:

```bash
npm start
```

## Deploying To Render

This repository includes a `render.yaml` file configured for the backend as a Render web service.

The service is configured to deploy with Docker so the runtime OS stays compatible with XMTP native bindings.

Render setup summary:

1. Push this repository to GitHub.
2. In Render, create a new Blueprint and select the repository.
3. Render will detect [`./render.yaml`](./render.yaml) and create the backend service.
4. After the first deploy, open the service and confirm the health check passes at `/health`.

Important notes for Render:

- the backend binds to `0.0.0.0` so Render can route traffic correctly
- HTTP and WebSocket traffic both use the same public service URL
- the backend uses a `Dockerfile` because XMTP native bindings require a newer glibc than Render's native Node runtime currently provides
- on Render, clients should use `https://<service>.onrender.com` for HTTP
- and `wss://<service>.onrender.com` for WebSocket

Recommended environment values:

```env
XMTP_ENV=production
SESSION_TTL_MS=1800000
XMTP_POLL_INTERVAL_MS=5000
```

If you want to use XMTP dev/test traffic instead, change `XMTP_ENV` to `dev`.

When the server starts, it listens on:

```text
http://localhost:3000
```

unless `PORT` is overridden.

## How It Works

### Session Lifecycle

1. The Flutter app calls `POST /session/init` with `walletAddress` and `privateKey`.
2. The backend creates or reuses an XMTP client for that wallet.
3. A random session token is generated and returned to the app.
4. Authenticated REST calls use `Authorization: Bearer <sessionToken>`.
5. The WebSocket client registers with the same session token.
6. Idle sessions expire automatically after `SESSION_TTL_MS`.
7. On disconnect or server shutdown, the backend closes WebSocket connections and XMTP clients.

### XMTP Client Behavior

Each active wallet gets an `XmtpClient` instance that:

- initializes an XMTP V3 client
- syncs all active conversations
- starts a live message stream
- polls periodically for missed messages
- resolves inbox IDs to Ethereum addresses
- normalizes conversation topics into the format used by the Flutter app

Active consent states included in sync:

- `allowed`
- `unknown`

Denied conversations are not part of the active sync path.

## REST API

Base URL example:

```text
http://localhost:3000
```

### `GET /health`

Health check endpoint.

Response:

```json
{
  "status": "ok",
  "timestamp": "2026-03-23T12:00:00.000Z",
  "activeSessions": 1,
  "activeClients": 1
}
```

### `POST /session/init`

Creates or refreshes an app session and ensures an XMTP client exists for the wallet.

Request body:

```json
{
  "walletAddress": "0xabc...",
  "privateKey": "0xdef..."
}
```

Response:

```json
{
  "success": true,
  "sessionToken": "uuid",
  "walletAddress": "0xabc..."
}
```

### Authenticated Endpoints

All endpoints below require:

```text
Authorization: Bearer <sessionToken>
```

### `POST /send-message`

Request body:

```json
{
  "recipientAddress": "0x123...",
  "message": "Hello from Meshlix"
}
```

Response:

```json
{
  "success": true,
  "message": {
    "id": "message-id",
    "content": "Hello from Meshlix",
    "sender": "0xabc...",
    "recipient": "0x123...",
    "sentAt": "2026-03-23T12:00:00.000Z",
    "conversationTopic": "xmtp_0x123..._0xabc...",
    "status": "sent"
  }
}
```

### `GET /messages`

Query params:

- `peerAddress` required
- `since` optional ISO date

Example:

```text
GET /messages?peerAddress=0x123...&since=2026-03-23T10:00:00.000Z
```

Response:

```json
{
  "success": true,
  "messages": [
    {
      "id": "message-id",
      "content": "Hello",
      "sender": "0x123...",
      "sentAt": "2026-03-23T12:00:00.000Z",
      "conversationTopic": "xmtp_0x123..._0xabc...",
      "consentState": "allowed"
    }
  ]
}
```

### `GET /conversations`

Returns conversations in active consent states.

Response:

```json
{
  "success": true,
  "conversations": [
    {
      "topic": "xmtp_0x123..._0xabc...",
      "peerAddress": "0x123...",
      "createdAt": "2026-03-23T12:00:00.000Z",
      "lastMessage": {
        "id": "message-id",
        "content": "Hello",
        "sender": "0x123...",
        "sentAt": "2026-03-23T12:00:00.000Z",
        "conversationTopic": "xmtp_0x123..._0xabc...",
        "consentState": "allowed"
      },
      "consentState": "allowed"
    }
  ]
}
```

### `POST /conversations/consent`

Updates the conversation consent state for a peer.

Request body:

```json
{
  "peerAddress": "0x123...",
  "consentState": "allowed"
}
```

Supported consent values:

- `allowed`
- `denied`
- `unknown`

### `GET /can-message`

Checks whether the target address is reachable on XMTP.

Example:

```text
GET /can-message?targetAddress=0x123...
```

Response:

```json
{
  "success": true,
  "canMessage": true,
  "address": "0x123..."
}
```

### `POST /session/disconnect`

Closes the session, disconnects the XMTP client, and closes active WebSocket connections for that wallet.

Response:

```json
{
  "success": true,
  "message": "Session disconnected"
}
```

## WebSocket Protocol

WebSocket URL:

```text
ws://localhost:3000
```

After opening the socket, the client must register:

```json
{
  "type": "register",
  "sessionToken": "uuid"
}
```

Client ping message:

```json
{
  "type": "ping"
}
```

Server responses and events:

### `connected`

Sent immediately after socket connection.

```json
{
  "type": "connected",
  "message": "Welcome to Meshlix XMTP Backend WebSocket"
}
```

### `registered`

Sent after a valid session token is registered.

```json
{
  "type": "registered",
  "walletAddress": "0xabc..."
}
```

### `new_message`

Sent when a new incoming XMTP message arrives for the registered wallet.

```json
{
  "type": "new_message",
  "data": {
    "id": "message-id",
    "content": "Hi",
    "sender": "0x123...",
    "sentAt": "2026-03-23T12:00:00.000Z",
    "conversationTopic": "xmtp_0x123..._0xabc...",
    "consentState": "unknown"
  }
}
```

### `message_status`

Sent when the backend confirms message delivery status.

```json
{
  "type": "message_status",
  "data": {
    "id": "message-id",
    "status": "sent",
    "timestamp": "2026-03-23T12:00:00.000Z"
  }
}
```

### `pong`

Returned after a client `ping`.

```json
{
  "type": "pong"
}
```

### `error`

Sent for invalid session tokens or malformed messages.

## Security Notes

Important behavior in the current design:

- wallet private keys are sent to the backend during `POST /session/init`
- the backend keeps XMTP clients in memory only
- sessions are in memory only and are lost on process restart
- there is no persistent database layer in this service

For local development this is simple and practical, but for production you should strongly consider:

- HTTPS everywhere
- secure network boundaries
- hardened secret handling
- stronger session management
- rate limiting
- request validation
- structured logging and monitoring

## Limitations

- all sessions are lost when the process restarts
- horizontal scaling is not supported with the current in-memory session model
- no durable message queue or persistence layer exists
- one backend instance is expected for local/dev usage

## Troubleshooting

### Session returns `401`

- the session token may be missing, invalid, or expired
- the associated XMTP client may have been disconnected
- re-run `POST /session/init` from the app

### WebSocket connects but no updates arrive

- make sure the client sent a `register` message with a valid session token
- verify the same wallet session is still active
- check backend logs for socket or XMTP stream errors

### Cannot message a wallet

- the target address may not be reachable on XMTP
- use `GET /can-message` to verify capability first

### Process restart logs users out

- this is expected with the current in-memory design

## Related Project

This backend is designed to work with the Flutter client in [`../meshlix_app`](../meshlix_app).

## License

No license file is currently included in this project. Add one if you plan to distribute the backend publicly.
