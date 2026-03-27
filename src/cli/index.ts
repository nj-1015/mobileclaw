#!/usr/bin/env node
/**
 * MobileClaw CLI
 *
 * Usage:
 *   mobileclaw onboard                          Interactive setup wizard
 *   mobileclaw create <name> --blueprint <file>  Create agent from blueprint
 *   mobileclaw destroy <name>                    Remove agent
 *   mobileclaw list                              List all agents
 *   mobileclaw <name> launch                     Start agent
 *   mobileclaw <name> stop                       Stop agent
 *   mobileclaw <name> status                     Show agent status
 *   mobileclaw <name> logs                       Show recent logs
 *   mobileclaw <name> blueprint show             Show active blueprint
 *   mobileclaw <name> network allow <domain>     Add domain to allowlist
 *   mobileclaw <name> network block <domain>     Remove domain from allowlist
 *   mobileclaw <name> network reload             Reload network policy
 *   mobileclaw approve <id> <once|always|block>  Respond to pending approval
 *   mobileclaw approve --list                    List pending approvals
 */
import { runOnboard } from './onboard.js';
import { runAgentCommand } from './commands.js';
import { createAgentFromBlueprint, listAgents } from '../blueprints/index.js';
import { handleApprovalCli } from '../approval/index.js';

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printHelp();
  process.exit(0);
}

const command = args[0];

switch (command) {
  case 'onboard':
    await runOnboard();
    break;

  case 'create': {
    const nameIdx = 1;
    const name = args[nameIdx];
    const bpIdx = args.indexOf('--blueprint');
    if (!name || bpIdx === -1 || !args[bpIdx + 1]) {
      console.error('Usage: mobileclaw create <name> --blueprint <file>');
      process.exit(1);
    }
    const blueprintFile = args[bpIdx + 1];
    const force = args.includes('--force');
    try {
      const result = createAgentFromBlueprint(blueprintFile, { force });
      console.log(`\nAgent "${name}" created at ${result.agentDir}`);
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    break;
  }

  case 'list': {
    const agents = listAgents();
    if (agents.length === 0) {
      console.log('No agents. Run: mobileclaw onboard');
    } else {
      console.log(`\n${agents.length} agent(s):\n`);
      for (const name of agents) {
        console.log(`  - ${name}`);
      }
      console.log('');
    }
    break;
  }

  case 'approve':
    handleApprovalCli(args.slice(1));
    break;

  default:
    // mobileclaw <name> <action> [args...]
    if (args.length >= 2) {
      const agentName = args[0];
      const action = args[1];
      const actionArgs = args.slice(2);
      await runAgentCommand(agentName, action, actionArgs);
    } else {
      // Single arg that's not a known command — maybe an agent name without action
      const agents = listAgents();
      if (agents.includes(command)) {
        console.error(`Usage: mobileclaw ${command} <action>`);
        console.error(
          'Actions: launch, stop, status, logs, blueprint, network, approve',
        );
      } else {
        console.error(`Unknown command: ${command}`);
        console.error('Run: mobileclaw --help');
      }
      process.exit(1);
    }
}

function printHelp(): void {
  console.log(`
MobileClaw — Secure AI Agents on Android via Termux

Setup:
  mobileclaw onboard                            Interactive setup wizard
  mobileclaw create <name> --blueprint <file>   Create agent from blueprint
  mobileclaw destroy <name>                     Remove agent
  mobileclaw list                               List all agents

Agent Lifecycle:
  mobileclaw <name> launch                      Start agent in sandbox
  mobileclaw <name> stop                        Stop agent
  mobileclaw <name> status                      Show health & stats

Monitoring:
  mobileclaw <name> logs                        Show recent logs
  mobileclaw <name> blueprint show              Show active blueprint

Runtime Policy (hot-reload):
  mobileclaw <name> network allow <domain>      Add to allowlist
  mobileclaw <name> network block <domain>      Remove from allowlist
  mobileclaw <name> network reload              Reload network policy

Approvals:
  mobileclaw approve <id> <once|always|block>   Respond to pending approval
  mobileclaw approve --list                     List pending approvals
`);
}
