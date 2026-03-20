import { Client } from '@xmtp/xmtp-js';
import { Wallet } from 'ethers';

/**
 * XMTP Client wrapper for Meshlix backend
 *
 * Handles:
 * - XMTP client initialization
 * - Sending/receiving messages
 * - Conversation management
 * - Real-time message streaming
 */
export class XmtpClient {
  constructor(walletAddress, privateKey) {
    this.walletAddress = walletAddress;
    this.privateKey = privateKey;
    this.client = null;
    this.conversations = new Map();
    this.messageListeners = [];
    this.streamController = null;
    this.isConnected = false;
  }

  /**
   * Initialize the XMTP client
   */
  async initialize() {
    try {
      console.log(`[XmtpClient] Initializing for wallet: ${this.walletAddress}`);

      // Create ethers wallet from private key
      const cleanKey = this.privateKey.startsWith('0x')
        ? this.privateKey
        : `0x${this.privateKey}`;
      const wallet = new Wallet(cleanKey);

      // Create XMTP client
      this.client = await Client.create(wallet, {
        env: process.env.XMTP_ENV || 'dev' // 'dev' for testing, 'production' for mainnet
      });

      this.isConnected = true;
      console.log(`[XmtpClient] Client initialized: ${this.client.address}`);

      // Start listening for messages
      this.startMessageStream();

      return this.client;
    } catch (error) {
      console.error('[XmtpClient] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Start streaming all messages
   */
  async startMessageStream() {
    try {
      console.log('[XmtpClient] Starting message stream...');

      // Stream all messages from all conversations
      const stream = await this.client.conversations.streamAllMessages();

      this.streamController = stream;

      // Process incoming messages
      (async () => {
        for await (const message of stream) {
          // Skip messages sent by self
          if (message.senderAddress.toLowerCase() === this.walletAddress.toLowerCase()) {
            continue;
          }

          const formattedMessage = {
            id: message.id,
            content: message.content,
            sender: message.senderAddress,
            conversationTopic: message.conversation.topic,
            sentAt: message.sent.toISOString()
          };

          console.log(`[XmtpClient] New message from ${message.senderAddress}`);

          // Notify all listeners
          this.messageListeners.forEach(listener => {
            try {
              listener(formattedMessage);
            } catch (e) {
              console.error('[XmtpClient] Listener error:', e);
            }
          });
        }
      })();

      console.log('[XmtpClient] Message stream started');
    } catch (error) {
      console.error('[XmtpClient] Failed to start message stream:', error);
    }
  }

  /**
   * Register a message listener
   */
  onMessage(callback) {
    this.messageListeners.push(callback);
  }

  /**
   * Send a message to a peer
   */
  async sendMessage(recipientAddress, content) {
    this.ensureConnected();

    try {
      console.log(`[XmtpClient] Sending message to ${recipientAddress}`);

      // Get or create conversation
      let conversation = this.conversations.get(recipientAddress.toLowerCase());

      if (!conversation) {
        // Check if recipient can receive messages
        const canMessage = await this.client.canMessage(recipientAddress);
        if (!canMessage) {
          throw new Error(`Address ${recipientAddress} is not on the XMTP network`);
        }

        conversation = await this.client.conversations.newConversation(recipientAddress);
        this.conversations.set(recipientAddress.toLowerCase(), conversation);
      }

      // Send the message
      const sentMessage = await conversation.send(content);

      console.log(`[XmtpClient] Message sent: ${sentMessage.id}`);

      return sentMessage;
    } catch (error) {
      console.error('[XmtpClient] Send message failed:', error);
      throw error;
    }
  }

  /**
   * Get messages from a conversation
   */
  async getMessages(peerAddress, since = null) {
    this.ensureConnected();

    try {
      console.log(`[XmtpClient] Fetching messages with ${peerAddress}`);

      // Get or create conversation
      let conversation = this.conversations.get(peerAddress.toLowerCase());

      if (!conversation) {
        const conversations = await this.client.conversations.list();
        conversation = conversations.find(
          c => c.peerAddress.toLowerCase() === peerAddress.toLowerCase()
        );

        if (conversation) {
          this.conversations.set(peerAddress.toLowerCase(), conversation);
        }
      }

      if (!conversation) {
        return [];
      }

      // Fetch messages
      const options = {};
      if (since) {
        options.startTime = since;
      }

      const messages = await conversation.messages(options);

      return messages.map(msg => ({
        id: msg.id,
        content: msg.content,
        sender: msg.senderAddress,
        sentAt: msg.sent.toISOString(),
        conversationTopic: conversation.topic
      }));
    } catch (error) {
      console.error('[XmtpClient] Get messages failed:', error);
      throw error;
    }
  }

  /**
   * Get all conversations
   */
  async getConversations() {
    this.ensureConnected();

    try {
      console.log('[XmtpClient] Fetching conversations...');

      const conversations = await this.client.conversations.list();

      // Cache conversations
      conversations.forEach(conv => {
        this.conversations.set(conv.peerAddress.toLowerCase(), conv);
      });

      // Get last message for each conversation
      const result = await Promise.all(
        conversations.map(async (conv) => {
          const messages = await conv.messages({ limit: 1 });
          const lastMessage = messages[0];

          return {
            topic: conv.topic,
            peerAddress: conv.peerAddress,
            createdAt: conv.createdAt.toISOString(),
            lastMessage: lastMessage ? {
              id: lastMessage.id,
              content: lastMessage.content,
              sender: lastMessage.senderAddress,
              sentAt: lastMessage.sent.toISOString()
            } : null
          };
        })
      );

      console.log(`[XmtpClient] Found ${result.length} conversations`);
      return result;
    } catch (error) {
      console.error('[XmtpClient] Get conversations failed:', error);
      throw error;
    }
  }

  /**
   * Check if an address can receive XMTP messages
   */
  async canMessage(address) {
    this.ensureConnected();

    try {
      return await this.client.canMessage(address);
    } catch (error) {
      console.error('[XmtpClient] Can message check failed:', error);
      return false;
    }
  }

  /**
   * Disconnect the client
   */
  async disconnect() {
    console.log('[XmtpClient] Disconnecting...');

    if (this.streamController) {
      // Close the stream
      this.streamController.return?.();
      this.streamController = null;
    }

    this.messageListeners = [];
    this.conversations.clear();
    this.isConnected = false;
    this.client = null;

    console.log('[XmtpClient] Disconnected');
  }

  /**
   * Ensure client is connected
   */
  ensureConnected() {
    if (!this.client || !this.isConnected) {
      throw new Error('XMTP client not initialized. Call initialize() first.');
    }
  }
}
