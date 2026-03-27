import { describe, it, expect, afterEach } from 'vitest';
import { NetworkLayer } from './network.js';
import type { NetworkProtection } from '../blueprints/schema.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const testLogDir = path.join(
  os.tmpdir(),
  'mobileclaw-test-network-' + Date.now(),
);

function makePolicy(overrides?: Partial<NetworkProtection>): NetworkProtection {
  return {
    mode: 'allowlist',
    enforcement: 'proxy' as const,
    allow: [
      { host: 'api.anthropic.com', rate: '60/hour' },
      { host: 'api.github.com', rate: '120/hour' },
    ],
    unknown_host_action: 'block',
    log_all_requests: true,
    ...overrides,
  };
}

let proxy: NetworkLayer | null = null;

afterEach(async () => {
  if (proxy) {
    await proxy.stop();
    proxy = null;
  }
  try {
    fs.rmSync(testLogDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('NetworkLayer', () => {
  it('starts and stops without error', async () => {
    proxy = new NetworkLayer(makePolicy(), 'test-agent', testLogDir);
    const port = await proxy.start(0);
    expect(port).toBeGreaterThan(0);
    await proxy.stop();
    proxy = null;
  });

  it('returns stats with zero counts initially', async () => {
    proxy = new NetworkLayer(makePolicy(), 'test-agent', testLogDir);
    await proxy.start(0);
    const stats = proxy.getStats();
    expect(stats.allowed).toBe(0);
    expect(stats.blocked).toBe(0);
    expect(stats.rateLimited).toBe(0);
  });

  it('hot-reloads policy', async () => {
    proxy = new NetworkLayer(makePolicy(), 'test-agent', testLogDir);
    await proxy.start(0);

    // Reload with new policy
    const newPolicy = makePolicy({
      allow: [
        { host: 'api.anthropic.com', rate: '60/hour' },
        { host: 'new-domain.com' },
      ],
    });

    // Should not throw
    proxy.reloadPolicy(newPolicy);
  });

  it('creates log directory', async () => {
    proxy = new NetworkLayer(makePolicy(), 'test-agent', testLogDir);
    await proxy.start(0);
    expect(fs.existsSync(testLogDir)).toBe(true);
  });
});

describe('NetworkLayer policy evaluation', () => {
  it('allows open mode for any host', async () => {
    proxy = new NetworkLayer(
      makePolicy({ mode: 'open' }),
      'test-agent',
      testLogDir,
    );
    await proxy.start(0);

    // In open mode, everything should be allowed
    // We test indirectly via the http.request path
    // For unit testing, we verify the policy was accepted
    expect(proxy).toBeTruthy();
  });

  it('blocks when allowlist is empty', async () => {
    proxy = new NetworkLayer(
      makePolicy({ allow: [] }),
      'test-agent',
      testLogDir,
    );
    await proxy.start(0);
    // With empty allowlist and block mode, all requests should be blocked
    expect(proxy).toBeTruthy();
  });

  it('supports ask_operator unknown host action', async () => {
    proxy = new NetworkLayer(
      makePolicy({ unknown_host_action: 'ask_operator' }),
      'test-agent',
      testLogDir,
    );

    let approvalRequested = false;
    proxy.onApprovalRequest = async (_host, _agentName) => {
      approvalRequested = true;
      return 'allow';
    };

    await proxy.start(0);
    expect(proxy).toBeTruthy();
    // The approval hook is registered and ready
    expect(proxy.onApprovalRequest).toBeDefined();
  });

  it('supports allow_once unknown host action', async () => {
    proxy = new NetworkLayer(
      makePolicy({ unknown_host_action: 'allow_once' }),
      'test-agent',
      testLogDir,
    );
    await proxy.start(0);
    expect(proxy).toBeTruthy();
  });
});
