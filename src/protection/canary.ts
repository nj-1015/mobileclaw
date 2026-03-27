/**
 * MobileClaw Canary Integrity Check
 *
 * Detects proot sandbox escapes at runtime.
 * Places a canary file outside the sandbox, then periodically checks
 * if the agent can read it. If readable → sandbox escaped → kill agent.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { logger } from '../logger.js';

const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';

export class CanaryIntegrityCheck {
  private canaryPath: string;
  private canaryToken: string;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private logDir: string;
  private onEscape: () => void;
  private checkCount = 0;

  constructor(opts: { homedir: string; logDir: string; onEscape: () => void }) {
    this.canaryToken = randomBytes(16).toString('hex');
    this.canaryPath = path.join(opts.homedir, '.mobileclaw-canary');
    this.logDir = opts.logDir;
    this.onEscape = opts.onEscape;
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  /** Write canary file outside the sandbox (call before sandbox starts) */
  setup(): void {
    fs.writeFileSync(this.canaryPath, this.canaryToken, { mode: 0o600 });
    this.audit('canary_created', {
      path: this.canaryPath,
      note: 'Agent should NOT be able to read this file',
    });
  }

  /** Start periodic checks (call after sandbox starts) */
  startMonitoring(intervalMs = 30000): void {
    // Check immediately, then on interval
    this.check();
    this.checkInterval = setInterval(() => this.check(), intervalMs);
  }

  /** Run a single check */
  check(): boolean {
    this.checkCount++;
    try {
      const content = fs.readFileSync(this.canaryPath, 'utf-8');
      if (content === this.canaryToken) {
        // SANDBOX ESCAPE DETECTED
        this.audit('CRITICAL_SANDBOX_ESCAPE', {
          path: this.canaryPath,
          message: 'Agent read canary file outside sandbox boundary',
          action: 'Killing agent process immediately',
          severity: 'CRITICAL',
          checkNumber: this.checkCount,
        });

        logger.error(
          { canaryPath: this.canaryPath },
          'CRITICAL: Sandbox escape detected — canary file readable',
        );

        this.sendEscapeAlert();
        this.onEscape();
        return false; // escape detected
      }
    } catch {
      // EXPECTED: read should fail because proot hides the real home
      if (this.checkCount % 10 === 0) {
        // Log every 10th check to avoid log spam
        this.audit('canary_check_passed', {
          checkNumber: this.checkCount,
        });
      }
    }
    return true; // integrity OK
  }

  /** Stop monitoring and remove canary file */
  cleanup(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    try {
      fs.unlinkSync(this.canaryPath);
    } catch {
      /* may not exist */
    }
    this.audit('canary_cleanup', { checkCount: this.checkCount });
  }

  /** Get the canary file path (for testing) */
  getCanaryPath(): string {
    return this.canaryPath;
  }

  /** Get the token (for testing) */
  getToken(): string {
    return this.canaryToken;
  }

  private sendEscapeAlert(): void {
    try {
      const notifBin = `${TERMUX_BIN}/termux-notification`;
      if (fs.existsSync(notifBin)) {
        execSync(
          [
            notifBin,
            '--id mobileclaw-canary-escape',
            '--title "CRITICAL: Sandbox escape detected"',
            '--content "Agent accessed file outside sandbox. Agent killed."',
            '--priority max',
            '--vibrate 500,200,500',
            '--led-color FF0000',
          ].join(' '),
          { stdio: 'pipe', timeout: 5000 },
        );
      }
    } catch {
      // Notification failure must not prevent agent kill
    }
  }

  private audit(event: string, data: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...data,
    };
    const logFile = path.join(this.logDir, 'canary-audit.jsonl');
    try {
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch {
      /* log failure is not critical */
    }
  }
}
