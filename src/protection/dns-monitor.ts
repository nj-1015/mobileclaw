/**
 * MobileClaw DNS Monitor (Layer 3.5)
 *
 * Passive monitoring of network connections via /proc/net/tcp.
 * Detects:
 * - Connections to domains not on the allowlist
 * - DNS-based data exfiltration patterns (high-entropy subdomains)
 * - Proxy bypass (domain in DNS but not in proxy audit log)
 */
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { promisify } from 'util';

import { logger } from '../logger.js';

const reverseLookup = promisify(dns.reverse);

export interface DnsAuditEntry {
  timestamp: string;
  event: 'expected' | 'suspicious' | 'exfiltration_warning' | 'proxy_bypass';
  remoteIp: string;
  remotePort: number;
  domain: string | null;
  reason: string;
}

export interface Connection {
  remoteIp: string;
  remotePort: number;
  state: string;
  key: string;
}

export class DnsMonitor {
  private allowedDomains: Set<string>;
  private seenConnections: Map<string, number> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private logDir: string;
  private agentName: string;
  private auditBuffer: DnsAuditEntry[] = [];

  constructor(allowedDomains: string[], agentName: string, logDir: string) {
    this.allowedDomains = new Set(allowedDomains);
    this.agentName = agentName;
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
  }

  /** Start periodic connection monitoring */
  start(intervalMs = 5000): void {
    this.checkInterval = setInterval(() => this.check(), intervalMs);
    logger.info(
      { agentName: this.agentName, intervalMs },
      'DNS monitor started',
    );
  }

  /** Stop monitoring */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.flushAuditLog();
  }

  /** Run a single check cycle */
  async check(): Promise<DnsAuditEntry[]> {
    const entries: DnsAuditEntry[] = [];

    let connections: Connection[];
    try {
      connections = readProcNetTcp();
    } catch {
      // /proc/net/tcp may not be readable in some contexts
      return entries;
    }

    for (const conn of connections) {
      // Skip already-seen connections and localhost
      if (this.seenConnections.has(conn.key)) continue;
      if (conn.remoteIp === '127.0.0.1' || conn.remoteIp === '0.0.0.0')
        continue;

      this.seenConnections.set(conn.key, Date.now());

      // Reverse lookup the IP
      let domain: string | null = null;
      try {
        const hostnames = await reverseLookup(conn.remoteIp);
        domain = hostnames[0] || null;
      } catch {
        // Reverse lookup failed — IP-only connection
      }

      if (domain && this.isExpected(domain)) {
        const entry: DnsAuditEntry = {
          timestamp: new Date().toISOString(),
          event: 'expected',
          remoteIp: conn.remoteIp,
          remotePort: conn.remotePort,
          domain,
          reason: 'Domain on allowlist',
        };
        entries.push(entry);
      } else if (domain) {
        // Unknown domain
        const entry: DnsAuditEntry = {
          timestamp: new Date().toISOString(),
          event: 'suspicious',
          remoteIp: conn.remoteIp,
          remotePort: conn.remotePort,
          domain,
          reason: `Domain not on allowlist: ${domain}`,
        };
        entries.push(entry);

        logger.warn(
          { ip: conn.remoteIp, domain, agentName: this.agentName },
          'DNS: connection to non-allowlisted domain',
        );

        // Check for exfiltration patterns
        if (looksLikeExfiltration(domain)) {
          entries.push({
            timestamp: new Date().toISOString(),
            event: 'exfiltration_warning',
            remoteIp: conn.remoteIp,
            remotePort: conn.remotePort,
            domain,
            reason: 'Subdomain pattern resembles data encoding',
          });

          logger.error(
            { domain, agentName: this.agentName },
            'DNS: possible data exfiltration detected',
          );
        }
      }
    }

    if (entries.length > 0) {
      this.auditBuffer.push(...entries);
      if (this.auditBuffer.length >= 50) this.flushAuditLog();
    }

    // Prune old seen connections (older than 5 minutes)
    const cutoff = Date.now() - 300000;
    for (const [key, ts] of this.seenConnections) {
      if (ts < cutoff) this.seenConnections.delete(key);
    }

    return entries;
  }

  /**
   * Cross-correlate DNS observations with proxy audit log.
   * Domains seen in DNS but NOT in proxy → possible bypass.
   */
  correlateWithProxyLog(proxyLogPath: string): DnsAuditEntry[] {
    const bypasses: DnsAuditEntry[] = [];

    if (!fs.existsSync(proxyLogPath)) return bypasses;

    // Read proxy audit log domains
    const proxiedDomains = new Set<string>();
    const lines = fs.readFileSync(proxyLogPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.host) proxiedDomains.add(entry.host);
      } catch {
        /* skip */
      }
    }

    // Read DNS audit log domains
    const dnsLogPath = path.join(this.logDir, 'dns-audit.jsonl');
    if (!fs.existsSync(dnsLogPath)) return bypasses;

    const dnsLines = fs.readFileSync(dnsLogPath, 'utf-8').trim().split('\n');
    for (const line of dnsLines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as DnsAuditEntry;
        if (
          entry.domain &&
          entry.event === 'suspicious' &&
          !proxiedDomains.has(entry.domain)
        ) {
          bypasses.push({
            timestamp: new Date().toISOString(),
            event: 'proxy_bypass',
            remoteIp: entry.remoteIp,
            remotePort: entry.remotePort,
            domain: entry.domain,
            reason:
              'Domain in DNS but not in proxy logs — possible direct connection',
          });
        }
      } catch {
        /* skip */
      }
    }

    if (bypasses.length > 0) {
      this.auditBuffer.push(...bypasses);
      this.flushAuditLog();
      logger.error(
        { count: bypasses.length, agentName: this.agentName },
        'DNS: proxy bypass detected',
      );
    }

    return bypasses;
  }

  /** Get stats */
  getStats(): {
    expected: number;
    suspicious: number;
    exfiltrationWarnings: number;
    proxyBypasses: number;
  } {
    const logFile = path.join(this.logDir, 'dns-audit.jsonl');
    if (!fs.existsSync(logFile)) {
      return {
        expected: 0,
        suspicious: 0,
        exfiltrationWarnings: 0,
        proxyBypasses: 0,
      };
    }

    let expected = 0,
      suspicious = 0,
      exfiltrationWarnings = 0,
      proxyBypasses = 0;
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as DnsAuditEntry;
        if (e.event === 'expected') expected++;
        else if (e.event === 'suspicious') suspicious++;
        else if (e.event === 'exfiltration_warning') exfiltrationWarnings++;
        else if (e.event === 'proxy_bypass') proxyBypasses++;
      } catch {
        /* skip */
      }
    }

    return { expected, suspicious, exfiltrationWarnings, proxyBypasses };
  }

  private isExpected(domain: string): boolean {
    // Check if domain or any parent domain is in the allowlist
    const parts = domain.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (this.allowedDomains.has(candidate)) return true;
    }
    return false;
  }

  private flushAuditLog(): void {
    if (this.auditBuffer.length === 0) return;
    const logFile = path.join(this.logDir, 'dns-audit.jsonl');
    const lines =
      this.auditBuffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(logFile, lines);
    this.auditBuffer = [];
  }
}

