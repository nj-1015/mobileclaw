import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --bind flag for proot', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['--bind=/host/path:/container/path']);
  });
});

describe('stopContainer', () => {
  it('returns pkill command for sandbox process', () => {
    expect(stopContainer('test-123')).toBe(
      'pkill -f "mobileclaw-sandbox-test-123" 2>/dev/null || true',
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when proot is available', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('proot --version', {
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'proot sandbox runtime available',
    );
  });

  it('throws when proot is not found', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('proot not found');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'proot is required but not found',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('kills orphaned mobileclaw sandbox processes', () => {
    // ps returns PIDs in second column
    mockExecSync.mockReturnValueOnce(
      'user  1234  0.0  0.1 ... mobileclaw-sandbox-group1\nuser  5678  0.0  0.1 ... mobileclaw-sandbox-group2\n',
    );

    cleanupOrphans();

    // ps call + 2 kill calls (via process.kill, not execSync)
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('ps not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned sandboxes',
    );
  });
});
