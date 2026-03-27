/**
 * MobileClaw Onboard Wizard
 * Interactive 6-step guided setup that generates a blueprint and applies it.
 */
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import { type Blueprint } from '../blueprints/schema.js';
import { createAgentFromBlueprint } from '../blueprints/index.js';
import { resolvePath } from '../blueprints/loader.js';
import { launchAgent } from './commands.js';

function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function choose(
  rl: readline.Interface,
  question: string,
  options: string[],
): Promise<number> {
  return new Promise((resolve) => {
    console.log(question);
    for (let i = 0; i < options.length; i++) {
      console.log(`  [${i + 1}] ${options[i]}`);
    }
    rl.question('  > ', (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(idx);
      } else {
        resolve(0); // Default to first option
      }
    });
  });
}

export async function runOnboard(): Promise<void> {
  const rl = createPrompt();

  console.log('');
  console.log('  +==========================================+');
  console.log('  |       MobileClaw Setup Wizard            |');
  console.log('  +==========================================+');
  console.log('');

  // Step 1: Agent Name
  console.log('  Step 1/6: Agent Name');
  let name = await ask(rl, '  What should we call your agent? > ');
  name =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'my-agent';
  console.log(`  -> ${name}\n`);

  // Step 2: Workspace
  console.log('  Step 2/6: Workspace');
  const wsChoice = await choose(rl, '  Where should the agent work?', [
    `New directory (~/agents/${name}/)`,
    'Mount existing project directory',
  ]);
  let workspacePath = `~/agents/${name}/workspace`;
  const mounts: Array<{ src: string; dst: string; mode: string }> = [];
  if (wsChoice === 1) {
    const mountPath = await ask(rl, '  Path to mount: ');
    if (mountPath) {
      mounts.push({ src: mountPath, dst: '/workspace/project', mode: 'rw' });
    }
  }
  console.log('');

  // Step 3: Inference
  console.log('  Step 3/6: Inference');
  const inferenceChoice = await choose(rl, '  How should the agent think?', [
    'Cloud only (Claude, uses existing auth)',
    'Local only (requires llama.cpp + model)',
    'Hybrid -- local for simple, cloud for complex',
  ]);
  console.log('');

  // Step 4: Network Policy
  console.log('  Step 4/6: Network Policy');
  const networkChoice = await choose(
    rl,
    '  How strict should network access be?',
    [
      'Strict (AI APIs only)',
      'Developer (+ GitHub, npm, docs sites)',
      'Open (all traffic allowed)',
    ],
  );
  console.log('');

  // Step 5: Unknown Requests
  console.log('  Step 5/6: Unknown Requests');
  const unknownChoice = await choose(
    rl,
    '  When the agent tries to access an unlisted site:',
    [
      'Ask me (Android notification with approve/block)',
      'Block silently',
      'Allow once and log',
    ],
  );
  console.log('');

  // Step 6: Mobile Features
  console.log('  Step 6/6: Mobile Features');
  const skills: string[] = [];
  const notifChoice = await ask(
    rl,
    '  Enable notifications on task completion? (Y/n) ',
  );
  if (notifChoice.toLowerCase() !== 'n') skills.push('termux-notifications');
  const batteryChoice = await ask(rl, '  Enable battery-aware mode? (Y/n) ');
  if (batteryChoice.toLowerCase() !== 'n') skills.push('battery-aware');
  console.log('');

  rl.close();

  // Build network allow list based on choice
  const networkAllowLists: Record<
    number,
    Array<{ host: string; rate?: string }>
  > = {
    0: [{ host: 'api.anthropic.com', rate: '60/hour' }],
    1: [
      { host: 'api.anthropic.com', rate: '60/hour' },
      { host: 'api.github.com', rate: '120/hour' },
      { host: 'github.com', rate: '120/hour' },
      { host: 'registry.npmjs.org', rate: '300/hour' },
      { host: 'pypi.org', rate: '100/hour' },
      { host: 'stackoverflow.com' },
      { host: 'developer.mozilla.org' },
      { host: 'docs.python.org' },
    ],
    2: [],
  };

  const unknownActions: Record<number, string> = {
    0: 'ask_operator',
    1: 'block',
    2: 'allow_once',
  };

  // Build blueprint
  const blueprint: Record<string, unknown> = {
    apiVersion: 'mobileclaw/v1',
    kind: 'AgentBlueprint',
    metadata: {
      name,
      version: '1.0.0',
      description: `Agent created via onboard wizard`,
    },
    sandbox: {
      runtime: 'termux-proot',
      workspace: { path: workspacePath, size_limit_mb: 2048 },
      mounts,
      env: {},
    },
    protection: {
      network: {
        mode: networkChoice === 2 ? 'open' : 'allowlist',
        allow: networkAllowLists[networkChoice] || [],
        unknown_host_action: unknownActions[unknownChoice] || 'block',
        log_all_requests: true,
      },
    },
    skills,
    channels: [{ type: 'terminal' }],
  };

  // Add inference config if local/hybrid
  if (inferenceChoice === 1 || inferenceChoice === 2) {
    (blueprint.protection as Record<string, unknown>).inference = {
      gateway_port: 8080,
      primary: {
        engine: 'llama_cpp',
        model: 'gemma-2b-it-q4_k_m',
        model_path: '~/models/',
        context_length: 2048,
      },
      ...(inferenceChoice === 2
        ? {
            fallback: {
              engine: 'cloud',
              provider: 'anthropic',
              model: 'claude-sonnet-4-20250514',
            },
            routing: {
              simple_tasks: 'local',
              complex_tasks: 'cloud',
              sensitive_content: 'local',
            },
          }
        : {
            routing: {
              simple_tasks: 'local',
              complex_tasks: 'local',
              sensitive_content: 'local',
            },
          }),
      cost_tracking: {
        enabled: true,
        max_cloud_cost_per_day_usd: 5.0,
      },
    };
  }

  // Show summary
  const networkDesc = ['Strict', 'Developer', 'Open'][networkChoice];
  const inferenceDesc = ['Cloud only', 'Local only', 'Hybrid'][inferenceChoice];
  console.log('  ──────────────────────────────────────────────');
  console.log(`  Agent:      ${name}`);
  console.log(`  Sandbox:    proot (workspace: ${workspacePath})`);
  console.log(`  Inference:  ${inferenceDesc}`);
  console.log(
    `  Network:    ${networkDesc} (${unknownActions[unknownChoice]})`,
  );
  console.log(
    `  Skills:     ${skills.length > 0 ? skills.join(', ') : 'none'}`,
  );
  console.log('  ──────────────────────────────────────────────');
  console.log('');

  // Write blueprint YAML and apply
  const blueprintDir = resolvePath('~/agents');
  fs.mkdirSync(blueprintDir, { recursive: true });
  const blueprintPath = path.join(blueprintDir, `${name}-blueprint.yaml`);
  fs.writeFileSync(blueprintPath, YAML.stringify(blueprint));

  let agentDir: string;
  try {
    const result = createAgentFromBlueprint(blueprintPath, { force: true });
    agentDir = result.agentDir;
    console.log(`\n  Agent "${name}" created!`);
    console.log(`  Directory: ${result.agentDir}`);
    console.log(`  Workspace: ${result.workspaceDir}`);
  } catch (err) {
    console.error(
      `\n  Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Ask to launch
  const rl2 = createPrompt();
  const launchChoice = await ask(rl2, '\n  Launch now? (Y/n) ');
  rl2.close();

  if (launchChoice.toLowerCase() !== 'n') {
    await launchAgent(name, agentDir);
  } else {
    console.log(`\n  Start it later with: mobileclaw ${name} launch\n`);
  }
}
