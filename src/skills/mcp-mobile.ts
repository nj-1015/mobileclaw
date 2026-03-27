#!/usr/bin/env node
/**
 * MobileClaw Mobile Skills MCP Server
 *
 * Stdio-based MCP server that exposes Android/Termux tools to the agent.
 * The agent-runner adds this as an MCP server so the agent can call
 * device_info, send_notification, battery_status, etc.
 */
import { MOBILE_TOOLS, handleMobileTool } from './mobile-tools.js';

// Simple stdio JSON-RPC MCP server
process.stdin.setEncoding('utf-8');

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // Parse newline-delimited JSON-RPC messages
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch {
      // Skip malformed
    }
  }
});

function respond(id: unknown, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id: unknown, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

function handleMessage(msg: {
  jsonrpc: string;
  id?: unknown;
  method: string;
  params?: unknown;
}): void {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'mobileclaw-mobile',
          version: '1.0.0',
        },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      respond(id, {
        tools: MOBILE_TOOLS,
      });
      break;

    case 'tools/call': {
      const p = params as { name: string; arguments?: Record<string, unknown> };
      const result = handleMobileTool(p.name, p.arguments || {});
      // Handle both sync and async results
      Promise.resolve(result).then((r) => respond(id, r));
      break;
    }

    default:
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
  }
}
