/**
 * MobileClaw Layer 1: Filesystem Protection (Locked at Creation)
 *
 * Generates proot bind-mount arguments that restrict the agent's view
 * of the host filesystem. Once created, the config is immutable.
 */
import fs from 'fs';
import path from 'path';
import { type FilesystemProtection } from '../blueprints/schema.js';
import { resolvePath } from '../blueprints/loader.js';
import { logger } from '../logger.js';

/** Simple glob matcher: supports * (single segment) and ** (any depth) */
function globMatch(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regexStr}$`).test(filePath);
}

export interface SandboxMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface FilesystemSandbox {
  /** proot CLI arguments for bind mounts */
  prootArgs: string[];
  /** All mounts for logging */
  mounts: SandboxMount[];
  /** Frozen config — never changes after creation */
  config: FilesystemProtection;
}

/**
 * Build the proot filesystem sandbox from a blueprint's sandbox + protection config.
 */
export function buildFilesystemSandbox(opts: {
  agentName: string;
  workspacePath: string;
  mounts: Array<{ src: string; dst: string; mode: string }>;
  protection: FilesystemProtection;
  dataDir: string;
}): FilesystemSandbox {
  const prootArgs: string[] = [];
  const allMounts: SandboxMount[] = [];

  // Workspace mount (always rw)
  const workspaceHost = resolvePath(opts.workspacePath);
  fs.mkdirSync(workspaceHost, { recursive: true });
  prootArgs.push(`--bind=${workspaceHost}:/workspace`);
  allMounts.push({
    hostPath: workspaceHost,
    containerPath: '/workspace',
    readonly: false,
  });

  // Blueprint-defined mounts
  for (const mount of opts.mounts) {
    const hostPath = resolvePath(mount.src);
    const containerPath = mount.dst;
    const ro = mount.mode === 'ro';

    if (!fs.existsSync(hostPath)) {
      logger.warn(
        { hostPath, containerPath },
        'Mount source does not exist, skipping',
      );
      continue;
    }

    prootArgs.push(`--bind=${hostPath}:${containerPath}`);
    allMounts.push({ hostPath, containerPath, readonly: ro });
  }

  // Tmp directory (per-agent, isolated)
  const tmpDir = path.join(opts.dataDir, 'tmp', opts.agentName);
  fs.mkdirSync(tmpDir, { recursive: true });
  prootArgs.push(`--bind=${tmpDir}:/tmp`);
  allMounts.push({ hostPath: tmpDir, containerPath: '/tmp', readonly: false });

  // Working directory
  prootArgs.push('--cwd=/workspace');

  return {
    prootArgs,
    mounts: allMounts,
    config: Object.freeze({ ...opts.protection }),
  };
}

/**
 * Check if a path is allowed by the filesystem protection policy.
 * Used by the process layer to pre-check file operations.
 */
export function isPathAllowed(
  filePath: string,
  operation: 'read' | 'write',
  protection: FilesystemProtection,
): boolean {
  // Check deny list first (takes priority)
  for (const pattern of protection.deny) {
    if (globMatch(filePath, pattern)) {
      return false;
    }
  }

  // Check allow list
  const allowList =
    operation === 'read' ? protection.allow_read : protection.allow_write;
  for (const pattern of allowList) {
    if (globMatch(filePath, pattern)) {
      return true;
    }
  }

  // Default: deny
  return false;
}

/**
 * Check if a path matches any deny pattern (for symlink escape detection).
 */
export function isDeniedPath(
  filePath: string,
  protection: FilesystemProtection,
): boolean {
  for (const pattern of protection.deny) {
    if (globMatch(filePath, pattern)) {
      return true;
    }
  }
  return false;
}
