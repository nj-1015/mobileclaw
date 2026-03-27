/**
 * MobileClaw: Web Chat Channel
 * Serves a browser-based chat UI on localhost for testing and interaction.
 * Uses Server-Sent Events for streaming responses (no extra dependencies).
 */
import http from 'http';
import crypto from 'crypto';

import { registerChannel, type ChannelOpts } from './registry.js';
import { type Channel, type NewMessage } from '../types.js';
import { TRIGGER_PATTERN } from '../config.js';
import { setRegisteredGroup } from '../db.js';
import { type RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

const WEB_JID = 'web:local';
const WEB_GROUP_NAME = 'WebChat';
const WEB_PORT = parseInt(process.env.MOBILECLAW_WEB_PORT || '3002', 10);

registerChannel('web', (opts: ChannelOpts): Channel | null => {
  let connected = false;
  let server: http.Server | null = null;
  const sseClients: Set<http.ServerResponse> = new Set();

  // Queue of messages from agent to display
  const outboundQueue: Array<{ text: string; timestamp: string }> = [];

  return {
    name: 'web',

    async connect() {
      connected = true;

      opts.onChatMetadata(
        WEB_JID,
        new Date().toISOString(),
        WEB_GROUP_NAME,
        'web',
        false,
      );

      // Auto-register as main group if no groups exist yet,
      // otherwise register as a secondary group
      const groups = opts.registeredGroups();
      if (!groups[WEB_JID]) {
        const hasMain = Object.values(groups).some((g) => g.isMain);
        const group: RegisteredGroup = {
          name: WEB_GROUP_NAME,
          folder: hasMain ? 'web' : 'main',
          trigger: TRIGGER_PATTERN.source,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: !hasMain,
        };
        setRegisteredGroup(WEB_JID, group);
        groups[WEB_JID] = group;
        logger.info(
          { isMain: group.isMain, folder: group.folder },
          'Web channel: registered as group',
        );
      }

      server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${WEB_PORT}`);

        if (url.pathname === '/' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getHtml());
          return;
        }

        if (url.pathname === '/api/send' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const { text } = JSON.parse(body);
              if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing text' }));
                return;
              }

              const msg: NewMessage = {
                id: `web-${crypto.randomUUID()}`,
                chat_jid: WEB_JID,
                sender: 'web-user',
                sender_name: 'You',
                content: text,
                timestamp: new Date().toISOString(),
                is_from_me: false,
              };

              opts.onMessage(WEB_JID, msg);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
          return;
        }

        if (url.pathname === '/api/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });

          // Send any queued messages
          while (outboundQueue.length > 0) {
            const msg = outboundQueue.shift()!;
            res.write(`data: ${JSON.stringify(msg)}\n\n`);
          }

          sseClients.add(res);
          req.on('close', () => {
            sseClients.delete(res);
          });
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      server.listen(WEB_PORT, '0.0.0.0', () => {
        logger.info({ port: WEB_PORT }, 'Web chat channel started');
        console.log(`\nWeb chat UI: http://localhost:${WEB_PORT}`);
        console.log(
          `  (or http://<your-ip>:${WEB_PORT} from another device)\n`,
        );
      });
    },

    async sendMessage(_jid: string, text: string) {
      const msg = { text, timestamp: new Date().toISOString() };

      // Send to all connected SSE clients
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(msg)}\n\n`);
        } catch {
          sseClients.delete(client);
        }
      }

      // Also queue in case no clients connected yet
      if (sseClients.size === 0) {
        outboundQueue.push(msg);
      }
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      return jid === WEB_JID;
    },

    async disconnect() {
      connected = false;
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      if (server) {
        server.close();
        server = null;
      }
      logger.info('Web channel disconnected');
    },
  };
});

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>MobileClaw</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #0a0a0a;
    color: #e0e0e0;
    height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  header {
    background: #1a1a2e;
    padding: 12px 16px;
    border-bottom: 1px solid #333;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header .dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: #4ade80;
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  header h1 { font-size: 16px; font-weight: 600; }
  header .sub { font-size: 12px; color: #888; margin-left: auto; }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .msg {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 16px;
    font-size: 14px;
    line-height: 1.5;
    word-wrap: break-word;
    white-space: pre-wrap;
  }
  .msg.user {
    align-self: flex-end;
    background: #2563eb;
    color: white;
    border-bottom-right-radius: 4px;
  }
  .msg.agent {
    align-self: flex-start;
    background: #1e1e2e;
    border: 1px solid #333;
    border-bottom-left-radius: 4px;
  }
  .msg.agent code {
    background: #2a2a3e;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 13px;
  }
  .msg.agent pre {
    background: #1a1a28;
    padding: 8px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 6px 0;
    font-size: 12px;
  }
  .msg .time {
    font-size: 10px;
    color: #666;
    margin-top: 4px;
  }
  .typing {
    align-self: flex-start;
    color: #888;
    font-size: 13px;
    padding: 8px 14px;
  }
  .typing span {
    animation: blink 1.4s infinite;
  }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink {
    0%, 100% { opacity: 0.2; }
    50% { opacity: 1; }
  }

  #input-area {
    padding: 12px;
    background: #111;
    border-top: 1px solid #333;
    display: flex;
    gap: 8px;
  }
  #input {
    flex: 1;
    background: #1e1e2e;
    border: 1px solid #444;
    border-radius: 20px;
    padding: 10px 16px;
    color: #e0e0e0;
    font-size: 14px;
    outline: none;
    resize: none;
    max-height: 120px;
    line-height: 1.4;
  }
  #input:focus { border-color: #2563eb; }
  #input::placeholder { color: #555; }
  #send {
    background: #2563eb;
    color: white;
    border: none;
    border-radius: 50%;
    width: 40px; height: 40px;
    cursor: pointer;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  #send:hover { background: #1d4ed8; }
  #send:disabled { background: #333; cursor: default; }
</style>
</head>
<body>
<header>
  <div class="dot" id="status-dot"></div>
  <h1>MobileClaw</h1>
  <span class="sub" id="status-text">Connecting...</span>
</header>

<div id="messages"></div>

<div id="input-area">
  <textarea id="input" rows="1" placeholder="Type a message..." autofocus></textarea>
  <button id="send">&#9654;</button>
</div>

<script>
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
let sending = false;

function addMessage(text, type, time) {
  // Remove typing indicator if present
  const typing = document.querySelector('.typing');
  if (typing) typing.remove();

  const div = document.createElement('div');
  div.className = 'msg ' + type;

  // Basic markdown: bold, code blocks, inline code
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

  const timeStr = time ? new Date(time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
  div.innerHTML = html + (timeStr ? '<div class="time">' + timeStr + '</div>' : '');
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTyping() {
  if (document.querySelector('.typing')) return;
  const div = document.createElement('div');
  div.className = 'typing';
  div.innerHTML = '<span>.</span><span>.</span><span>.</span>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || sending) return;

  sending = true;
  sendBtn.disabled = true;
  inputEl.value = '';
  inputEl.style.height = 'auto';

  addMessage(text, 'user');
  showTyping();

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('Send failed');
  } catch (e) {
    addMessage('Failed to send message. Is the server running?', 'agent');
  }

  sending = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// Auto-resize textarea
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

// SSE for agent responses
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    statusDot.style.background = '#4ade80';
    statusText.textContent = 'Connected';
  };
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      addMessage(data.text, 'agent', data.timestamp);
    } catch {}
  };
  es.onerror = () => {
    statusDot.style.background = '#ef4444';
    statusText.textContent = 'Disconnected';
    es.close();
    setTimeout(connectSSE, 3000);
  };
}
connectSSE();
</script>
</body>
</html>`;
}
