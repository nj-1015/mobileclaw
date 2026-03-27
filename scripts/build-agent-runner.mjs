/**
 * Transpile agent-runner TypeScript to JavaScript using esbuild.
 * Keeps external imports intact (they resolve from node_modules at runtime).
 * Output goes to container/agent-runner/dist/ alongside the source.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const agentRunnerSrc = join(root, 'container', 'agent-runner', 'src');
const agentRunnerDist = join(root, 'container', 'agent-runner', 'dist');

mkdirSync(agentRunnerDist, { recursive: true });

// Transpile .ts files to .js (no bundling — keep imports external)
await build({
  entryPoints: [
    join(agentRunnerSrc, 'index.ts'),
    join(agentRunnerSrc, 'ipc-mcp-stdio.ts'),
  ],
  outdir: agentRunnerDist,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: false,
  // Keep .js extension — we also copy package.json with "type": "module"
});

// Copy the .cjs file as-is
if (existsSync(join(agentRunnerSrc, 'process-filter-hook.cjs'))) {
  cpSync(
    join(agentRunnerSrc, 'process-filter-hook.cjs'),
    join(agentRunnerDist, 'process-filter-hook.cjs'),
  );
}

// Copy package.json so Node knows "type": "module" for .js files
const agentRunnerRoot = join(root, 'container', 'agent-runner');
cpSync(join(agentRunnerRoot, 'package.json'), join(agentRunnerDist, 'package.json'));

console.log('agent-runner transpiled to container/agent-runner/dist/');
