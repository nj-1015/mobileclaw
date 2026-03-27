#!/usr/bin/env node
/**
 * MobileClaw Process Filter Hook
 *
 * Claude Code PreToolUse hook for the Bash tool.
 * Reads the process policy from MOBILECLAW_PROCESS_POLICY env var,
 * checks the command against the allowlist, and exits non-zero to block.
 *
 * Hook contract:
 * - Receives JSON on stdin: { tool_name, tool_input: { command } }
 * - Exit 0 = allow, exit 2 = block (stdout = reason shown to agent)
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // Only filter Bash tool calls
    if (data.tool_name !== 'Bash') {
      process.exit(0);
    }

    const command = (data.tool_input && data.tool_input.command) || '';
    if (!command.trim()) {
      process.exit(0);
    }

    // Load process policy
    const policyPath = process.env.MOBILECLAW_PROCESS_POLICY;
    if (!policyPath || !fs.existsSync(policyPath)) {
      // No policy = no filtering
      process.exit(0);
    }

    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
    if (policy.mode !== 'allowlist') {
      // Legacy blocklist mode — check blocked_commands
      const blocked = (policy.blocked_commands || []);
      for (const pattern of blocked) {
        if (commandMatchesPattern(command, pattern)) {
          process.stdout.write(`BLOCKED by MobileClaw process policy: matches pattern "${pattern}"`);
          process.exit(2);
        }
      }
      process.exit(0);
    }

    // Allowlist mode: split chains, check each segment
    const segments = splitCommandChain(command);
    for (const segment of segments) {
      const result = checkSegment(segment.trim(), policy);
      if (!result.allowed) {
        process.stdout.write(
          `BLOCKED by MobileClaw process policy: ${result.reason}`
        );
        process.exit(2);
      }
    }

    // Layer 1: Check filesystem deny patterns against file arguments in command
    const fsPolicyPath = process.env.MOBILECLAW_FS_POLICY;
    if (fsPolicyPath && fs.existsSync(fsPolicyPath)) {
      const fsPolicy = JSON.parse(fs.readFileSync(fsPolicyPath, 'utf-8'));
      const denyPatterns = fsPolicy.deny || [];
      if (denyPatterns.length > 0) {
        // Extract potential file paths from command arguments
        const tokens = command.split(/\s+/);
        for (let token of tokens) {
          // Strip surrounding quotes so `cat "/path/file.key"` is still caught
          token = token.replace(/^["']|["']$/g, '');
          // Skip flags and non-path-like tokens
          if (token.startsWith('-') || (!token.includes('/') && !token.includes('.'))) continue;
          for (const pattern of denyPatterns) {
            if (globMatchPath(token, pattern)) {
              process.stdout.write(
                `BLOCKED by MobileClaw filesystem policy: "${token}" matches deny pattern "${pattern}"`
              );
              process.exit(2);
            }
          }
        }
      }
    }

    process.exit(0);
  } catch (err) {
    // Fail-closed when a policy exists (allowlist mode) — if we can't parse or
    // check the policy, block rather than silently allowing everything.
    // Only fail-open when no policy file is configured at all (handled above).
    const policyPath = process.env.MOBILECLAW_PROCESS_POLICY;
    if (policyPath && fs.existsSync(policyPath)) {
      process.stderr.write(`process-filter-hook error (BLOCKING): ${err.message}\n`);
      process.stdout.write(`BLOCKED by MobileClaw: process policy check failed — ${err.message}`);
      process.exit(2);
    }
    // No policy configured — fail-open to avoid breaking non-blueprint agents
    process.stderr.write(`process-filter-hook error: ${err.message}\n`);
    process.exit(0);
  }
});

// --- Allowlist checking logic (mirrors process.ts) ---

function checkSegment(segment, policy) {
  if (!segment) return { allowed: true };

  const binary = extractBinary(segment);
  if (!binary) return { allowed: true, reason: 'no binary detected' };

  // Step 1: Check deny_always
  for (const entry of (policy.deny_always || [])) {
    if (entry.binary && binary === entry.binary) {
      return { allowed: false, reason: `"${binary}" is permanently blocked` };
    }
    if (entry.pattern && globMatchBinary(binary, entry.pattern)) {
      return { allowed: false, reason: `"${binary}" matches deny pattern: ${entry.pattern}` };
    }
  }

  // Step 2: Check allowlist
  const allowEntry = (policy.allow || []).find((e) => e.binary === binary);
  if (!allowEntry) {
    // If unknown_action is ask_operator, request approval via IPC
    if (policy.unknown_action === 'ask_operator') {
      const approved = requestOperatorApproval(binary, segment);
      if (approved) {
        return { allowed: true };
      }
      return { allowed: false, reason: `"${binary}" was not approved by operator` };
    }
    return { allowed: false, reason: `"${binary}" is not on the process allowlist` };
  }

  // Step 3: Check conditions
  if (allowEntry.condition) {
    // For now, network_proxy_active is always true when proxy is running
    // (the hook runs inside the sandbox where HTTP_PROXY is set)
    if (allowEntry.condition === 'network_proxy_active') {
      const proxyActive = !!(process.env.HTTP_PROXY || process.env.http_proxy);
      if (!proxyActive) {
        return { allowed: false, reason: `condition not met: ${allowEntry.condition}` };
      }
    }
  }

  // Step 4: Check args_deny
  if (allowEntry.args_deny) {
    for (const pattern of allowEntry.args_deny) {
      if (segment.includes(pattern)) {
        return { allowed: false, reason: `blocked argument pattern: "${pattern}"` };
      }
    }
  }

  return { allowed: true };
}

function extractBinary(segment) {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  let cmdIdx = 0;
  while (cmdIdx < parts.length && parts[cmdIdx].includes('=') && !parts[cmdIdx].startsWith('-')) {
    cmdIdx++;
  }
  if (cmdIdx >= parts.length) return null;
  return parts[cmdIdx].replace(/^.*\//, '');
}

function splitCommandChain(raw) {
  const segments = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (raw[i] === '&' && raw[i + 1] === '&') {
        segments.push(current); current = ''; i++;
      } else if (raw[i] === '|' && raw[i + 1] === '|') {
        segments.push(current); current = ''; i++;
      } else if (raw[i] === '&') {
        // Single & = background execution — treat as chain separator
        segments.push(current); current = '';
      } else if (raw[i] === ';') {
        segments.push(current); current = '';
      } else if (raw[i] === '|') {
        segments.push(current); current = '';
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }

  if (current.trim()) segments.push(current);
  return segments;
}

/**
 * Request operator approval for an unknown binary via IPC.
 * Writes a request file, polls for a response, with 30s timeout.
 * Returns true if approved, false if blocked or timeout.
 */
