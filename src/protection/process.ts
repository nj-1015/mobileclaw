/**
 * MobileClaw Layer 2: Process Protection (Locked at Creation)
 *
 * Supports two modes:
 * - allowlist (default): only explicitly allowed binaries can run
 * - blocklist (legacy): everything runs except blocked patterns
 */
import { type ProcessProtection } from '../blueprints/schema.js';
import { logger } from '../logger.js';

// --- Types ---

export interface CommandCheckResult {
  allowed: boolean;
  reason?: string;
  matchedPattern?: string;
  binary?: string;
}

export interface AllowEntry {
  binary: string;
  args_deny?: string[];
  condition?: string;
  rationale?: string;
}

export interface DenyEntry {
  binary?: string;
  pattern?: string;
}

export interface ProcessPolicy {
  mode: 'allowlist' | 'blocklist';
  allow: AllowEntry[];
  deny_always: DenyEntry[];
  blocked_commands: string[]; // legacy blocklist patterns
  unknown_action: 'deny' | 'ask_operator';
  max_processes: number;
  max_memory_mb: number;
  max_cpu_percent: number;
}

// --- Default allowlist ---

export const DEFAULT_ALLOWLIST: AllowEntry[] = [
  // Version control
  { binary: 'git', rationale: 'Version control' },
  // Package managers
  { binary: 'npm', rationale: 'Node.js packages' },
  { binary: 'npx', rationale: 'Node.js package exec' },
  { binary: 'yarn', rationale: 'Alt package manager' },
  { binary: 'pip', rationale: 'Python packages' },
  { binary: 'pip3', rationale: 'Python 3 packages' },
  // Runtimes
  { binary: 'node', rationale: 'JavaScript' },
  { binary: 'python', rationale: 'Python' },
  { binary: 'python3', rationale: 'Python 3' },
  { binary: 'ruby', rationale: 'Ruby' },
  { binary: 'sh', rationale: 'Shell' },
  { binary: 'bash', rationale: 'Bash shell' },
  // File ops (read)
  { binary: 'cat', rationale: 'Read files' },
  { binary: 'head', rationale: 'Read file start' },
  { binary: 'tail', rationale: 'Read file end' },
  { binary: 'less', rationale: 'Paginated read' },
  { binary: 'grep', rationale: 'Search contents' },
  {
    binary: 'find',
    args_deny: ['-delete', '-exec rm'],
    rationale: 'Find files',
  },
  { binary: 'wc', rationale: 'Count lines/words' },
  { binary: 'diff', rationale: 'Compare files' },
  // File ops (write)
  { binary: 'cp', rationale: 'Copy files' },
  { binary: 'mv', rationale: 'Move files' },
  { binary: 'mkdir', rationale: 'Create dirs' },
  { binary: 'touch', rationale: 'Create files' },
  {
    binary: 'rm',
    args_deny: ['-rf /', '-rf ~', '-rf ..'],
    rationale: 'Remove files',
  },
  { binary: 'chmod', rationale: 'Change permissions' },
  // Text processing
  { binary: 'echo', rationale: 'Print text' },
  { binary: 'printf', rationale: 'Formatted output' },
  { binary: 'sed', rationale: 'Stream editing' },
  { binary: 'awk', rationale: 'Text processing' },
  { binary: 'sort', rationale: 'Sort lines' },
  { binary: 'uniq', rationale: 'Deduplicate' },
  { binary: 'tr', rationale: 'Translate chars' },
  { binary: 'cut', rationale: 'Extract columns' },
  // Navigation
  { binary: 'ls', rationale: 'List directory' },
  { binary: 'pwd', rationale: 'Working directory' },
  { binary: 'tree', rationale: 'Dir tree' },
  { binary: 'cd', rationale: 'Change directory' },
  // Archive
  { binary: 'tar', rationale: 'Archive' },
  { binary: 'gzip', rationale: 'Compress' },
  { binary: 'unzip', rationale: 'Extract zip' },
  // Utilities
  { binary: 'date', rationale: 'Date/time' },
  { binary: 'env', rationale: 'Environment' },
  { binary: 'which', rationale: 'Locate binary' },
  { binary: 'whoami', rationale: 'Current user' },
  { binary: 'basename', rationale: 'Extract filename' },
  { binary: 'dirname', rationale: 'Extract dir' },
  { binary: 'tee', rationale: 'Write + stdout' },
  { binary: 'xargs', rationale: 'Build commands' },
  { binary: 'true', rationale: 'No-op success' },
  { binary: 'false', rationale: 'No-op failure' },
  { binary: 'test', rationale: 'Conditionals' },
  { binary: '[', rationale: 'Conditionals' },
  { binary: 'stat', rationale: 'File info' },
  { binary: 'realpath', rationale: 'Resolve path' },
  { binary: 'readlink', rationale: 'Read symlink' },
  // Network (conditional — only when proxy is active)
  {
    binary: 'curl',
    condition: 'network_proxy_active',
    rationale: 'HTTP via proxy',
  },
  {
    binary: 'wget',
    condition: 'network_proxy_active',
    rationale: 'HTTP via proxy',
  },
];

