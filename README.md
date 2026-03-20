# Meshlix XMTP Backend

In-memory XMTP relay for the Meshlix Flutter app.

## Architecture

```text
Flutter UI -> Local DB -> REST/WebSocket -> Node relay -> XMTP
```

The backend is stateless with respect to persistence:
- no database
- no message storage
- no key storage
- only in-memory XMTP clients and session tokens

## Endpoints

### `POST /session/init`

Request:

```json
{
  "walletAddress": "0x...",
  "privateKey": "0x..."
}
```

Response:

```json
{
  "success": true,
  "sessionToken": "uuid",
  "walletAddress": "0x..."
}
```

### Authenticated endpoints

Use `Authorization: Bearer <sessionToken>`.

- `POST /send-message`
- `GET /messages?peerAddress=0x...&since=<iso-date>`
- `GET /conversations`
- `GET /can-message?targetAddress=0x...`
- `POST /session/disconnect`

## WebSocket

Connect to `ws://localhost:3000` and register with:

```json
{
  "type": "register",
  "sessionToken": "uuid"
}
```

Server events:
- `new_message`
- `message_status`

## Notes

- Sessions expire from memory after idle timeout or process restart.
- Use HTTPS in production because the private key is sent once at session init.
