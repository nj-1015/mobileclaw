/**
 * MobileClaw Agent Commands
 * Handles: mobileclaw <name> <action> [args...]
 */
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import YAML from 'yaml';

import { loadActiveBlueprint, agentExists } from '../blueprints/apply.js';
import { resolvePath } from '../blueprints/loader.js';
import { handleApprovalCli } from '../approval/index.js';

const AGENTS_BASE = resolvePath('~/agents');

export async function runAgentCommand(
  agentName: string,
  action: string,
  args: string[],
): Promise<void> {
  // Validate agent exists
  if (!agentExists(agentName) && action !== 'help') {
    console.error(`Agent "${agentName}" not found.`);
    console.error('Run: mobileclaw list');
    process.exit(1);
  }

  const agentDir = path.join(AGENTS_BASE, agentName);

  switch (action) {
    case 'status':
      showStatus(agentName, agentDir);
      break;

    case 'launch':
      await launchAgent(agentName, agentDir);
      break;

    case 'stop':
      console.log(`Stopping agent "${agentName}"...`);
      // Kill any running sandbox processes for this agent
      try {
        const { execSync } = await import('child_process');
        execSync(
          `pkill -f "mobileclaw-sandbox-${agentName}" 2>/dev/null || true`,
          { stdio: 'pipe' },
        );
        console.log('Agent stopped.');
      } catch {
        console.log('No running processes found.');
      }
      break;

    case 'logs': {
      const logsDir = path.join(agentDir, 'logs');
      if (!fs.existsSync(logsDir)) {
        console.log('No logs yet.');
        break;
      }
      const logFiles = fs
        .readdirSync(logsDir)
        .filter((f) => f.endsWith('.log') || f.endsWith('.jsonl'))
        .sort()
        .reverse()
        .slice(0, 5);

      if (logFiles.length === 0) {
        console.log('No logs yet.');
        break;
      }

      console.log(`\nRecent logs for "${agentName}":\n`);
      for (const file of logFiles) {
        console.log(`--- ${file} ---`);
        const content = fs.readFileSync(path.join(logsDir, file), 'utf-8');
        // Show last 20 lines
        const lines = content.trim().split('\n');
        const show = lines.slice(-20);
        console.log(show.join('\n'));
        console.log('');
      }
      break;
    }

    case 'blueprint': {
      const subAction = args[0] || 'show';
      if (subAction === 'show') {
        const bp = loadActiveBlueprint(agentName);
        if (!bp) {
          console.error('No active blueprint found.');
          process.exit(1);
        }
        console.log(YAML.stringify(bp));
      } else if (subAction === 'diff') {
        console.log('Blueprint diff not yet implemented.');
      } else {
        console.error(`Unknown blueprint action: ${subAction}`);
      }
      break;
    }

    case 'network': {
      const subAction = args[0];
      const liveDir = path.join(agentDir, 'config', 'live');
      const networkFile = path.join(liveDir, 'network.json');

      if (!fs.existsSync(networkFile)) {
        console.error('No network config found.');
        process.exit(1);
      }

      const policy = JSON.parse(fs.readFileSync(networkFile, 'utf-8'));

      if (subAction === 'allow' && args[1]) {
        const domain = args[1];
        if (!policy.allow) policy.allow = [];
        if (!policy.allow.some((e: { host: string }) => e.host === domain)) {
          policy.allow.push({ host: domain });
          fs.writeFileSync(networkFile, JSON.stringify(policy, null, 2));
          console.log(`Added ${domain} to allowlist. Reload to take effect.`);
        } else {
          console.log(`${domain} already in allowlist.`);
        }
      } else if (subAction === 'block' && args[1]) {
        const domain = args[1];
        policy.allow = (policy.allow || []).filter(
          (e: { host: string }) => e.host !== domain,
        );
        fs.writeFileSync(networkFile, JSON.stringify(policy, null, 2));
        console.log(`Removed ${domain} from allowlist.`);
      } else if (subAction === 'reload') {
        // Touch a sentinel file that the running proxy watches
        const sentinelFile = path.join(liveDir, '.reload');
        fs.writeFileSync(sentinelFile, new Date().toISOString());
        console.log('Network policy reload triggered.');
      } else if (subAction === 'show' || !subAction) {
        console.log(`\nNetwork policy for "${agentName}":\n`);
        console.log(`  Mode: ${policy.mode}`);
        console.log(`  Unknown hosts: ${policy.unknown_host_action}`);
        console.log(`  Allowed hosts (${(policy.allow || []).length}):`);
        for (const entry of policy.allow || []) {
          console.log(
            `    - ${entry.host}${entry.rate ? ` (${entry.rate})` : ''}`,
          );
        }
        console.log('');
      } else {
        console.error(
          'Usage: mobileclaw <name> network [show|allow <domain>|block <domain>|reload]',
        );
      }
      break;
    }

    case 'approve':
      handleApprovalCli(args);
      break;

    default:
      console.error(`Unknown action: ${action}`);
      console.error(
        'Actions: launch, stop, status, logs, blueprint, network, approve',
      );
      process.exit(1);
  }
}

