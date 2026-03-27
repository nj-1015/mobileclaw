import { describe, it, expect, afterEach } from 'vitest';
import {
  isPathAllowed,
  isDeniedPath,
  buildFilesystemSandbox,
} from './filesystem.js';
import type { FilesystemProtection } from '../blueprints/schema.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TEST_BASE = path.join(os.homedir(), '.mobileclaw-test-' + Date.now());

afterEach(() => {
  try {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const defaultProtection: FilesystemProtection = {
  allow_read: ['/workspace/**', '/tools/**', '/tmp/**'],
  allow_write: ['/workspace/**', '/tmp/**'],
  deny: ['**/*.key', '**/*.pem', '**/.ssh/**', '**/.gnupg/**'],
};

describe('isPathAllowed', () => {
  it('allows reading workspace files', () => {
    expect(isPathAllowed('/workspace/code.py', 'read', defaultProtection)).toBe(
      true,
    );
  });

  it('allows reading nested workspace files', () => {
    expect(
      isPathAllowed('/workspace/src/main.ts', 'read', defaultProtection),
    ).toBe(true);
  });

  it('allows reading tools', () => {
    expect(isPathAllowed('/tools/lint.sh', 'read', defaultProtection)).toBe(
      true,
    );
  });

  it('allows reading tmp', () => {
    expect(isPathAllowed('/tmp/scratch.txt', 'read', defaultProtection)).toBe(
      true,
    );
  });

  it('allows writing to workspace', () => {
    expect(
      isPathAllowed('/workspace/output.txt', 'write', defaultProtection),
    ).toBe(true);
  });

  it('allows writing to tmp', () => {
    expect(isPathAllowed('/tmp/data.json', 'write', defaultProtection)).toBe(
      true,
    );
  });

  it('denies writing to tools (read-only)', () => {
    expect(isPathAllowed('/tools/script.sh', 'write', defaultProtection)).toBe(
      false,
    );
  });

  it('denies reading paths outside allowed areas', () => {
    expect(isPathAllowed('/etc/passwd', 'read', defaultProtection)).toBe(false);
  });

  it('denies reading home directory', () => {
    expect(
      isPathAllowed('/home/user/secrets.txt', 'read', defaultProtection),
    ).toBe(false);
  });

  it('denies .key files even in workspace (deny takes priority)', () => {
    expect(
      isPathAllowed('/workspace/server.key', 'read', defaultProtection),
    ).toBe(false);
  });

  it('denies .pem files even in workspace', () => {
    expect(
      isPathAllowed('/workspace/cert.pem', 'read', defaultProtection),
    ).toBe(false);
  });

  it('denies .ssh directory access', () => {
    expect(
      isPathAllowed('/workspace/.ssh/id_rsa', 'read', defaultProtection),
    ).toBe(false);
  });

  it('denies .gnupg directory access', () => {
    expect(
      isPathAllowed('/home/user/.gnupg/pubring.kbx', 'read', defaultProtection),
    ).toBe(false);
  });
});

describe('isDeniedPath', () => {
  it('detects denied key files', () => {
    expect(isDeniedPath('/any/path/secret.key', defaultProtection)).toBe(true);
  });

  it('detects denied pem files', () => {
    expect(isDeniedPath('/etc/ssl/cert.pem', defaultProtection)).toBe(true);
  });

  it('detects denied ssh paths', () => {
    expect(isDeniedPath('/home/user/.ssh/config', defaultProtection)).toBe(
      true,
    );
  });

  it('does not flag normal files', () => {
    expect(isDeniedPath('/workspace/readme.md', defaultProtection)).toBe(false);
  });

  it('does not flag .keys directory (only *.key files)', () => {
    expect(isDeniedPath('/workspace/.keys/data.json', defaultProtection)).toBe(
      false,
    );
  });
});

describe('buildFilesystemSandbox', () => {
  it('generates proot args with workspace bind', () => {
    const ws = path.join(TEST_BASE, 'workspace');
    const data = path.join(TEST_BASE, 'data');
    const sandbox = buildFilesystemSandbox({
      agentName: 'test-agent',
      workspacePath: ws,
      mounts: [],
      protection: defaultProtection,
      dataDir: data,
    });

    expect(sandbox.prootArgs).toContain(`--bind=${ws}:/workspace`);
    expect(sandbox.prootArgs).toContain('--cwd=/workspace');
    expect(sandbox.mounts.length).toBeGreaterThanOrEqual(2); // workspace + tmp
  });

  it('includes custom mounts in proot args', () => {
    const ws = path.join(TEST_BASE, 'workspace');
    const data = path.join(TEST_BASE, 'data');
    const projDir = path.join(TEST_BASE, 'project');
    const toolsDir = path.join(TEST_BASE, 'tools');
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(toolsDir, { recursive: true });
    const sandbox = buildFilesystemSandbox({
      agentName: 'test-agent',
      workspacePath: ws,
      mounts: [
        { src: projDir, dst: '/workspace/project', mode: 'rw' },
        { src: toolsDir, dst: '/tools', mode: 'ro' },
      ],
      protection: defaultProtection,
      dataDir: data,
    });

    expect(sandbox.prootArgs).toContain(`--bind=${projDir}:/workspace/project`);
    expect(sandbox.prootArgs).toContain(`--bind=${toolsDir}:/tools`);
  });

  it('freezes protection config', () => {
    const ws = path.join(TEST_BASE, 'workspace');
    const data = path.join(TEST_BASE, 'data');
    const sandbox = buildFilesystemSandbox({
      agentName: 'test-agent',
      workspacePath: ws,
      mounts: [],
      protection: defaultProtection,
      dataDir: data,
    });

    expect(Object.isFrozen(sandbox.config)).toBe(true);
  });
});
