import { describe, it, expect, afterEach, vi } from 'vitest';
import { OperatorApproval } from './operator.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const testDir = path.join(
  os.tmpdir(),
  'mobileclaw-test-approval-' + Date.now(),
);
const ipcDir = path.join(testDir, 'ipc');
const logDir = path.join(testDir, 'logs');

afterEach(() => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('OperatorApproval', () => {
  it('creates IPC directories on construction', () => {
    const approval = new OperatorApproval({ ipcDir, logDir });
    expect(fs.existsSync(path.join(ipcDir, 'approvals'))).toBe(true);
    expect(fs.existsSync(path.join(ipcDir, 'responses'))).toBe(true);
    expect(fs.existsSync(logDir)).toBe(true);
  });

  it('starts and stops polling without error', () => {
    const approval = new OperatorApproval({ ipcDir, logDir });
    approval.start();
    approval.stop();
  });

  it('reports no pending requests initially', () => {
    const approval = new OperatorApproval({ ipcDir, logDir });
    expect(approval.getPending()).toEqual([]);
  });

  it('times out and returns block after timeout', async () => {
    const approval = new OperatorApproval({
      ipcDir,
      logDir,
      approvalTimeout: 500, // 500ms for testing
    });
    approval.start();

    const result = await approval.requestApproval({
      type: 'network',
      agentName: 'test-agent',
      target: 'evil.com',
    });

    expect(result).toBe('block');
    approval.stop();
  }, 5000);

  it('resolves with allow when IPC response says once', async () => {
    const approval = new OperatorApproval({
      ipcDir,
      logDir,
      approvalTimeout: 10000,
    });
    approval.start();

    // Start approval request
    const resultPromise = approval.requestApproval({
      type: 'network',
      agentName: 'test-agent',
      target: 'github.com',
    });

    // Wait a tick for the request to be registered
    await new Promise((r) => setTimeout(r, 100));

    // Find the pending request and write a response
    const pending = approval.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].target).toBe('github.com');

    const responsesDir = path.join(ipcDir, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    fs.writeFileSync(
      path.join(responsesDir, `${pending[0].id}-once.json`),
      JSON.stringify({ id: pending[0].id, decision: 'once' }),
    );

    // Wait for polling to pick it up
    const result = await resultPromise;
    expect(result).toBe('allow');

    approval.stop();
  }, 15000);

  it('resolves with block when IPC response says block', async () => {
    const approval = new OperatorApproval({
      ipcDir,
      logDir,
      approvalTimeout: 10000,
    });
    approval.start();

    const resultPromise = approval.requestApproval({
      type: 'network',
      agentName: 'test-agent',
      target: 'malware.com',
    });

    await new Promise((r) => setTimeout(r, 100));

    const pending = approval.getPending();
    expect(pending.length).toBe(1);

    const responsesDir = path.join(ipcDir, 'responses');
    fs.writeFileSync(
      path.join(responsesDir, `${pending[0].id}-block.json`),
      JSON.stringify({ id: pending[0].id, decision: 'block' }),
    );

    const result = await resultPromise;
    expect(result).toBe('block');

    approval.stop();
  }, 15000);

  it('handles response for unknown request ID gracefully', () => {
    const approval = new OperatorApproval({ ipcDir, logDir });
    const result = approval.handleResponse('nonexistent-id', 'once');
    expect(result).toBe(false);
  });

  it('writes audit log on timeout', async () => {
    const approval = new OperatorApproval({
      ipcDir,
      logDir,
      approvalTimeout: 200,
    });
    approval.start();

    await approval.requestApproval({
      type: 'network',
      agentName: 'test-agent',
      target: 'timeout-test.com',
    });

    approval.stop();

    // Check audit log
    const auditFile = path.join(logDir, 'approvals.jsonl');
    expect(fs.existsSync(auditFile)).toBe(true);
    const content = fs.readFileSync(auditFile, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.decision).toBe('timeout');
    expect(entry.target).toBe('timeout-test.com');
  }, 5000);

  it('tracks elapsed time in pending requests', async () => {
    const approval = new OperatorApproval({
      ipcDir,
      logDir,
      approvalTimeout: 5000,
    });
    approval.start();

    // Don't await — let it pend
    const promise = approval.requestApproval({
      type: 'command',
      agentName: 'test-agent',
      target: 'some-command',
    });

    await new Promise((r) => setTimeout(r, 200));

    const pending = approval.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].elapsed).toBeGreaterThanOrEqual(100);
    expect(pending[0].type).toBe('command');

    // Clean up — respond so promise resolves
    approval.handleResponse(pending[0].id, 'block');
    await promise;
    approval.stop();
  }, 10000);
});