function requestOperatorApproval(binary, segment) {
  const approvalDir = process.env.MOBILECLAW_APPROVAL_DIR;
  if (!approvalDir) return false;

  const id = crypto.randomUUID().slice(0, 8);
  const approvalsDir = path.join(approvalDir, 'approvals');
  const responsesDir = path.join(approvalDir, 'responses');

  try { fs.mkdirSync(approvalsDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(responsesDir, { recursive: true }); } catch {}

  // Write approval request
  const request = {
    id,
    type: 'command',
    agentName: process.env.MOBILECLAW_BLUEPRINT || 'unknown',
    target: binary,
    context: segment.trim().slice(0, 200),
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(approvalsDir, `${id}.json`), JSON.stringify(request, null, 2));

  // Log to stderr for visibility
  process.stderr.write(`[APPROVAL] Unknown binary "${binary}" — waiting for operator (${id})...\n`);

  // Poll for response with 30s timeout (100ms intervals)
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    // Check for response files matching our ID
    try {
      const files = fs.readdirSync(responsesDir).filter((f) => f.startsWith(id));
      for (const file of files) {
        const filePath = path.join(responsesDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        try { fs.unlinkSync(filePath); } catch {}
        // Clean up the request file
        try { fs.unlinkSync(path.join(approvalsDir, `${id}.json`)); } catch {}

        if (data.decision === 'block') return false;
        return true; // 'once' or 'always'
      }
    } catch {}

    // Sleep 500ms using synchronous shell sleep (avoids CPU-burning spin-wait)
    try { execSync('sleep 0.5', { stdio: 'pipe', timeout: 2000 }); } catch {}
  }

  // Timeout — clean up and block
  try { fs.unlinkSync(path.join(approvalsDir, `${id}.json`)); } catch {}
  process.stderr.write(`[APPROVAL] Timed out for "${binary}" — blocked\n`);
  return false;
}

function globMatchBinary(binary, pattern) {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return regex.test(binary);
}

function globMatchPath(filePath, pattern) {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp('^' + regexStr + '$').test(filePath);
}

function commandMatchesPattern(command, pattern) {
  if (command === pattern) return true;
  if (!pattern.includes('*') && command.startsWith(pattern)) return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + regexStr + '$').test(command);
}
