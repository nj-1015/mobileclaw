/**
 * MobileClaw Blueprint Engine
 * Full lifecycle: resolve → verify → plan → apply
 */
export {
  BlueprintSchema,
  type Blueprint,
  type ProtectionConfig,
  type NetworkProtection,
} from './schema.js';
export {
  resolveBlueprint,
  verifyBlueprint,
  computeDigest,
  resolvePath,
} from './loader.js';
export { planBlueprint, type PlanResult } from './planner.js';
export {
  applyBlueprint,
  agentExists,
  loadActiveBlueprint,
  listAgents,
  type ApplyResult,
} from './apply.js';

import { resolveBlueprint, verifyBlueprint } from './loader.js';
import { planBlueprint } from './planner.js';
import { applyBlueprint, agentExists } from './apply.js';
import { logger } from '../logger.js';

/**
 * Full lifecycle: resolve → verify → plan → apply
 * Returns the apply result or throws on failure.
 */
export function createAgentFromBlueprint(
  blueprintPath: string,
  opts?: { force?: boolean },
): {
  agentDir: string;
  workspaceDir: string;
} {
  // Step 1: Resolve
  console.log('Step 1/4: RESOLVE — Loading blueprint...');
  const { blueprint, warnings: resolveWarnings } =
    resolveBlueprint(blueprintPath);
  console.log(
    `  Agent: ${blueprint.metadata.name} v${blueprint.metadata.version}`,
  );
  for (const w of resolveWarnings) console.log(`  Warning: ${w}`);

  // Step 2: Verify
  console.log('Step 2/4: VERIFY — Checking integrity...');
  const { valid, computed } = verifyBlueprint(blueprintPath, blueprint);
  if (!valid) {
    throw new Error(
      `Blueprint digest mismatch!\n  Expected: ${blueprint.metadata.digest}\n  Computed: ${computed}`,
    );
  }
  if (blueprint.metadata.digest) {
    console.log('  Digest verified OK');
  } else {
    console.log(`  No digest set (computed: ${computed})`);
  }

  // Check if agent already exists
  if (agentExists(blueprint.metadata.name) && !opts?.force) {
    throw new Error(
      `Agent "${blueprint.metadata.name}" already exists. Use --force to overwrite.`,
    );
  }

  // Step 3: Plan
  console.log('Step 3/4: PLAN — Checking resources...');
  const plan = planBlueprint(blueprint);

  for (const issue of plan.issues) console.log(`  BLOCKER: ${issue}`);
  for (const w of plan.warnings) console.log(`  Warning: ${w}`);
  console.log('  Actions:');
  for (const a of plan.actions) console.log(`    - ${a}`);

  if (!plan.feasible) {
    throw new Error('Blueprint cannot be applied — see blockers above.');
  }

  // Step 4: Apply
  console.log('Step 4/4: APPLY — Creating agent...');
  const result = applyBlueprint(blueprint);
  console.log(`  Agent directory: ${result.agentDir}`);
  console.log(`  Workspace: ${result.workspaceDir}`);
  console.log(`  Blueprint saved: ${result.blueprintCopy}`);

  logger.info(
    { agent: blueprint.metadata.name, agentDir: result.agentDir },
    'Agent created from blueprint',
  );

  return { agentDir: result.agentDir, workspaceDir: result.workspaceDir };
}
