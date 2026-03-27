/**
 * MobileClaw Mobile Skills — Termux:API powered tools
 *
 * These run as MCP tools available to the agent inside the sandbox.
 * They use Termux:API to interact with the Android device.
 */
import { execSync } from 'child_process';
import fs from 'fs';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

function errorResult(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }], isError: true };
}

function run(cmd: string, timeout = 10000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new Error(
      `Command failed: ${cmd}\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';

function isTermuxApiAvailable(): boolean {
  return fs.existsSync(`${TERMUX_BIN}/termux-battery-status`);
}

// ─── Tool Definitions ────────────────────────────────────

export const MOBILE_TOOLS = [
  {
    name: 'device_info',
    description:
      'Get Android device information: battery level, storage, network, device model. Shows what makes MobileClaw unique — it runs on a real phone.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'send_notification',
    description:
      'Send an Android notification to the user via Termux:API. Use for task completion alerts, reminders, or important updates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Notification title' },
        content: { type: 'string', description: 'Notification body text' },
        priority: {
          type: 'string',
          enum: ['low', 'default', 'high'],
          description: 'Notification priority',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'battery_status',
    description:
      'Get detailed battery information: percentage, charging status, temperature, health.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'device_storage',
    description: 'Get storage usage information for the device.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'clipboard_get',
    description: 'Read the current Android clipboard contents.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'clipboard_set',
    description: 'Set the Android clipboard to the given text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to copy to clipboard' },
      },
      required: ['text'],
    },
  },
  {
    name: 'vibrate',
    description: "Vibrate the phone. Use to get the user's attention.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        duration_ms: {
          type: 'number',
          description: 'Vibration duration in milliseconds (default: 500)',
        },
      },
    },
  },
  {
    name: 'toast',
    description: 'Show a brief Android toast message on screen.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Toast message text' },
      },
      required: ['text'],
    },
  },
  {
    name: 'request_network_access',
    description:
      'Request access to an external domain. MobileClaw uses a network allowlist for security. If the domain is not allowed, the phone owner gets an Android notification to approve or block the request. You MUST call this before accessing any external URL/API. Allowed domains: api.anthropic.com. All others require approval.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        host: {
          type: 'string',
          description: 'The domain to access (e.g. api.github.com)',
        },
        reason: {
          type: 'string',
          description: 'Why you need to access this domain',
        },
      },
      required: ['host', 'reason'],
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────

export function handleMobileTool(
  name: string,
  args: Record<string, unknown>,
): ToolResult | Promise<ToolResult> {
  // Network access approval works regardless of Termux:API
  if (name === 'request_network_access') {
    return requestNetworkAccess(args.host as string, args.reason as string);
  }

  if (!isTermuxApiAvailable()) {
    return handleFallback(name, args);
  }

  try {
    switch (name) {
      case 'device_info':
        return getDeviceInfo();
      case 'send_notification':
        return sendNotification(
          args.title as string,
          args.content as string,
          args.priority as string,
        );
      case 'battery_status':
        return getBatteryStatus();
      case 'device_storage':
        return getStorageInfo();
      case 'clipboard_get':
        return getClipboard();
      case 'clipboard_set':
        return setClipboard(args.text as string);
      case 'vibrate':
        return doVibrate(args.duration_ms as number);
      case 'toast':
        return showToast(args.text as string);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(
      `Tool error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function getDeviceInfo(): ToolResult {
  const battery = JSON.parse(run(`${TERMUX_BIN}/termux-battery-status`));
  const uname = run('uname -m');
  const hostname = run('hostname 2>/dev/null || echo "android"');

  let storage = '';
  try {
    storage = run('df -h $HOME 2>/dev/null | tail -1');
  } catch {
    storage = 'unavailable';
  }

  let network = 'unknown';
  try {
    const wifi = JSON.parse(
      run(`${TERMUX_BIN}/termux-wifi-connectioninfo 2>/dev/null`),
    );
    network = wifi.ssid
      ? `WiFi: ${wifi.ssid} (${wifi.link_speed_mbps || '?'}Mbps)`
      : 'Not connected';
  } catch {
    try {
      run('ping -c 1 -W 2 8.8.8.8 2>/dev/null');
      network = 'Connected (type unknown)';
    } catch {
      network = 'Offline';
    }
  }

  const info = [
    `Platform: Android (${uname})`,
    `Hostname: ${hostname}`,
    `Battery: ${battery.percentage}% (${battery.status})`,
    `Temperature: ${battery.temperature}°C`,
    `Network: ${network}`,
    `Storage: ${storage}`,
    `Node: ${process.version}`,
    `MobileClaw: Running in Termux with proot sandbox`,
  ].join('\n');

  return text(info);
}

function getBatteryStatus(): ToolResult {
  const battery = JSON.parse(run(`${TERMUX_BIN}/termux-battery-status`));
  return text(JSON.stringify(battery, null, 2));
}

function sendNotification(
  title: string,
  content: string,
  priority?: string,
): ToolResult {
  const prio = priority || 'default';
  const cmd = `${TERMUX_BIN}/termux-notification --title "${title.replace(/"/g, '\\"')}" --content "${content.replace(/"/g, '\\"')}" --priority ${prio}`;
  run(cmd);
  return text(`Notification sent: "${title}"`);
}

function getStorageInfo(): ToolResult {
  const df = run('df -h $HOME $PREFIX /data 2>/dev/null || df -h $HOME');
  return text(df);
}

function getClipboard(): ToolResult {
  const clip = run(`${TERMUX_BIN}/termux-clipboard-get`);
  return text(clip || '(clipboard is empty)');
}

function setClipboard(content: string): ToolResult {
  run(`${TERMUX_BIN}/termux-clipboard-set "${content.replace(/"/g, '\\"')}"`);
  return text('Copied to clipboard.');
}

function doVibrate(durationMs?: number): ToolResult {
  const ms = durationMs || 500;
  run(`${TERMUX_BIN}/termux-vibrate -d ${ms}`);
  return text(`Vibrated for ${ms}ms.`);
}

function showToast(message: string): ToolResult {
  run(`${TERMUX_BIN}/termux-toast "${message.replace(/"/g, '\\"')}"`);
  return text(`Toast shown: "${message}"`);
}

// ─── Network Access Approval ────────────────────────────

const ALLOWED_DOMAINS = new Set(['api.anthropic.com']);

const IPC_DIR =
  process.env.MOBILECLAW_APPROVAL_DIR || '/tmp/mobileclaw-approvals';

async function requestNetworkAccess(
  host: string,
  reason: string,
): Promise<ToolResult> {
  // Check allowlist first
  if (ALLOWED_DOMAINS.has(host)) {
    return text(`ACCESS GRANTED: ${host} is in the allowlist.`);
  }

  const id = Math.random().toString(36).slice(2, 10);
  const responsesDir = `${IPC_DIR}/responses`;

  // Create IPC dirs
  try {
    fs.mkdirSync(responsesDir, { recursive: true });
  } catch {
    /* exists */
  }

  // Send Android notification with approval buttons
  // Write helper scripts for each button action (Termux notification actions
  // run in a limited context, so we use standalone scripts)
  const hasTermux = isTermuxApiAvailable();
  if (hasTermux) {
    const scriptsDir = `${IPC_DIR}/scripts`;
    try {
      fs.mkdirSync(scriptsDir, { recursive: true });
    } catch {
      /* exists */
    }

    for (const decision of ['once', 'always', 'block']) {
      const script = `${scriptsDir}/${id}-${decision}.sh`;
      fs.writeFileSync(
        script,
        [
          '#!/data/data/com.termux/files/usr/bin/sh',
          `mkdir -p ${responsesDir}`,
          `printf '{"id":"${id}","decision":"${decision}"}' > ${responsesDir}/${id}.json`,
          `${TERMUX_BIN}/termux-toast "MobileClaw: ${decision === 'block' ? 'Blocked' : 'Allowed'} ${host}"`,
        ].join('\n'),
      );
      fs.chmodSync(script, 0o755);
    }

    try {
      run(
        [
          `${TERMUX_BIN}/termux-notification`,
          `--id mobileclaw-net-${id}`,
          `--title "MobileClaw: Network Request"`,
          `--content "Agent wants to access: ${host} - ${reason}"`,
          `--button1 "Allow Once"`,
          `--button1-action "${scriptsDir}/${id}-once.sh"`,
          `--button2 "Always Allow"`,
          `--button2-action "${scriptsDir}/${id}-always.sh"`,
          `--button3 "Block"`,
          `--button3-action "${scriptsDir}/${id}-block.sh"`,
          '--priority high',
          '--vibrate 200',
        ].join(' '),
        15000,
      );
    } catch (err) {
      return errorResult(
        `Failed to send approval notification: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Also show a toast
  if (hasTermux) {
    try {
      run(
        `${TERMUX_BIN}/termux-toast "MobileClaw: Approve access to ${host}?"`,
      );
    } catch {
      /* ignore */
    }
  }

  // Poll for response (up to 60 seconds)
  const deadline = Date.now() + 60000;
  const responseFile = `${responsesDir}/${id}.json`;

  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        fs.unlinkSync(responseFile);

        // Dismiss notification
        if (hasTermux) {
          try {
            run(
              `${TERMUX_BIN}/termux-notification-remove "mobileclaw-net-${id}"`,
            );
          } catch {
            /* ignore */
          }
        }

        if (data.decision === 'block') {
          return text(
            `ACCESS DENIED: The phone owner blocked access to ${host}.`,
          );
        }

        if (data.decision === 'always') {
          ALLOWED_DOMAINS.add(host);
          return text(
            `ACCESS GRANTED: ${host} was approved and added to the permanent allowlist.`,
          );
        }

        // 'once'
        return text(
          `ACCESS GRANTED: ${host} was approved for this request only.`,
        );
      } catch {
        // Malformed response, keep polling
      }
    }

    // Sleep 500ms
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Timeout — default to block
  if (hasTermux) {
    try {
      run(`${TERMUX_BIN}/termux-notification-remove "mobileclaw-net-${id}"`);
    } catch {
      /* ignore */
    }
  }
  return text(
    `ACCESS DENIED: Approval timed out after 60 seconds. Access to ${host} was blocked.`,
  );
}

// ─── Fallback when Termux:API not installed ────────────

function handleFallback(
  name: string,
  args: Record<string, unknown>,
): ToolResult {
  switch (name) {
    case 'device_info': {
      const os = require('os');
      return text(
        [
          `Platform: ${os.platform()} (${os.arch()})`,
          `Hostname: ${os.hostname()}`,
          `RAM: ${Math.round(os.freemem() / 1024 / 1024)}MB free / ${Math.round(os.totalmem() / 1024 / 1024)}MB total`,
          `CPUs: ${os.cpus().length}x ${os.cpus()[0]?.model || 'unknown'}`,
          `Node: ${process.version}`,
          `Uptime: ${Math.round(os.uptime() / 60)} minutes`,
          `Note: Install termux-api package for full device info (battery, network, etc.)`,
        ].join('\n'),
      );
    }
    case 'battery_status':
      return text('Termux:API not installed. Run: pkg install termux-api');
    case 'send_notification':
      return text(
        `[Notification would be sent] Title: ${args.title}, Content: ${args.content}`,
      );
    case 'clipboard_get':
      return text('Termux:API not installed. Run: pkg install termux-api');
    case 'clipboard_set':
      return text(`[Clipboard would be set to: ${args.text}]`);
    case 'vibrate':
      return text('[Phone would vibrate]');
    case 'toast':
      return text(`[Toast would show: ${args.text}]`);
    case 'device_storage': {
      try {
        const df = run('df -h $HOME 2>/dev/null | tail -1');
        return text(df);
      } catch {
        return text('Storage info unavailable');
      }
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
