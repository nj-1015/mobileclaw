/**
 * MobileClaw Blueprint Apply
 * Step 4: APPLY — Create sandbox dirs, write configs, register agent.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import { type Blueprint } from './schema.js';
import { resolvePath } from './loader.js';
import { logger } from '../logger.js';

/** Where agent data lives */
const AGENTS_BASE = resolvePath('~/agents');

export interface ApplyResult {
  agentDir: string;
  workspaceDir: string;
  blueprintCopy: string;
  configFile: string;
}

/**
 * Apply a validated blueprint: create directories, write config files.
 */
export function applyBlueprint(blueprint: Blueprint): ApplyResult {
  const name = blueprint.metadata.name;
  const agentDir = path.join(AGENTS_BASE, name);
  const workspaceDir = resolvePath(blueprint.sandbox.workspace.path);

  // Create directory structure
  const dirs = [
    agentDir,
    path.join(agentDir, 'config'),
    path.join(agentDir, 'logs'),
    path.join(agentDir, 'data'),
    workspaceDir,
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write the blueprint copy (frozen at creation time)
  const blueprintCopy = path.join(agentDir, 'config', 'blueprint.yaml');
  fs.writeFileSync(blueprintCopy, YAML.stringify(blueprint));

  // Write protection configs as separate files for hot-reloading
  // Layers 1 & 2 are locked at creation (read-only reference)
  const filesystemConfig = path.join(agentDir, 'config', 'filesystem.json');
  fs.writeFileSync(
    filesystemConfig,
    JSON.stringify(blueprint.protection.filesystem, null, 2),
  );

  const processConfig = path.join(agentDir, 'config', 'process.json');
  fs.writeFileSync(
    processConfig,
    JSON.stringify(blueprint.protection.process, null, 2),
  );

  // Layers 3 & 4 are hot-reloadable — written to a 'live' directory
  const liveDir = path.join(agentDir, 'config', 'live');
  fs.mkdirSync(liveDir, { recursive: true });

  const networkConfig = path.join(liveDir, 'network.json');
  fs.writeFileSync(
    networkConfig,
    JSON.stringify(blueprint.protection.network, null, 2),
  );

  if (blueprint.protection.inference) {
    const inferenceConfig = path.join(liveDir, 'inference.json');
    fs.writeFileSync(
      inferenceConfig,
      JSON.stringify(blueprint.protection.inference, null, 2),
    );
  }

  if (blueprint.protection.tools) {
    const toolsConfig = path.join(liveDir, 'tools.json');
    fs.writeFileSync(
      toolsConfig,
      JSON.stringify(blueprint.protection.tools, null, 2),
    );
  }

  // Write sandbox environment file
  if (Object.keys(blueprint.sandbox.env).length > 0) {
    const envFile = path.join(agentDir, 'config', 'sandbox.env');
    const envContent = Object.entries(blueprint.sandbox.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    fs.writeFileSync(envFile, envContent + '\n');
  }

  // Write agent runtime config (used by the orchestrator to launch this agent)
  const configFile = path.join(agentDir, 'config', 'agent.json');
  const agentConfig = {
    name,
    version: blueprint.metadata.version,
    created_at: new Date().toISOString(),
    sandbox: {
      runtime: blueprint.sandbox.runtime,
      workspace: workspaceDir,
      mounts: blueprint.sandbox.mounts.map((m) => ({
        src: resolvePath(m.src),
        dst: m.dst,
        mode: m.mode,
      })),
    },
    skills: blueprint.skills,
    channels: blueprint.channels,
  };
  fs.writeFileSync(configFile, JSON.stringify(agentConfig, null, 2));

  logger.info(
    {
      agent: name,
      agentDir,
      workspaceDir,
      mountCount: blueprint.sandbox.mounts.length,
      skills: blueprint.skills,
    },
    'Blueprint applied',
  );

  return { agentDir, workspaceDir, blueprintCopy, configFile };
}

/**
 * Check if an agent already exists from a previous apply.
 */
export function agentExists(name: string): boolean {
  return fs.existsSync(path.join(AGENTS_BASE, name, 'config', 'agent.json'));
}

/**
 * Load the active blueprint for an existing agent.
 */
export function loadActiveBlueprint(name: string): Blueprint | null {
  const blueprintPath = path.join(
    AGENTS_BASE,
    name,
    'config',
    'blueprint.yaml',
  );
  if (!fs.existsSync(blueprintPath)) return null;
  const raw = fs.readFileSync(blueprintPath, 'utf-8');
  return YAML.parse(raw) as Blueprint;
}

/**
 * List all applied agents.
 */
export function listAgents(): string[] {
  if (!fs.existsSync(AGENTS_BASE)) return [];
  return fs
    .readdirSync(AGENTS_BASE)
    .filter((name) =>
      fs.existsSync(path.join(AGENTS_BASE, name, 'config', 'agent.json')),
    );
}
