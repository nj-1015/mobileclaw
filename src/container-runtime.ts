/**
 * MobileClaw patch: replaced Docker runtime with proot sandbox.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The sandbox runtime binary. */
export const CONTAINER_RUNTIME_BIN = 'proot';

/** In proot mode, the host is just localhost (no VM networking). */
export const CONTAINER_HOST_GATEWAY = '127.0.0.1';

/** No-op for proot — no gateway args needed (shares host network). */
export function hostGatewayArgs(): string[] {
  return [];
}

/** Returns proot --bind args for a readonly mount (proot has no native ro, but the path is bound). */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  // proot doesn't natively support read-only binds.
  // We bind normally; process-layer protection blocks writes to these paths.
  return [`--bind=${hostPath}:${containerPath}`];
}

/** Returns the shell command to stop a proot process by PID file. */
export function stopContainer(name: string): string {
  // proot processes are just child processes — kill by name or PID
  return `pkill -f "mobileclaw-sandbox-${name}" 2>/dev/null || true`;
}

/** Ensure proot is available. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync('proot --version', { stdio: 'pipe', timeout: 5000 });
    logger.debug('proot sandbox runtime available');
  } catch (err) {
    logger.error({ err }, 'proot not found');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: proot not found                                        ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents need proot for filesystem isolation. To fix:           ║',
    );
    console.error(
      '║  1. Run: pkg install proot                                     ║',
    );
    console.error(
      '║  2. Restart MobileClaw                                         ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('proot is required but not found', { cause: err });
  }
}

/** Kill orphaned MobileClaw sandbox processes from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `ps aux 2>/dev/null | grep mobileclaw-sandbox | grep -v grep || true`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const pid = line.trim().split(/\s+/)[1];
      if (pid) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          /* already dead */
        }
      }
    }
    if (lines.length > 0) {
      logger.info(
        { count: lines.length },
        'Stopped orphaned sandbox processes',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned sandboxes');
  }
}
