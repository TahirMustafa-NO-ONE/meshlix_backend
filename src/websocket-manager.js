/**
 * WebSocket Manager for real-time updates.
 *
 * Binds websocket connections to wallets using session tokens resolved by the
 * backend session store.
 */
export class WebSocketManager {
  constructor(wss, resolveWalletForToken) {
    this.wss = wss;
    this.resolveWalletForToken = resolveWalletForToken;
    this.clients = new Map();

    this.setupWebSocketServer();
  }

  setupWebSocketServer() {
    this.wss.on('connection', (ws) => {
      console.log('[WebSocket] New connection');

      let walletAddress = null;

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'register') {
            const resolvedWallet = this.resolveWalletForToken(message.sessionToken);

            if (!resolvedWallet) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid or expired session token',
              }));
              return;
            }

            walletAddress = resolvedWallet.toLowerCase();

            if (!this.clients.has(walletAddress)) {
              this.clients.set(walletAddress, new Set());
            }

            this.clients.get(walletAddress).add(ws);

            ws.send(JSON.stringify({
              type: 'registered',
              walletAddress,
            }));
            return;
          }

          if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (error) {
          console.error('[WebSocket] Message parsing error:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format',
          }));
        }
      });

      ws.on('close', () => {
        if (walletAddress) {
          this.unregisterSocket(walletAddress, ws);
        }
      });

      ws.on('error', (error) => {
        console.error('[WebSocket] Error:', error);
      });

      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Welcome to Meshlix XMTP Backend WebSocket',
      }));
    });
  }

  unregisterSocket(walletAddress, ws) {
    const key = walletAddress.toLowerCase();
    const connections = this.clients.get(key);

    if (!connections) {
      return;
    }

    connections.delete(ws);
    if (connections.size === 0) {
      this.clients.delete(key);
    }
  }

  closeConnectionsForUser(walletAddress) {
    const key = walletAddress.toLowerCase();
    const connections = this.clients.get(key);

    if (!connections) {
      return;
    }

    for (const ws of connections) {
      try {
        ws.close(1000, 'Session closed');
      } catch (error) {
        console.error('[WebSocket] Close error:', error);
      }
    }

    this.clients.delete(key);
  }

  sendToUser(walletAddress, data) {
    const key = walletAddress.toLowerCase();
    const connections = this.clients.get(key);

    if (!connections || connections.size === 0) {
      return;
    }

    const message = JSON.stringify(data);

    for (const ws of connections) {
      if (ws.readyState === 1) {
        try {
          ws.send(message);
        } catch (error) {
          console.error('[WebSocket] Send error:', error);
        }
      }
    }
  }

  getConnectionCount(walletAddress) {
    const key = walletAddress.toLowerCase();
    const connections = this.clients.get(key);
    return connections ? connections.size : 0;
  }

  getTotalConnections() {
    return this.wss.clients.size;
  }
}
