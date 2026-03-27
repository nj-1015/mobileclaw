/**
 * MobileClaw Blueprint Loader
 * Lifecycle: resolve → verify → plan → apply
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import YAML from 'yaml';

import { BlueprintSchema, type Blueprint } from './schema.js';
import { logger } from '../logger.js';

export interface LoadResult {
  blueprint: Blueprint;
  sourcePath: string;
  warnings: string[];
}

/**
 * Step 1: RESOLVE — Load and validate blueprint YAML.
 */
export function resolveBlueprint(blueprintPath: string): LoadResult {
  const absPath = resolvePath(blueprintPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Blueprint not found: ${absPath}`);
  }

  const raw = fs.readFileSync(absPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = BlueprintSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Blueprint validation failed:\n${issues}`);
  }

  const warnings: string[] = [];

  // Warn about missing optional sections
  if (!result.data.protection.inference) {
    warnings.push('No inference config — agent will use cloud API directly');
  }
  if (
    result.data.protection.network.allow.length === 0 &&
    result.data.protection.network.mode === 'allowlist'
  ) {
    warnings.push(
      'Network allowlist is empty — all outbound requests will be blocked or require approval',
    );
  }

  return {
    blueprint: result.data,
    sourcePath: absPath,
    warnings,
  };
}

/**
 * Step 2: VERIFY — Check digest integrity.
 * The digest covers everything except the digest field itself.
 */
export function verifyBlueprint(
  blueprintPath: string,
  blueprint: Blueprint,
): { valid: boolean; computed: string } {
  const absPath = resolvePath(blueprintPath);
  const raw = fs.readFileSync(absPath, 'utf-8');

  // Parse, remove digest, re-serialize deterministically for hashing
  const parsed = YAML.parse(raw);
  delete parsed?.metadata?.digest;
  const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
  const computed = `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;

  if (!blueprint.metadata.digest) {
    // No digest specified — skip verification but return computed
    return { valid: true, computed };
  }

  const valid = blueprint.metadata.digest === computed;
  if (!valid) {
    logger.warn(
      { expected: blueprint.metadata.digest, computed },
      'Blueprint digest mismatch',
    );
  }

  return { valid, computed };
}

/**
 * Compute the digest for a blueprint file (for stamping new blueprints).
 */
export function computeDigest(blueprintPath: string): string {
  const absPath = resolvePath(blueprintPath);
  const raw = fs.readFileSync(absPath, 'utf-8');
  const parsed = YAML.parse(raw);
  delete parsed?.metadata?.digest;
  const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Resolve ~ in paths to the home directory.
 */
export function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(process.env.HOME || '/home', p.slice(1));
  }
  return path.resolve(p);
}