// --- Helpers (exported for testing) ---

/** Parse /proc/net/tcp for active TCP connections */
export function readProcNetTcp(): Connection[] {
  const procPath = '/proc/net/tcp';
  if (!fs.existsSync(procPath)) return [];

  const raw = fs.readFileSync(procPath, 'utf-8');
  return raw
    .split('\n')
    .slice(1) // skip header
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return null;

      const remote = parts[2];
      const [hexIp, hexPort] = remote.split(':');
      const remoteIp = hexToIp(hexIp);
      const remotePort = parseInt(hexPort, 16);
      const state = parts[3];

      return {
        remoteIp,
        remotePort,
        state,
        key: remote,
      };
    })
    .filter((c): c is Connection => c !== null);
}

/** Convert hex IP (from /proc/net/tcp) to dotted decimal */
export function hexToIp(hex: string): string {
  if (hex.length !== 8) return hex;
  // /proc/net/tcp uses little-endian on most architectures
  const b = [
    parseInt(hex.slice(6, 8), 16),
    parseInt(hex.slice(4, 6), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(0, 2), 16),
  ];
  return b.join('.');
}

/** Check if a domain looks like DNS-based data exfiltration */
export function looksLikeExfiltration(domain: string): boolean {
  const parts = domain.split('.');

  // Too many subdomain levels (data.chunk1.chunk2.chunk3.evil.com)
  if (parts.length > 5) return true;

  // Very long subdomain
  const subdomain = parts.slice(0, -2).join('.');
  if (subdomain.length > 40) return true;

  // High entropy in subdomain (base64/hex encoded data)
  if (subdomain.length > 20 && calculateEntropy(subdomain) > 4.0) return true;

  return false;
}

/** Shannon entropy of a string */
export function calculateEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
