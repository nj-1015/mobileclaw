/**
 * MobileClaw Approval CLI
 *
 * Usage:
 *   mobileclaw approve <id> <once|always|block>
 *   mobileclaw approve --list
 *
 * Writes response files to the IPC directory that the OperatorApproval
 * system picks up. Also used by Termux notification button actions.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

const IPC_DIR = path.join(DATA_DIR, 'approval-ipc');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
const APPROVALS_DIR = path.join(IPC_DIR, 'approvals');

export function handleApprovalCli(args: string[]): void {
  if (args.length === 0 || args[0] === '--help') {
    printUsage();
    return;
  }

  if (args[0] === '--list' || args[0] === 'list') {
    listPending();
    return;
  }

  if (args.length < 2) {
    console.error('Usage: mobileclaw approve <id> <once|always|block>');
    process.exit(1);
  }

  const id = args[0];
  const decision = args[1];

  if (!['once', 'always', 'block'].includes(decision)) {
    console.error(
      `Invalid decision: ${decision}. Must be: once, always, or block`,
    );
    process.exit(1);
  }

  respond(id, decision as 'once' | 'always' | 'block');
}

function respond(id: string, decision: 'once' | 'always' | 'block'): void {
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });
  const responseFile = path.join(RESPONSES_DIR, `${id}-${decision}.json`);
  fs.writeFileSync(responseFile, JSON.stringify({ id, decision }));
  console.log(`Approval response sent: ${id} -> ${decision}`);
}

function listPending(): void {
  if (!fs.existsSync(APPROVALS_DIR)) {
    console.log('No pending approvals.');
    return;
  }

  const files = fs
    .readdirSync(APPROVALS_DIR)
    .filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No pending approvals.');
    return;
  }

  console.log(`\n${files.length} pending approval(s):\n`);
  for (const file of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(APPROVALS_DIR, file), 'utf-8'),
      );
      const elapsed = Math.round(
        (Date.now() - new Date(data.timestamp).getTime()) / 1000,
      );
      console.log(`  [${data.id}] ${data.type}: ${data.target}`);
      console.log(`    Agent: ${data.agentName} | Waiting: ${elapsed}s`);
      console.log(`    -> mobileclaw approve ${data.id} once|always|block`);
      console.log('');
    } catch {
      /* skip malformed */
    }
  }
}

function printUsage(): void {
  console.log(`
MobileClaw Approval CLI

Usage:
  mobileclaw approve <id> <decision>    Respond to a pending approval
  mobileclaw approve --list             List all pending approvals

Decisions:
  once     Allow this single request
  always   Allow and add to permanent allowlist
  block    Deny the request

Example:
  mobileclaw approve a1b2c3d4 once
  mobileclaw approve a1b2c3d4 always
  mobileclaw approve --list
`);
}
