/**
 * MobileClaw Blueprint Planner
 * Step 3: PLAN — Check resources and show what will be created/changed.
 */
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

import { type Blueprint } from './schema.js';
import { resolvePath } from './loader.js';

export interface PlanResult {
  feasible: boolean;
  issues: string[]; // Blockers
  warnings: string[]; // Non-fatal
  actions: string[]; // What will be created/changed
  resources: ResourceCheck;
}

export interface ResourceCheck {
  availableRamMb: number;
  requiredRamMb: number;
  availableDiskMb: number;
  requiredDiskMb: number;
  prootAvailable: boolean;
  localModelReady: boolean | null; // null = no local model configured
  workspaceDirExists: boolean;
}

export function planBlueprint(blueprint: Blueprint): PlanResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const actions: string[] = [];

  // Check proot
  let prootAvailable = false;
  try {
    execSync('proot --version', { stdio: 'pipe', timeout: 3000 });
    prootAvailable = true;
  } catch {
    issues.push('proot not found — run: pkg install proot');
  }

  // Check RAM
  const totalRamMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeRamMb = Math.round(os.freemem() / 1024 / 1024);
  const requiredRamMb = blueprint.protection.process.max_memory_mb;
  if (freeRamMb < requiredRamMb) {
    warnings.push(
      `Low RAM: ${freeRamMb}MB free, blueprint requests ${requiredRamMb}MB limit. ` +
        `Total: ${totalRamMb}MB.`,
    );
  }

  // Check disk
  let availableDiskMb = 0;
  try {
    const dfOutput = execSync('df -m . 2>/dev/null | tail -1', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    const parts = dfOutput.split(/\s+/);
    availableDiskMb = parseInt(parts[3] || '0', 10);
  } catch {
    availableDiskMb = -1; // Unknown
  }
  const requiredDiskMb = blueprint.sandbox.workspace.size_limit_mb;
  if (availableDiskMb > 0 && availableDiskMb < requiredDiskMb) {
    warnings.push(
      `Low disk: ${availableDiskMb}MB available, blueprint requests ${requiredDiskMb}MB.`,
    );
  }

  // Check workspace directory
  const workspacePath = resolvePath(blueprint.sandbox.workspace.path);
  const workspaceDirExists = fs.existsSync(workspacePath);
  if (!workspaceDirExists) {
    actions.push(`Create workspace: ${workspacePath}`);
  }

  // Check mounts
  for (const mount of blueprint.sandbox.mounts) {
    const srcPath = resolvePath(mount.src);
    if (!fs.existsSync(srcPath)) {
      warnings.push(`Mount source doesn't exist: ${mount.src} (${srcPath})`);
    }
    actions.push(`Bind mount: ${mount.src} → ${mount.dst} (${mount.mode})`);
  }

  // Check local model (if inference configured)
  let localModelReady: boolean | null = null;
  if (blueprint.protection.inference?.primary?.engine === 'llama_cpp') {
    const modelPath = blueprint.protection.inference.primary.model_path;
    if (modelPath) {
      const resolved = resolvePath(modelPath);
      localModelReady = fs.existsSync(resolved);
      if (!localModelReady) {
        warnings.push(
          `Local model path not found: ${modelPath} — download model before launch`,
        );
      }
    } else {
      localModelReady = false;
      warnings.push('Local inference configured but no model_path specified');
    }
  }

  // Plan actions
  actions.push(`Create sandbox directories for "${blueprint.metadata.name}"`);
  actions.push(
    `Configure ${blueprint.protection.network.mode} network policy (${blueprint.protection.network.allow.length} allowed hosts)`,
  );

  if (blueprint.protection.inference) {
    actions.push(
      `Set up inference gateway on port ${blueprint.protection.inference.gateway_port}`,
    );
  }

  for (const skill of blueprint.skills) {
    actions.push(`Enable skill: ${skill}`);
  }

  for (const channel of blueprint.channels) {
    actions.push(`Configure channel: ${channel.type}`);
  }

  const feasible = issues.length === 0;

  return {
    feasible,
    issues,
    warnings,
    actions,
    resources: {
      availableRamMb: freeRamMb,
      requiredRamMb,
      availableDiskMb,
      requiredDiskMb,
      prootAvailable,
      localModelReady,
      workspaceDirExists,
    },
  };
}
