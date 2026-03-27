/**
 * MobileClaw: Terminal channel for local interaction.
 * Reads from stdin, writes to stdout. No external service needed.
 */
import readline from 'readline';
import crypto from 'crypto';

import { registerChannel, type ChannelOpts } from './registry.js';
import {
  type Channel,
  type NewMessage,
  type RegisteredGroup,
} from '../types.js';
import { logger } from '../logger.js';
import { TRIGGER_PATTERN } from '../config.js';
import { setRegisteredGroup } from '../db.js';

const TERMINAL_JID = 'terminal:local';
const TERMINAL_GROUP_NAME = 'Terminal';

registerChannel('terminal', (opts: ChannelOpts): Channel | null => {
  // Terminal channel is always available — no credentials needed
  let connected = false;
  let rl: readline.Interface | null = null;

  return {
    name: 'terminal',

    async connect() {
      connected = true;

      // Report chat metadata so MobileClaw knows about us
      opts.onChatMetadata(
        TERMINAL_JID,
        new Date().toISOString(),
        TERMINAL_GROUP_NAME,
        'terminal',
        false,
      );

      // Auto-register the terminal as the main group if not already registered
      const groups = opts.registeredGroups();
      if (!groups[TERMINAL_JID]) {
        const group: RegisteredGroup = {
          name: TERMINAL_GROUP_NAME,
          folder: 'main',
          trigger: TRIGGER_PATTERN.source,
          added_at: new Date().toISOString(),
          requiresTrigger: false, // Terminal doesn't need @Andy prefix
          isMain: true,
        };
        setRegisteredGroup(TERMINAL_JID, group);
        // Update the in-memory map so the orchestrator picks it up immediately
        groups[TERMINAL_JID] = group;
        logger.info('Terminal channel: auto-registered as main group');
      }

      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '\n> ',
      });

      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) {
          rl?.prompt();
          return;
        }

        const msg: NewMessage = {
          id: `term-${crypto.randomUUID()}`,
          chat_jid: TERMINAL_JID,
          sender: 'terminal-user',
          sender_name: 'You',
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: false,
        };

        opts.onMessage(TERMINAL_JID, msg);
      });

      rl.on('close', () => {
        connected = false;
      });

      console.log('\n=== MobileClaw Terminal ===');
      console.log('Type a message to talk to the agent.');
      console.log('Press Ctrl+C to exit.\n');
      rl.prompt();

      logger.info('Terminal channel connected');
    },

    async sendMessage(_jid: string, text: string) {
      // Print agent response to stdout
      console.log(`\n${text}`);
      rl?.prompt();
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      return jid === TERMINAL_JID;
    },

    async disconnect() {
      connected = false;
      rl?.close();
      logger.info('Terminal channel disconnected');
    },
  };
});
