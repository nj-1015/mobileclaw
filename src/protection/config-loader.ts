/**
 * MobileClaw Protection Config Loader
 *
 * Reads per-agent protection configs from ~/agents/{name}/config/.
 * These are written by the blueprint apply step and consumed at sandbox launch time.
 */
import fs from 'fs';
import path from 'path';

import { resolvePath } from '../blueprints/loader.js';
import {
  type FilesystemProtection,
  type ProcessProtection,
  type NetworkProtection,
  type ToolProtection,
  type InferenceProtection,
} from '../blueprints/schema.js';
import { logger } from '../logger.js';

const AGENTS_BASE = resolvePath('~/agents');

export interface AgentProtectionConfig {
  filesystem: FilesystemProtection | null;
  process: ProcessProtection | null;
  network: NetworkProtection | null;
  tools: ToolProtection | null;
  inference: InferenceProtection | null;
}

/**
 * Load protection configs for a named agent.
 * Returns null fields if the config files don't exist.
 */
export function loadProtectionConfig(
  blueprintName: string,
): AgentProtectionConfig {
  const configDir = path.join(AGENTS_BASE, blueprintName, 'config');

  return {
    filesystem: loadJsonConfig<FilesystemProtection>(
      path.join(configDir, 'filesystem.json'),
    ),
    process: loadJsonConfig<ProcessProtection>(
      path.join(configDir, 'process.json'),
    ),
    network: loadLiveConfig<NetworkProtection>(
      path.join(configDir, 'live', 'network.json'),
    ),
    tools: loadLiveConfig<ToolProtection>(
      path.join(configDir, 'live', 'tools.json'),
    ),
    inference: loadLiveConfig<InferenceProtection>(
      path.join(configDir, 'live', 'inference.json'),
    ),
  };
}

/**
 * Get the path to the agent's config directory.
 */
export function getAgentConfigDir(blueprintName: string): string {
  return path.join(AGENTS_BASE, blueprintName, 'config');
}

/**
 * Get the path to the agent's live (hot-reloadable) config directory.
 */
export function getAgentLiveConfigDir(blueprintName: string): string {
  return path.join(AGENTS_BASE, blueprintName, 'config', 'live');
}

/**
 * Get the path to the agent's log directory.
 */
export function getAgentLogDir(blueprintName: string): string {
  return path.join(AGENTS_BASE, blueprintName, 'logs');
}

function loadJsonConfig<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    logger.debug({ path: filePath }, 'Protection config not found');
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    logger.warn({ path: filePath, err }, 'Failed to parse protection config');
    return null;
  }
}

// Live configs are the same format but in the live/ subdirectory
const loadLiveConfig = loadJsonConfig;