export async function launchAgent(
  agentName: string,
  agentDir: string,
): Promise<void> {
  const bp = loadActiveBlueprint(agentName);
  if (!bp) {
    console.error(`No blueprint found for agent "${agentName}".`);
    process.exit(1);
  }

  const configDir = path.join(agentDir, 'config');
  const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);

  // Update the main group's CLAUDE.md with the agent's name
  const cwd = process.cwd();
  const groupDir = path.join(cwd, 'groups', 'main');
  fs.mkdirSync(groupDir, { recursive: true });
  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    let content = fs.readFileSync(claudeMd, 'utf-8');
    content = content.replace(/^# \w+/m, `# ${displayName}`);
    content = content.replace(
      /You are \w+, a personal assistant/m,
      `You are ${displayName}, a personal assistant`,
    );
    content = content.replace(/@Andy/g, `@${displayName}`);
    content = content.replace(/AssistantName/g, displayName);
    fs.writeFileSync(claudeMd, content);
  } else {
    fs.writeFileSync(
      claudeMd,
      `# ${displayName}\n\nYou are ${displayName}, a personal assistant running on MobileClaw. You help with tasks, answer questions, and can interact with the Android device via mobile tools (notifications, battery, clipboard, vibrate).\n`,
    );
  }

  const networkHosts = bp.protection.network.allow.length;
  const networkMode = bp.protection.network.mode;

  console.log('');
  console.log('  +==========================================+');
  console.log(`  |  MobileClaw: ${agentName}`);
  console.log('  +==========================================+');
  console.log(`  |  Blueprint: ${bp.metadata.name} v${bp.metadata.version}`);
  console.log(`  |  Network:   ${networkMode} (${networkHosts} hosts)`);
  console.log(
    `  |  Skills:    ${bp.skills.length > 0 ? bp.skills.join(', ') : 'none'}`,
  );
  console.log(`  |  Web UI:    http://localhost:3002`);
  console.log('  +==========================================+');
  console.log('');

  // Write agent name to .env so config.ts picks it up
  const envFile = path.join(cwd, '.env');
  // Read existing .env, update or add ASSISTANT_NAME
  let envContent = '';
  if (fs.existsSync(envFile)) {
    envContent = fs.readFileSync(envFile, 'utf-8');
    if (envContent.includes('ASSISTANT_NAME=')) {
      envContent = envContent.replace(
        /ASSISTANT_NAME=.*/,
        `ASSISTANT_NAME=${displayName}`,
      );
    } else {
      envContent += `\nASSISTANT_NAME=${displayName}\n`;
    }
  } else {
    envContent = `ASSISTANT_NAME=${displayName}\n`;
  }
  fs.writeFileSync(envFile, envContent);

  // Find the orchestrator entry point
  const indexJs = path.join(cwd, 'dist', 'index.js');
  if (!fs.existsSync(indexJs)) {
    console.error('Build not found. Run: npx tsc');
    process.exit(1);
  }

  // Spawn the orchestrator with blueprint env vars
  const child: ChildProcess = spawn('node', [indexJs], {
    cwd: cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      MOBILECLAW_AGENT: agentName,
      MOBILECLAW_BLUEPRINT_DIR: configDir,
      ASSISTANT_NAME: displayName,
    },
  });

  // Forward signals to child
  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  // Wait for child to exit
  return new Promise((resolve) => {
    child.on('close', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

function showStatus(agentName: string, agentDir: string): void {
  const bp = loadActiveBlueprint(agentName);
  if (!bp) {
    console.error('No active blueprint found.');
    process.exit(1);
  }

  const configFile = path.join(agentDir, 'config', 'agent.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

  // Check if running
  let running = false;
  try {
    const { execSync } = require('child_process');
    const ps = execSync(
      `pgrep -f "mobileclaw-sandbox-${agentName}" 2>/dev/null || true`,
      {
        encoding: 'utf-8',
      },
    ).trim();
    running = ps.length > 0;
  } catch {
    /* ignore */
  }

  // Network stats
  const networkLogFile = path.join(agentDir, 'logs', 'network-audit.jsonl');
  let netAllowed = 0,
    netBlocked = 0;
  if (fs.existsSync(networkLogFile)) {
    const lines = fs.readFileSync(networkLogFile, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.action === 'allow') netAllowed++;
        else if (e.action === 'block') netBlocked++;
      } catch {
        /* skip */
      }
    }
  }

  // Cost stats
  const today = new Date().toISOString().split('T')[0];
  const costFile = path.join(agentDir, 'logs', `costs-${today}.jsonl`);
  let todaySpend = 0;
  if (fs.existsSync(costFile)) {
    const lines = fs.readFileSync(costFile, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        todaySpend += e.costUsd || 0;
      } catch {
        /* skip */
      }
    }
  }

  console.log(`
  +-- ${agentName} ${'─'.repeat(Math.max(0, 40 - agentName.length))}+
  | Status:    ${running ? 'Running' : 'Stopped'}
  | Blueprint: ${bp.metadata.name} v${bp.metadata.version}
  | Created:   ${config.created_at || 'unknown'}
  +──────────────────────────────────────────+
  | Network
  |   Allowed: ${netAllowed} requests
  |   Blocked: ${netBlocked} requests
  |   Policy:  ${bp.protection.network.mode} (${bp.protection.network.allow.length} hosts)
  +──────────────────────────────────────────+
  | Inference
  |   Today:   $${todaySpend.toFixed(2)}
  |   Budget:  $${bp.protection.inference?.cost_tracking?.max_cloud_cost_per_day_usd?.toFixed(2) || 'unlimited'}/day
  +──────────────────────────────────────────+
  | Skills: ${config.skills?.join(', ') || 'none'}
  +──────────────────────────────────────────+
`);
}
