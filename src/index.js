import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { XmtpClient } from './xmtp-client.js';
import { WebSocketManager } from './websocket-manager.js';

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);

app.use(cors());
app.use(express.json());

const xmtpClients = new Map();
const sessionToWallet = new Map();
const walletToSession = new Map();
const sessionExpirations = new Map();

const server = createServer(app);
const wss = new WebSocketServer({ server });
const wsManager = new WebSocketManager(wss, resolveWalletForToken);

function normalizeWallet(walletAddress) {
  return walletAddress.toLowerCase();
}

function getSessionTokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return req.headers['x-session-token'];
}

function touchSession(sessionToken) {
  const walletAddress = sessionToWallet.get(sessionToken);
  if (!walletAddress) {
    return;
  }

  const existingTimeout = sessionExpirations.get(sessionToken);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  const timeout = setTimeout(() => {
    destroySession(sessionToken).catch((error) => {
      console.error('[Session] Idle timeout cleanup failed:', error);
    });
  }, SESSION_TTL_MS);

  sessionExpirations.set(sessionToken, timeout);
}

function resolveWalletForToken(sessionToken) {
  if (!sessionToken) {
    return null;
  }

  const walletAddress = sessionToWallet.get(sessionToken) || null;
  if (walletAddress) {
    touchSession(sessionToken);
  }

  return walletAddress;
}

async function getOrCreateClient(walletAddress, privateKey) {
  const key = normalizeWallet(walletAddress);
  const existing = xmtpClients.get(key);

  if (existing?.isConnected) {
    return existing;
  }

  const client = new XmtpClient(walletAddress, privateKey);
  await client.initialize();

  client.onMessage((message) => {
    wsManager.sendToUser(walletAddress, {
      type: 'new_message',
      data: message,
    });
  });

  xmtpClients.set(key, client);
  return client;
}

async function createSession(walletAddress, privateKey) {
  const normalizedWallet = normalizeWallet(walletAddress);
  const client = await getOrCreateClient(normalizedWallet, privateKey);

  const existingToken = walletToSession.get(normalizedWallet);
  if (existingToken) {
    touchSession(existingToken);
    return { sessionToken: existingToken, walletAddress: client.walletAddress };
  }

  const sessionToken = crypto.randomUUID();
  sessionToWallet.set(sessionToken, normalizedWallet);
  walletToSession.set(normalizedWallet, sessionToken);
  touchSession(sessionToken);

  return { sessionToken, walletAddress: client.walletAddress };
}

async function destroySession(sessionToken) {
  const walletAddress = sessionToWallet.get(sessionToken);
  if (!walletAddress) {
    return false;
  }

  const timeout = sessionExpirations.get(sessionToken);
  if (timeout) {
    clearTimeout(timeout);
  }

  sessionExpirations.delete(sessionToken);
  sessionToWallet.delete(sessionToken);
  walletToSession.delete(walletAddress);

  wsManager.closeConnectionsForUser(walletAddress);

  const client = xmtpClients.get(walletAddress);
  if (client) {
    await client.disconnect();
    xmtpClients.delete(walletAddress);
  }

  return true;
}

function requireSession(req, res, next) {
  const sessionToken = getSessionTokenFromRequest(req);
  const walletAddress = resolveWalletForToken(sessionToken);

  if (!sessionToken || !walletAddress) {
    return res.status(401).json({ error: 'Invalid or missing session token' });
  }

  const xmtpClient = xmtpClients.get(walletAddress);
  if (!xmtpClient?.isConnected) {
    return res.status(401).json({ error: 'Session is no longer active' });
  }

  req.sessionToken = sessionToken;
  req.walletAddress = walletAddress;
  req.xmtpClient = xmtpClient;
  next();
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: sessionToWallet.size,
    activeClients: xmtpClients.size,
  });
});

app.post('/session/init', async (req, res) => {
  try {
    const { walletAddress, privateKey } = req.body;

    if (!walletAddress || !privateKey) {
      return res.status(400).json({
        error: 'walletAddress and privateKey are required',
      });
    }

    const session = await createSession(walletAddress, privateKey);
    res.json({
      success: true,
      sessionToken: session.sessionToken,
      walletAddress: session.walletAddress,
    });
  } catch (error) {
    console.error('[/session/init] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-message', requireSession, async (req, res) => {
  try {
    const { recipientAddress, message } = req.body;

    if (!recipientAddress || !message) {
      return res.status(400).json({
        error: 'recipientAddress and message are required',
      });
    }

    const sentMessage = await req.xmtpClient.sendMessage(recipientAddress, message);
    const sentAt = sentMessage.sentAt
      ? sentMessage.sentAt.toISOString()
      : sentMessage.sent.toISOString();
    const payload = {
      id: sentMessage.id,
      content: message,
      sender: req.walletAddress,
      recipient: recipientAddress,
      sentAt,
      conversationTopic: sentMessage.conversationTopic ?? null,
      status: 'sent',
    };

    wsManager.sendToUser(req.walletAddress, {
      type: 'message_status',
      data: {
        id: sentMessage.id,
        status: 'sent',
        timestamp: sentAt,
      },
    });

    res.json({ success: true, message: payload });
  } catch (error) {
    console.error('[/send-message] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/messages', requireSession, async (req, res) => {
  try {
    const { peerAddress, since } = req.query;

    if (!peerAddress) {
      return res.status(400).json({ error: 'peerAddress is required' });
    }

    const sinceDate = since ? new Date(since) : undefined;
    const messages = await req.xmtpClient.getMessages(peerAddress, sinceDate);

    res.json({
      success: true,
      messages,
    });
  } catch (error) {
    console.error('[/messages] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/conversations', requireSession, async (req, res) => {
  try {
    const conversations = await req.xmtpClient.getConversations();
    res.json({
      success: true,
      conversations,
    });
  } catch (error) {
    console.error('[/conversations] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/conversations/consent', requireSession, async (req, res) => {
  try {
    const { peerAddress, consentState } = req.body;

    if (!peerAddress || !consentState) {
      return res.status(400).json({
        error: 'peerAddress and consentState are required',
      });
    }

    const conversation = await req.xmtpClient.updateConsent(
      peerAddress,
      consentState,
    );

    res.json({
      success: true,
      conversation,
    });
  } catch (error) {
    console.error('[/conversations/consent] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/can-message', requireSession, async (req, res) => {
  try {
    const { targetAddress } = req.query;

    if (!targetAddress) {
      return res.status(400).json({ error: 'targetAddress is required' });
    }

    const canMessage = await req.xmtpClient.canMessage(targetAddress);
    res.json({
      success: true,
      canMessage,
      address: targetAddress,
    });
  } catch (error) {
    console.error('[/can-message] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/session/disconnect', requireSession, async (req, res) => {
  try {
    await destroySession(req.sessionToken);
    res.json({ success: true, message: 'Session disconnected' });
  } catch (error) {
    console.error('[/session/disconnect] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Meshlix XMTP backend listening on http://${HOST}:${PORT}`);
});

async function shutdown() {
  console.log('Shutting down...');

  for (const sessionToken of [...sessionToWallet.keys()]) {
    await destroySession(sessionToken);
  }

  wss.close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