export const DEFAULT_DENY_ALWAYS: DenyEntry[] = [
  // Termux device APIs
  { pattern: 'termux-camera-*' },
  { pattern: 'termux-sms-*' },
  { pattern: 'termux-telephony-*' },
  { binary: 'termux-location' },
  { pattern: 'termux-wifi-*' },
  { pattern: 'termux-contact-*' },
  { binary: 'termux-microphone-record' },
  { binary: 'termux-fingerprint' },
  // Privilege escalation
  { binary: 'su' },
  { binary: 'sudo' },
  // Remote access
  { binary: 'ssh' },
  { binary: 'scp' },
  { binary: 'sftp' },
  { binary: 'telnet' },
  { binary: 'nc' },
  { binary: 'ncat' },
  // System destructive
  { binary: 'dd' },
  { binary: 'mkfs' },
  { binary: 'fdisk' },
  // Process manipulation
  { binary: 'kill' },
  { binary: 'killall' },
  { binary: 'pkill' },
];

// --- ProcessFilter class ---

export class ProcessFilter {
  private policy: ProcessPolicy;
  private conditions: Map<string, boolean> = new Map();

  constructor(policy: ProcessPolicy) {
    this.policy = policy;
  }

  /** Set a runtime condition (e.g., network_proxy_active) */
  setCondition(name: string, value: boolean): void {
    this.conditions.set(name, value);
  }

  /** Check a command. In allowlist mode, ALL segments of chained commands must pass. */
  checkCommand(rawCommand: string): CommandCheckResult {
    const trimmed = rawCommand.trim();
    if (!trimmed) return { allowed: true, reason: 'empty command' };

    if (this.policy.mode === 'blocklist') {
      return this.checkBlocklist(trimmed);
    }

    // Allowlist mode: split chains, check each segment
    const segments = splitCommandChain(trimmed);

    for (const segment of segments) {
      const result = this.checkSegment(segment.trim());
      if (!result.allowed) return result;
    }

    return { allowed: true };
  }

  private checkSegment(segment: string): CommandCheckResult {
    if (!segment) return { allowed: true };

    const binary = extractBinary(segment);
    if (!binary) return { allowed: true, reason: 'no binary detected' };

    // Step 1: Check deny_always (hard deny, always wins)
    for (const entry of this.policy.deny_always) {
      if (entry.binary && binary === entry.binary) {
        return {
          allowed: false,
          reason: `${binary} is permanently blocked`,
          binary,
        };
      }
      if (entry.pattern && globMatchBinary(binary, entry.pattern)) {
        return {
          allowed: false,
          reason: `${binary} matches deny pattern: ${entry.pattern}`,
          binary,
        };
      }
    }

    // Step 2: Check allowlist
    const allowEntry = this.policy.allow.find((e) => e.binary === binary);
    if (!allowEntry) {
      return {
        allowed: false,
        reason: `${binary} not on allowlist`,
        binary,
      };
    }

    // Step 3: Check conditions
    if (allowEntry.condition) {
      const conditionMet = this.conditions.get(allowEntry.condition) ?? false;
      if (!conditionMet) {
        return {
          allowed: false,
          reason: `condition not met: ${allowEntry.condition}`,
          binary,
        };
      }
    }

    // Step 4: Check args_deny
    if (allowEntry.args_deny) {
      for (const pattern of allowEntry.args_deny) {
        if (segment.includes(pattern)) {
          return {
            allowed: false,
            reason: `blocked argument pattern: ${pattern}`,
            matchedPattern: pattern,
            binary,
          };
        }
      }
    }

    return { allowed: true, binary };
  }

