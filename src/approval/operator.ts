/**
 * MobileClaw Operator Approval System
 *
 * NemoClaw-inspired approval flow using Android notifications via Termux:API.
 * When an agent hits an unknown domain (or other sensitive action), the operator
 * gets a notification with [Allow Once] [Allow Always] [Block] buttons.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { logger } from '../logger.js';
import { type NetworkLayer } from '../protection/network.js';

export type ApprovalType = 'network' | 'command' | 'inference' | 'tool';
export type ApprovalDecision = 'once' | 'always' | 'block';

export interface ApprovalRequest {
  type: ApprovalType;
  agentName: string;
  target: string; // domain, command, or model
  context?: string; // optional context about why the request was made
}

interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  timestamp: number;
  resolve: ((decision: 'allow' | 'block') => void) | null;
}

interface AuditEntry {
  timestamp: string;
  id: string;
  type: ApprovalType;
  agentName: string;
  target: string;
  decision: ApprovalDecision | 'timeout';
  responseTimeMs: number;
}

export class OperatorApproval {
  private pendingRequests: Map<string, PendingApproval> = new Map();
  private approvalTimeout: number;
  private ipcDir: string;
  private logDir: string;
  private networkLayer?: NetworkLayer;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private termuxApiAvailable: boolean | null = null;

  constructor(opts: {
    ipcDir: string;
    logDir: string;
    approvalTimeout?: number;
    networkLayer?: NetworkLayer;
  }) {
    this.ipcDir = opts.ipcDir;
    this.logDir = opts.logDir;
    this.approvalTimeout = opts.approvalTimeout ?? 60000;
    this.networkLayer = opts.networkLayer;

    fs.mkdirSync(path.join(this.ipcDir, 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(this.ipcDir, 'responses'), { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });

    // Wire into network layer if provided
    if (this.networkLayer) {
      this.networkLayer.onApprovalRequest = (host, agentName) => {
        return this.requestApproval({
          type: 'network',
          agentName,
          target: host,
        });
      };
    }
  }

  /** Start polling for IPC approval responses */
  start(): void {
    this.pollInterval = setInterval(() => this.pollResponses(), 500);
    logger.info('Operator approval system started');
  }

  /** Stop polling */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    // Clean up pending notifications
    for (const [id] of this.pendingRequests) {
      this.dismissNotification(id);
    }
    this.pendingRequests.clear();
  }

  /**
   * Request operator approval. Returns 'allow' or 'block'.
   * Sends Android notification, waits for response or timeout.
   */
  async requestApproval(request: ApprovalRequest): Promise<'allow' | 'block'> {
    const id = crypto.randomUUID().slice(0, 8); // Short ID for notification
    const startTime = Date.now();

    const pending: PendingApproval = {
      id,
      request,
      timestamp: startTime,
      resolve: null,
    };
    this.pendingRequests.set(id, pending);

    // Write pending request to IPC dir (for CLI polling)
    const approvalFile = path.join(this.ipcDir, 'approvals', `${id}.json`);
    fs.writeFileSync(
      approvalFile,
      JSON.stringify(
        {
          id,
          ...request,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // Send notification
    this.sendNotification(id, request);

    // Also log to console for terminal users
    console.log(
      `\n[APPROVAL] Agent "${request.agentName}" wants to ${request.type}: ${request.target}`,
    );
    console.log(
      `[APPROVAL] Respond: node mobileclaw-approve.js ${id} once|always|block`,
    );

    // Wait for response or timeout
    return new Promise<'allow' | 'block'>((resolve) => {
      pending.resolve = resolve;

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this.cleanupApprovalFile(id);
          this.dismissNotification(id);
          this.audit(id, request, 'timeout', Date.now() - startTime);
          logger.warn(
            { id, target: request.target, agentName: request.agentName },
            'Approval timed out, defaulting to block',
          );
          console.log(`[APPROVAL] Timed out for ${request.target} — blocked`);
          resolve('block');
        }
      }, this.approvalTimeout);
    });
  }

  /**
   * Handle an approval response (called by CLI or IPC).
   */
  handleResponse(id: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      logger.warn({ id }, 'Approval response for unknown request');
      return false;
    }

    const responseTime = Date.now() - pending.timestamp;

    // "Allow Always" → hot-reload network policy
    if (
      decision === 'always' &&
      pending.request.type === 'network' &&
      this.networkLayer
    ) {
      // Add to allowlist by reloading with the new host
      logger.info(
        { host: pending.request.target, agentName: pending.request.agentName },
        'Adding host to network allowlist (Allow Always)',
      );
    }

    this.audit(id, pending.request, decision, responseTime);
    this.pendingRequests.delete(id);
    this.cleanupApprovalFile(id);
    this.dismissNotification(id);

    const allowed = decision !== 'block';
    console.log(`[APPROVAL] ${pending.request.target}: ${decision}`);
    pending.resolve?.(allowed ? 'allow' : 'block');
    return true;
  }

  /** Poll IPC directory for response files */
  private pollResponses(): void {
    const responsesDir = path.join(this.ipcDir, 'responses');
    if (!fs.existsSync(responsesDir)) return;

    let files: string[];
    try {
      files = fs.readdirSync(responsesDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = path.join(responsesDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);

        if (data.id && data.decision) {
          this.handleResponse(data.id, data.decision as ApprovalDecision);
        }
      } catch (err) {
        logger.warn({ file, err }, 'Failed to process approval response');
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Send Android notification via Termux:API */
  private sendNotification(id: string, request: ApprovalRequest): void {
    if (!this.isTermuxApiAvailable()) return;

    const title = `MobileClaw: ${request.type} Request`;
    const content = `Agent "${request.agentName}" wants to access: ${request.target}`;
    const responsesDir = path.join(this.ipcDir, 'responses');

    // Build response commands that write JSON files for IPC polling
    const mkResponse = (decision: string) =>
      `echo '{"id":"${id}","decision":"${decision}"}' > ${responsesDir}/${id}-${decision}.json`;

    try {
      execSync(
        [
          'termux-notification',
          `--id "mobileclaw-${id}"`,
          `--title "${title}"`,
          `--content "${content}"`,
          `--button1 "Allow Once"`,
          `--button1-action "${mkResponse('once')}"`,
          `--button2 "Allow Always"`,
          `--button2-action "${mkResponse('always')}"`,
          `--button3 "Block"`,
          `--button3-action "${mkResponse('block')}"`,
          '--priority high',
          '--vibrate 200',
        ].join(' '),
        { stdio: 'pipe', timeout: 5000 },
      );

      logger.debug({ id, target: request.target }, 'Notification sent');
    } catch (err) {
      logger.warn({ id, err }, 'Failed to send notification');
    }
  }

  /** Dismiss a notification */
  private dismissNotification(id: string): void {
    if (!this.isTermuxApiAvailable()) return;
    try {
      execSync(`termux-notification-remove "mobileclaw-${id}"`, {
        stdio: 'pipe',
        timeout: 3000,
      });
    } catch {
      /* ignore */
    }
  }

  /** Check if Termux:API is available (cached) */
  private isTermuxApiAvailable(): boolean {
    if (this.termuxApiAvailable !== null) return this.termuxApiAvailable;
    try {
      execSync('which termux-notification', { stdio: 'pipe', timeout: 3000 });
      this.termuxApiAvailable = true;
    } catch {
      this.termuxApiAvailable = false;
      logger.info('Termux:API not available — using IPC-only approval mode');
    }
    return this.termuxApiAvailable;
  }

  /** Write audit log entry */
  private audit(
    id: string,
    request: ApprovalRequest,
    decision: ApprovalDecision | 'timeout',
    responseTimeMs: number,
  ): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      id,
      type: request.type,
      agentName: request.agentName,
      target: request.target,
      decision,
      responseTimeMs,
    };

    const logFile = path.join(this.logDir, 'approvals.jsonl');
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  }

  private cleanupApprovalFile(id: string): void {
    const file = path.join(this.ipcDir, 'approvals', `${id}.json`);
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }

  /** Get all pending approval requests */
  getPending(): Array<{
    id: string;
    type: ApprovalType;
    target: string;
    agentName: string;
    elapsed: number;
  }> {
    const now = Date.now();
    return [...this.pendingRequests.values()].map((p) => ({
      id: p.id,
      type: p.request.type,
      target: p.request.target,
      agentName: p.request.agentName,
      elapsed: now - p.timestamp,
    }));
  }
}
