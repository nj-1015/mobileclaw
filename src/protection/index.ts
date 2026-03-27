/**
 * MobileClaw Four-Layer Protection Model
 *
 * Layer 1: Filesystem  — proot sandbox (locked at creation)
 * Layer 2: Process     — command filter + ulimits (locked at creation)
 * Layer 3: Network     — HTTP proxy + rate limiter (hot-reloadable)
 * Layer 4: Inference   — local/cloud gateway + cost tracking (hot-reloadable)
 */
export {
  buildFilesystemSandbox,
  isPathAllowed,
  isDeniedPath,
  type FilesystemSandbox,
} from './filesystem.js';
export {
  checkCommand,
  buildResourceLimits,
  getFullBlocklist,
  type CommandCheckResult,
} from './process.js';
export { NetworkLayer } from './network.js';
export { InferenceGateway } from './inference.js';
export { CanaryIntegrityCheck } from './canary.js';
export { DnsMonitor } from './dns-monitor.js';
