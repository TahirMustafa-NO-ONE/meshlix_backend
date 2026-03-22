import { Client, ConsentState, IdentifierKind } from '@xmtp/node-sdk';
import { Wallet, getBytes } from 'ethers';

const XMTP_ENV = process.env.XMTP_ENV || 'dev';
const NS_PER_MS = 1000000n;
const ACTIVE_CONSENT_STATES = [ConsentState.Allowed, ConsentState.Unknown];
const POLL_INTERVAL_MS = Number(process.env.XMTP_POLL_INTERVAL_MS || 5000);

function normalizeAddress(address) {
  return address.toLowerCase();
}

function addressIdentifier(address) {
  return {
    identifier: normalizeAddress(address),
    identifierKind: IdentifierKind.Ethereum,
  };
}

function conversationTopicFor(addressA, addressB) {
  const addresses = [normalizeAddress(addressA), normalizeAddress(addressB)].sort();
  return `xmtp_${addresses[0]}_${addresses[1]}`;
}

function dateToNs(date) {
  return BigInt(date.getTime()) * NS_PER_MS;
}

function consentStateToString(consentState) {
  switch (consentState) {
    case ConsentState.Allowed:
      return 'allowed';
    case ConsentState.Denied:
      return 'denied';
    case ConsentState.Unknown:
    default:
      return 'unknown';
  }
}

function stringToConsentState(consentState) {
  switch ((consentState || '').toLowerCase()) {
    case 'allowed':
      return ConsentState.Allowed;
    case 'denied':
      return ConsentState.Denied;
    default:
      return ConsentState.Unknown;
  }
}

/**
 * XMTP V3 client wrapper for the Meshlix backend bridge.
 *
 * Keeps the REST/WebSocket payload shape stable for Flutter while using inbox
 * IDs internally, which is how XMTP V3 addresses direct message peers.
 */
export class XmtpClient {
  constructor(walletAddress, privateKey) {
    this.walletAddress = normalizeAddress(walletAddress);
    this.privateKey = privateKey;
    this.wallet = null;
    this.client = null;
    this.messageListeners = [];
    this.streamController = null;
    this.isConnected = false;
    this.addressToInboxId = new Map();
    this.inboxIdToAddress = new Map();
    this.seenMessageIds = new Set();
    this.pollTimer = null;
  }