  /** Legacy blocklist mode (backward compatible) */
  private checkBlocklist(command: string): CommandCheckResult {
    for (const pattern of this.policy.blocked_commands) {
      if (commandMatchesPattern(command, pattern)) {
        return {
          allowed: false,
          reason: `Blocked by pattern: ${pattern}`,
          matchedPattern: pattern,
        };
      }
    }
    return { allowed: true };
  }
}

// --- Legacy checkCommand (backward-compatible wrapper) ---

export function checkCommand(
  command: string,
  protection: ProcessProtection,
): CommandCheckResult {
  // Use legacy blocklist mode for backward compatibility
  const policy: ProcessPolicy = {
    mode: 'blocklist',
    allow: [],
    deny_always: [],
    blocked_commands: protection.blocked_commands,
    unknown_action: 'deny',
    max_processes: protection.max_processes,
    max_memory_mb: protection.max_memory_mb,
    max_cpu_percent: protection.max_cpu_percent,
  };
  const filter = new ProcessFilter(policy);
  return filter.checkCommand(command);
}

// --- Helpers ---

/** Split a command string on chain operators (&&, ||, ;, |) respecting quotes */
export function splitCommandChain(raw: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
    } else if (!inSingleQuote && !inDoubleQuote) {
      // Check for &&, ||, ;, |
      if (raw[i] === '&' && raw[i + 1] === '&') {
        segments.push(current);
        current = '';
        i += 2;
      } else if (raw[i] === '|' && raw[i + 1] === '|') {
        segments.push(current);
        current = '';
        i += 2;
      } else if (raw[i] === ';') {
        segments.push(current);
        current = '';
        i++;
      } else if (raw[i] === '|') {
        segments.push(current);
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    } else {
      current += ch;
      i++;
    }
  }

  if (current.trim()) segments.push(current);
  return segments;
}

/** Extract the base binary name from a command, stripping paths */
export function extractBinary(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;

  // Skip env var assignments at start (FOO=bar cmd)
  const parts = trimmed.split(/\s+/);
  let cmdIdx = 0;
  while (
    cmdIdx < parts.length &&
    parts[cmdIdx].includes('=') &&
    !parts[cmdIdx].startsWith('-')
  ) {
    cmdIdx++;
  }

  if (cmdIdx >= parts.length) return null;
  const cmd = parts[cmdIdx];

  // Strip path: /usr/bin/git → git
  return cmd.replace(/^.*\//, '');
}

/** Simple glob match for binary names (supports * wildcard) */
function globMatchBinary(binary: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
      '$',
  );
  return regex.test(binary);
}

/** Legacy blocklist pattern matching */
function commandMatchesPattern(command: string, pattern: string): boolean {
  if (command === pattern) return true;
  if (!pattern.includes('*') && command.startsWith(pattern)) return true;

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexStr}$`);
  if (regex.test(command)) return true;

  const parts = command.split(/\s*[|;&]\s*/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === pattern) return true;
    if (regex.test(trimmed)) return true;
  }

  return false;
}

// --- Resource limits (unchanged) ---

export function buildResourceLimits(protection: ProcessProtection): string {
  const limits: string[] = [];

  if (protection.max_processes) {
    limits.push(`ulimit -u ${protection.max_processes}`);
  }
  if (protection.max_memory_mb) {
    const memKb = protection.max_memory_mb * 1024;
    limits.push(`ulimit -v ${memKb}`);
  }

  if (limits.length === 0) return '';
  return limits.join(' && ') + ' && ';
}

export function getTermuxApiBlocklist(): string[] {
  return DEFAULT_DENY_ALWAYS.filter((e) => e.binary || e.pattern)
    .map((e) => e.binary || e.pattern!)
    .filter((s) => s.startsWith('termux-'));
}

export function getFullBlocklist(protection: ProcessProtection): string[] {
  const termuxBlocks = getTermuxApiBlocklist();
  const combined = new Set([...protection.blocked_commands, ...termuxBlocks]);
  return [...combined];
}
