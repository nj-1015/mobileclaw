import { describe, it, expect, afterEach } from 'vitest';
import { CanaryIntegrityCheck } from './canary.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_BASE = path.join(
  os.homedir(),
  '.mobileclaw-canary-test-' + Date.now(),
);
const LOG_DIR = path.join(TEST_BASE, 'logs');

afterEach(() => {
  try {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // Clean up any leftover canary files
  const canaryPath = path.join(TEST_BASE, '.mobileclaw-canary');
  try {
    fs.unlinkSync(canaryPath);
  } catch {
    /* ignore */
  }
});

describe('CanaryIntegrityCheck', () => {
  it('creates canary file on setup', () => {
    const canary = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {},
    });

    fs.mkdirSync(TEST_BASE, { recursive: true });
    canary.setup();

    expect(fs.existsSync(canary.getCanaryPath())).toBe(true);
    const content = fs.readFileSync(canary.getCanaryPath(), 'utf-8');
    expect(content).toBe(canary.getToken());
    expect(content.length).toBe(32); // 16 bytes hex = 32 chars

    canary.cleanup();
  });

  it('check passes when canary file is unreadable', () => {
    const canary = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {},
    });

    fs.mkdirSync(TEST_BASE, { recursive: true });
    // Don't call setup — file doesn't exist, so check should pass
    const result = canary.check();
    expect(result).toBe(true);
  });

  it('check detects escape when canary is readable', () => {
    let escaped = false;
    const canary = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {
        escaped = true;
      },
    });

    fs.mkdirSync(TEST_BASE, { recursive: true });
    canary.setup();

    // Simulate: the canary file is readable (escape scenario)
    // Since we're running outside proot, the file IS readable
    const result = canary.check();
    expect(result).toBe(false); // escape detected
    expect(escaped).toBe(true); // onEscape was called

    canary.cleanup();
  });

  it('cleanup removes canary file', () => {
    const canary = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {},
    });

    fs.mkdirSync(TEST_BASE, { recursive: true });
    canary.setup();
    expect(fs.existsSync(canary.getCanaryPath())).toBe(true);

    canary.cleanup();
    expect(fs.existsSync(canary.getCanaryPath())).toBe(false);
  });

  it('writes audit log on setup', () => {
    const canary = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {},
    });

    fs.mkdirSync(TEST_BASE, { recursive: true });
    canary.setup();

    const auditFile = path.join(LOG_DIR, 'canary-audit.jsonl');
    expect(fs.existsSync(auditFile)).toBe(true);
    const content = fs.readFileSync(auditFile, 'utf-8');
    expect(content).toContain('canary_created');

    canary.cleanup();
  });

  it('writes CRITICAL audit log on escape detection', () => {
    const canary = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {},
    });

    fs.mkdirSync(TEST_BASE, { recursive: true });
    canary.setup();
    canary.check(); // Will detect "escape" since we're not in proot

    const auditFile = path.join(LOG_DIR, 'canary-audit.jsonl');
    const content = fs.readFileSync(auditFile, 'utf-8');
    expect(content).toContain('CRITICAL_SANDBOX_ESCAPE');

    canary.cleanup();
  });

  it('generates unique tokens per instance', () => {
    fs.mkdirSync(TEST_BASE, { recursive: true });
    const c1 = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {},
    });
    const c2 = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {},
    });
    expect(c1.getToken()).not.toBe(c2.getToken());
  });

  it('startMonitoring and cleanup work together', () => {
    const canary = new CanaryIntegrityCheck({
      homedir: TEST_BASE,
      logDir: LOG_DIR,
      onEscape: () => {},
    });

    fs.mkdirSync(TEST_BASE, { recursive: true });
    canary.setup();
    canary.startMonitoring(60000); // Long interval so it doesn't fire during test
    canary.cleanup(); // Should clear interval and remove file
    expect(fs.existsSync(canary.getCanaryPath())).toBe(false);
  });
});