  async initialize() {
    try {
      console.log(`[XmtpClient] Initializing V3 client for wallet: ${this.walletAddress}`);

      const cleanKey = this.privateKey.startsWith('0x')
        ? this.privateKey
        : `0x${this.privateKey}`;

      this.wallet = new Wallet(cleanKey);
      this.client = await Client.create(this.#createSigner(this.wallet), {
        env: XMTP_ENV,
        dbPath: null,
        disableDeviceSync: true,
      });

      this.isConnected = true;
      console.log(`[XmtpClient] Client initialized with inbox: ${this.client.inboxId}`);

      await this.client.conversations.syncAll(ACTIVE_CONSENT_STATES);
      await this.#hydrateSeenMessages();
      await this.startMessageStream();
      this.startPolling();

      return this.client;
    } catch (error) {
      console.error('[XmtpClient] Initialization failed:', error);
      throw error;
    }
  }

  async startMessageStream() {
    this.ensureConnected();

    try {
      console.log('[XmtpClient] Starting V3 message stream...');

      const stream = await this.client.conversations.streamAllMessages({
        consentStates: ACTIVE_CONSENT_STATES,
        onError: (error) => {
          console.error('[XmtpClient] Stream error:', error);
        },
      });

      this.streamController = stream;

      (async () => {
        for await (const message of stream) {
          await this.#dispatchIncomingMessage(message);
        }
      })().catch((error) => {
        console.error('[XmtpClient] Message stream loop failed:', error);
      });

      console.log('[XmtpClient] Message stream started');
    } catch (error) {
      console.error('[XmtpClient] Failed to start message stream:', error);
      throw error;
    }
  }

  onMessage(callback) {
    this.messageListeners.push(callback);
  }

  async sendMessage(recipientAddress, content) {
    this.ensureConnected();

    try {
      const normalizedRecipient = normalizeAddress(recipientAddress);
      console.log(`[XmtpClient] Sending V3 message to ${normalizedRecipient}`);

      const dm = await this.#getOrCreateDmByAddress(normalizedRecipient);
      const messageId = await dm.sendText(content);

      console.log(`[XmtpClient] Message sent: ${messageId}`);

      return {
        id: messageId,
        conversationTopic: conversationTopicFor(this.walletAddress, normalizedRecipient),
        sentAt: new Date(),
      };
    } catch (error) {
      console.error('[XmtpClient] Send message failed:', error);
      throw error;
    }
  }

  async getMessages(peerAddress, since = null) {
    this.ensureConnected();

    try {
      const normalizedPeer = normalizeAddress(peerAddress);
      console.log(`[XmtpClient] Fetching V3 messages with ${normalizedPeer}`);

      const dm = await this.#findDmByAddress(normalizedPeer);
      if (!dm) {
        return [];
      }

      await dm.sync();

      const options = {};
      if (since instanceof Date && !Number.isNaN(since.getTime())) {
        options.sentAfterNs = dateToNs(since);
      }

      const messages = await dm.messages(options);
      const formattedMessages = await Promise.all(
        messages.map((message) =>
          this.#formatDecodedMessage(message, { peerAddress: normalizedPeer }),
        ),
      );

      return formattedMessages.filter(Boolean);
    } catch (error) {
      console.error('[XmtpClient] Get messages failed:', error);
      throw error;
    }
  }

  async getConversations() {
    this.ensureConnected();

    try {
      console.log('[XmtpClient] Fetching V3 conversations...');

      await this.client.conversations.syncAll(ACTIVE_CONSENT_STATES);
      const dms = this.client.conversations.listDms({
        consentStates: ACTIVE_CONSENT_STATES,
      });

      const result = await Promise.all(
        dms.map(async (dm) => {
          const peerAddress = await this.#resolveAddressForInboxId(dm.peerInboxId);
          if (!peerAddress) {
            return null;
          }

          const lastMessage = await dm.lastMessage();
          const formattedLastMessage = lastMessage
            ? await this.#formatDecodedMessage(lastMessage, { peerAddress })
            : null;

          return {
            topic: conversationTopicFor(this.walletAddress, peerAddress),
            peerAddress,
            createdAt: dm.createdAt.toISOString(),
            lastMessage: formattedLastMessage,
            consentState: consentStateToString(dm.consentState()),
          };
        }),
      );

      const conversations = result.filter(Boolean);
      console.log(`[XmtpClient] Found ${conversations.length} conversations`);
      return conversations;
    } catch (error) {
      console.error('[XmtpClient] Get conversations failed:', error);
      throw error;
    }
  }

  async canMessage(address) {
    this.ensureConnected();

    try {
      const results = await this.client.canMessage([addressIdentifier(address)]);
      return Boolean(results.values().next().value);
    } catch (error) {
      console.error('[XmtpClient] Can message check failed:', error);
      return false;
    }
  }

  async updateConsent(peerAddress, consentState) {
    this.ensureConnected();

    const normalizedPeer = normalizeAddress(peerAddress);
    const dm = await this.#findDmByAddress(normalizedPeer);
    if (!dm) {
      throw new Error(`No conversation found for ${normalizedPeer}`);
    }

    dm.updateConsentState(stringToConsentState(consentState));
    const lastMessage = await dm.lastMessage();
    const formattedLastMessage = lastMessage
      ? await this.#formatDecodedMessage(lastMessage, { peerAddress: normalizedPeer })
      : null;

    return {
      topic: conversationTopicFor(this.walletAddress, normalizedPeer),
      peerAddress: normalizedPeer,
      createdAt: dm.createdAt.toISOString(),
      lastMessage: formattedLastMessage,
      consentState: consentStateToString(dm.consentState()),
    };
  }

  async disconnect() {
    console.log('[XmtpClient] Disconnecting...');

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.streamController?.return) {
      try {
        await this.streamController.return();
      } catch (error) {
        console.error('[XmtpClient] Stream close failed:', error);
      }
    }

    this.streamController = null;
    this.messageListeners = [];
    this.addressToInboxId.clear();
    this.inboxIdToAddress.clear();
    this.seenMessageIds.clear();
    this.isConnected = false;
    this.client = null;
    this.wallet = null;

    console.log('[XmtpClient] Disconnected');
  }

  ensureConnected() {
    if (!this.client || !this.isConnected) {
      throw new Error('XMTP client not initialized. Call initialize() first.');
    }
  }

  #createSigner(wallet) {
    return {
      type: 'EOA',
      getIdentifier: () => addressIdentifier(this.walletAddress),
      signMessage: async (message) => getBytes(await wallet.signMessage(message)),
    };
  }

  startPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      this.#pollForMissedMessages().catch((error) => {
        console.error('[XmtpClient] Polling failed:', error);
      });
    }, POLL_INTERVAL_MS);
  }

  async #hydrateSeenMessages() {
    const dms = this.client.conversations.listDms({
      consentStates: ACTIVE_CONSENT_STATES,
    });

    for (const dm of dms) {
      const messages = await dm.messages();
      for (const message of messages) {
        this.seenMessageIds.add(message.id);
      }
    }
  }

  async #pollForMissedMessages() {
    this.ensureConnected();

    await this.client.conversations.syncAll(ACTIVE_CONSENT_STATES);
    const dms = this.client.conversations.listDms({
      consentStates: ACTIVE_CONSENT_STATES,
    });

    for (const dm of dms) {
      const messages = await dm.messages();
      for (const message of messages) {
        await this.#dispatchIncomingMessage(message);
      }
    }
  }

  async #getOrCreateDmByAddress(address) {
    const inboxId = await this.#getInboxIdForAddress(address);
    if (!inboxId) {
      throw new Error(`Address ${address} is not on the XMTP network`);
    }

    let dm = this.client.conversations.getDmByInboxId(inboxId);
    if (!dm) {
      dm = await this.client.conversations.createDm(inboxId);
    }

    this.addressToInboxId.set(address, inboxId);
    this.inboxIdToAddress.set(inboxId, address);

    return dm;
  }

  async #findDmByAddress(address) {
    const inboxId = await this.#getInboxIdForAddress(address);
    if (!inboxId) {
      return undefined;
    }

    let dm = this.client.conversations.getDmByInboxId(inboxId);
    if (dm) {
      return dm;
    }

    await this.client.conversations.sync();
    return this.client.conversations.getDmByInboxId(inboxId);
  }

  async #getInboxIdForAddress(address) {
    const cached = this.addressToInboxId.get(address);
    if (cached) {
      return cached;
    }

    const inboxId = await this.client.fetchInboxIdByIdentifier(addressIdentifier(address));
    if (inboxId) {
      this.addressToInboxId.set(address, inboxId);
      this.inboxIdToAddress.set(inboxId, address);
    }

    return inboxId;
  }

  async #resolveAddressForInboxId(inboxId) {
    const cached = this.inboxIdToAddress.get(inboxId);
    if (cached) {
      return cached;
    }

    const states = await Client.fetchInboxStates([inboxId], XMTP_ENV);
    const state = states[0];
    const identifier = state?.identifiers?.find(
      (entry) => entry.identifierKind === IdentifierKind.Ethereum,
    );

    if (!identifier?.identifier) {
      return null;
    }

    const address = normalizeAddress(identifier.identifier);
    this.inboxIdToAddress.set(inboxId, address);
    this.addressToInboxId.set(address, inboxId);
    return address;
  }

  async #formatDecodedMessage(message, { peerAddress } = {}) {
    const content = typeof message.content === 'string' ? message.content : message.fallback;
    if (!content) {
      return null;
    }

    const sender = await this.#resolveAddressForInboxId(message.senderInboxId);
    if (!sender) {
      return null;
    }

    const resolvedPeerAddress =
      peerAddress ??
      (sender === this.walletAddress ? null : sender);

    const consentPeerAddress = peerAddress ?? (sender === this.walletAddress ? null : sender);
    const dm = consentPeerAddress
      ? await this.#findDmByAddress(consentPeerAddress)
      : null;

    return {
      id: message.id,
      content,
      sender,
      sentAt: message.sentAt.toISOString(),
      conversationTopic: resolvedPeerAddress
        ? conversationTopicFor(this.walletAddress, resolvedPeerAddress)
        : null,
      consentState: dm ? consentStateToString(dm.consentState()) : 'allowed',
    };
  }

  async #dispatchIncomingMessage(message) {
    if (this.seenMessageIds.has(message.id)) {
      return;
    }

    this.seenMessageIds.add(message.id);

    const formattedMessage = await this.#formatDecodedMessage(message);
    if (!formattedMessage) {
      return;
    }

    if (normalizeAddress(formattedMessage.sender) === this.walletAddress) {
      return;
    }

    console.log(`[XmtpClient] New message from ${formattedMessage.sender}`);

    this.messageListeners.forEach((listener) => {
      try {
        listener(formattedMessage);
      } catch (listenerError) {
        console.error('[XmtpClient] Listener error:', listenerError);
      }
    });
  }
}
