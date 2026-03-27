import { describe, it, expect, afterEach } from 'vitest';
import {
  hexToIp,
  looksLikeExfiltration,
  calculateEntropy,
  DnsMonitor,
} from './dns-monitor.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_BASE = path.join(os.homedir(), '.mobileclaw-dns-test-' + Date.now());
const LOG_DIR = path.join(TEST_BASE, 'logs');

afterEach(() => {
  try {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('hexToIp', () => {
  it('converts 0100007F to 127.0.0.1', () => {
    expect(hexToIp('0100007F')).toBe('127.0.0.1');
  });

  it('converts 00000000 to 0.0.0.0', () => {
    expect(hexToIp('00000000')).toBe('0.0.0.0');
  });

  it('converts C0A80001 to 1.0.168.192 (little-endian)', () => {
    // /proc/net/tcp is little-endian: C0A80001 = 192.168.0.1 stored as 01.00.A8.C0
    expect(hexToIp('0100A8C0')).toBe('192.168.0.1');
  });

  it('passes through non-8-char hex', () => {
    expect(hexToIp('ABCD')).toBe('ABCD');
  });
});

describe('looksLikeExfiltration', () => {
  it('normal domain is not exfiltration', () => {
    expect(looksLikeExfiltration('api.github.com')).toBe(false);
  });

  it('normal subdomain is not exfiltration', () => {
    expect(looksLikeExfiltration('www.example.com')).toBe(false);
  });

  it('detects too many subdomain levels', () => {
    expect(looksLikeExfiltration('a.b.c.d.e.evil.com')).toBe(true);
  });

  it('detects very long subdomain', () => {
    const longSub = 'a'.repeat(50) + '.evil.com';
    expect(looksLikeExfiltration(longSub)).toBe(true);
  });

  it('detects high-entropy subdomain (base64-like)', () => {
    // High entropy random string that looks like encoded data
    expect(
      looksLikeExfiltration('aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q.evil.com'),
    ).toBe(true);
  });

  it('does not flag short subdomains even with entropy', () => {
    expect(looksLikeExfiltration('abc123.evil.com')).toBe(false);
  });
});

describe('calculateEntropy', () => {
  it('returns 0 for empty string', () => {
    expect(calculateEntropy('')).toBe(0);
  });

  it('returns 0 for single character repeated', () => {
    expect(calculateEntropy('aaaa')).toBe(0);
  });

  it('returns 1.0 for two equally distributed chars', () => {
    expect(calculateEntropy('ab')).toBeCloseTo(1.0, 5);
  });

  it('returns higher entropy for more diverse strings', () => {
    const low = calculateEntropy('aaabbb');
    const high = calculateEntropy('abcdef');
    expect(high).toBeGreaterThan(low);
  });

  it('base64-like string has high entropy', () => {
    const entropy = calculateEntropy('aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q');
    expect(entropy).toBeGreaterThan(3.5);
  });
});

describe('DnsMonitor', () => {
  it('creates log directory', () => {
    const monitor = new DnsMonitor(
      ['api.anthropic.com'],
      'test-agent',
      LOG_DIR,
    );
    expect(fs.existsSync(LOG_DIR)).toBe(true);
    monitor.stop();
  });

  it('starts and stops without error', () => {
    const monitor = new DnsMonitor(
      ['api.anthropic.com'],
      'test-agent',
      LOG_DIR,
    );
    monitor.start(60000);
    monitor.stop();
  });

  it('returns empty stats initially', () => {
    const monitor = new DnsMonitor(
      ['api.anthropic.com'],
      'test-agent',
      LOG_DIR,
    );
    const stats = monitor.getStats();
    expect(stats.expected).toBe(0);
    expect(stats.suspicious).toBe(0);
    expect(stats.exfiltrationWarnings).toBe(0);
    expect(stats.proxyBypasses).toBe(0);
    monitor.stop();
  });

  it('correlateWithProxyLog returns empty for missing files', () => {
    const monitor = new DnsMonitor(
      ['api.anthropic.com'],
      'test-agent',
      LOG_DIR,
    );
    const bypasses = monitor.correlateWithProxyLog('/nonexistent/proxy.jsonl');
    expect(bypasses).toEqual([]);
    monitor.stop();
  });

  it('correlateWithProxyLog detects bypass', () => {
    const monitor = new DnsMonitor(
      ['api.anthropic.com'],
      'test-agent',
      LOG_DIR,
    );

    // Write a fake DNS audit log with a suspicious entry
    const dnsLogFile = path.join(LOG_DIR, 'dns-audit.jsonl');
    fs.writeFileSync(
      dnsLogFile,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'suspicious',
        remoteIp: '1.2.3.4',
        remotePort: 443,
        domain: 'evil.com',
        reason: 'Not on allowlist',
      }) + '\n',
    );

    // Write a proxy log that does NOT contain evil.com
    const proxyLogFile = path.join(LOG_DIR, 'proxy-audit.jsonl');
    fs.writeFileSync(
      proxyLogFile,
      JSON.stringify({
        host: 'api.anthropic.com',
        action: 'allow',
      }) + '\n',
    );

    const bypasses = monitor.correlateWithProxyLog(proxyLogFile);
    expect(bypasses.length).toBe(1);
    expect(bypasses[0].event).toBe('proxy_bypass');
    expect(bypasses[0].domain).toBe('evil.com');

    monitor.stop();
  });
});
