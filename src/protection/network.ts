/**
 * MobileClaw Layer 3: Network Protection (Hot-Reloadable)
 *
 * HTTP CONNECT proxy with domain allowlist, rate limiting, and audit logging.
 * Runs on localhost; agent's HTTP_PROXY points here.
 */
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';

import { type NetworkProtection } from '../blueprints/schema.js';
import { logger } from '../logger.js';

interface RateBucket {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number; // tokens per second
}

interface AuditEntry {
  timestamp: string;
  host: string;
  port: number;
  action: 'allow' | 'block' | 'rate_limited' | 'pending_approval';
  reason: string;
  agentName: string;
}

export class NetworkLayer {
  private policy: NetworkProtection;
  private rateBuckets: Map<string, RateBucket> = new Map();
  private server: http.Server | null = null;
  private auditLog: AuditEntry[] = [];
  private agentName: string;
  private logDir: string;
  /** Hook for operator approval — set by Phase 4 */
  public onApprovalRequest?: (
    host: string,
    agentName: string,
  ) => Promise<'allow' | 'block'>;

  constructor(policy: NetworkProtection, agentName: string, logDir: string) {
    this.policy = policy;
    this.agentName = agentName;
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
  }

  /** Hot-reload: update policy without restarting agent */
  reloadPolicy(newPolicy: NetworkProtection): void {
    this.policy = newPolicy;
    // Clear rate buckets so new rates take effect
    this.rateBuckets.clear();
    logger.info(
      { agentName: this.agentName, allowedHosts: newPolicy.allow.length },
      'Network policy reloaded',
    );
  }

  /** Start the proxy server */
  async start(port: number): Promise<number> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        // Regular HTTP requests — extract host and check policy
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        this.handleRequest(url.hostname, 80, res);
      });

      // Handle CONNECT for HTTPS tunneling
      this.server.on('connect', (req, clientSocket: net.Socket, head) => {
        const [host, portStr] = (req.url || '').split(':');
        const port = parseInt(portStr || '443', 10);
        this.handleConnect(host, port, clientSocket, head);
      });

      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        logger.info(
          { port: addr.port, agentName: this.agentName },
          'Network proxy started',
        );
        resolve(addr.port);
      });
    });
  }

  /** Stop the proxy */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.flushAuditLog();
  }

  private async handleConnect(
    host: string,
    port: number,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const decision = await this.decide(host);

    if (decision !== 'allow') {
      this.audit(
        host,
        port,
        decision === 'rate_limited' ? 'rate_limited' : 'block',
        decision,
      );
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end();
      return;
    }

    this.audit(host, port, 'allow', 'allowlist');

    // Tunnel the connection
    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => {
      clientSocket.end();
    });
    clientSocket.on('error', () => {
      serverSocket.end();
    });
  }

  private handleRequest(
    host: string,
    port: number,
    res: http.ServerResponse,
  ): void {
    // Synchronous check for simple HTTP (non-CONNECT)
    const allowed = this.isAllowed(host);
    if (!allowed) {
      this.audit(host, port, 'block', 'not in allowlist');
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Blocked by MobileClaw network policy: ${host}`);
      return;
    }

    if (this.isRateLimited(host)) {
      this.audit(host, port, 'rate_limited', 'rate limit exceeded');
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end(`Rate limited: ${host}`);
      return;
    }

    this.audit(host, port, 'allow', 'allowlist');
    res.writeHead(200);
    res.end();
  }

  private async decide(
    host: string,
  ): Promise<'allow' | 'block' | 'rate_limited'> {
    // Check allowlist
    if (this.isAllowed(host)) {
      if (this.isRateLimited(host)) return 'rate_limited';
      return 'allow';
    }

    // Unknown host
    switch (this.policy.unknown_host_action) {
      case 'allow_once':
        logger.info(
          { host, agentName: this.agentName },
          'Unknown host allowed once',
        );
        return 'allow';

      case 'ask_operator':
        if (this.onApprovalRequest) {
          this.audit(host, 0, 'pending_approval', 'awaiting operator');
          const decision = await this.onApprovalRequest(host, this.agentName);
          return decision;
        }
        // No approval handler registered — fall through to block
        logger.warn({ host }, 'No approval handler, blocking unknown host');
        return 'block';

      case 'block':
      default:
        return 'block';
    }
  }

  private isAllowed(host: string): boolean {
    if (this.policy.mode === 'open') return true;
    return this.policy.allow.some((entry) => entry.host === host);
  }

  private isRateLimited(host: string): boolean {
    const entry = this.policy.allow.find((e) => e.host === host);
    if (!entry?.rate) return false;

    const bucket = this.getOrCreateBucket(host, entry.rate);
    const now = Date.now() / 1000;
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(
      bucket.maxTokens,
      bucket.tokens + elapsed * bucket.refillRate,
    );
    bucket.lastRefill = now;

    if (bucket.tokens < 1) return true; // Rate limited

    bucket.tokens -= 1;
    return false;
  }

  private getOrCreateBucket(host: string, rateStr: string): RateBucket {
    let bucket = this.rateBuckets.get(host);
    if (bucket) return bucket;

    // Parse rate string like "60/hour" or "300/hour"
    const match = rateStr.match(/^(\d+)\/(hour|minute|second)$/);
    if (!match) {
      logger.warn({ host, rate: rateStr }, 'Invalid rate format');
      return {
        tokens: Infinity,
        lastRefill: Date.now() / 1000,
        maxTokens: Infinity,
        refillRate: 0,
      };
    }

    const count = parseInt(match[1], 10);
    const unit = match[2];
    const seconds = unit === 'second' ? 1 : unit === 'minute' ? 60 : 3600;
    const refillRate = count / seconds;

    bucket = {
      tokens: count,
      lastRefill: Date.now() / 1000,
      maxTokens: count,
      refillRate,
    };
    this.rateBuckets.set(host, bucket);
    return bucket;
  }

  private audit(
    host: string,
    port: number,
    action: AuditEntry['action'],
    reason: string,
  ): void {
    if (!this.policy.log_all_requests && action === 'allow') return;

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      host,
      port,
      action,
      reason,
      agentName: this.agentName,
    };

    this.auditLog.push(entry);
    logger.debug({ ...entry }, 'Network audit');

    // Flush every 100 entries
    if (this.auditLog.length >= 100) {
      this.flushAuditLog();
    }
  }

  private flushAuditLog(): void {
    if (this.auditLog.length === 0) return;
    const logFile = path.join(this.logDir, 'network-audit.jsonl');
    const lines = this.auditLog.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(logFile, lines);
    this.auditLog = [];
  }

  /** Get stats for status display */
  getStats(): { allowed: number; blocked: number; rateLimited: number } {
    // Read from audit log file
    const logFile = path.join(this.logDir, 'network-audit.jsonl');
    if (!fs.existsSync(logFile)) {
      return { allowed: 0, blocked: 0, rateLimited: 0 };
    }

    let allowed = 0;
    let blocked = 0;
    let rateLimited = 0;
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.action === 'allow') allowed++;
        else if (entry.action === 'block') blocked++;
        else if (entry.action === 'rate_limited') rateLimited++;
      } catch {
        /* skip malformed lines */
      }
    }

    return { allowed, blocked, rateLimited };
  }
}
