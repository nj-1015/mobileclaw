/**
 * MobileClaw patch: Sandbox Runner using proot instead of Docker.
 * Spawns agent execution in proot sandboxes and handles IPC.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  loadProtectionConfig,
  getAgentConfigDir,
  getAgentLogDir,
} from './protection/config-loader.js';
import { buildFilesystemSandbox } from './protection/filesystem.js';
import { buildResourceLimits, getFullBlocklist } from './protection/process.js';
import { NetworkLayer } from './protection/network.js';
import { InferenceGateway } from './protection/inference.js';
// import { CanaryIntegrityCheck } from './protection/canary.js'; // disabled — see TODO in runContainerAgent

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---MOBILECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---MOBILECLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Gmail credentials directory (for Gmail MCP inside the sandbox)
  const homeDir = os.homedir();
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: false, // MCP may need to refresh OAuth tokens
    });
  }

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy pre-compiled agent-runner into per-group writable location
  // (Uses dist/ built by scripts/build-agent-runner.mjs — no tsx needed in proot)
  const agentRunnerDist = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'dist',
  );
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir)) {
    // Prefer compiled dist/, fall back to source if dist/ doesn't exist
    const srcDir = fs.existsSync(agentRunnerDist)
      ? agentRunnerDist
      : agentRunnerSrc;
    fs.cpSync(srcDir, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Build proot + node command args instead of docker run args.
 */
function buildSandboxArgs(
  mounts: VolumeMount[],
  sandboxName: string,
  agentRunnerPath: string,
  blueprintName?: string,
): { bin: string; args: string[]; env: Record<string, string> } {
  const prootArgs: string[] = [];

  // Bind mounts
  for (const mount of mounts) {
    prootArgs.push(`--bind=${mount.hostPath}:${mount.containerPath}`);
  }

  // Also bind /tmp for scratch space
  const sandboxTmp = path.join(DATA_DIR, 'tmp', sandboxName);
  fs.mkdirSync(sandboxTmp, { recursive: true });
  prootArgs.push(`--bind=${sandboxTmp}:/tmp`);

  // Bind the project's node_modules and dist so agent-runner can resolve dependencies
  // and access MobileClaw skills (MCP servers in dist/skills/)
  const projectRoot = process.cwd();
  const nodeModulesPath = path.join(projectRoot, 'node_modules');
  prootArgs.push(`--bind=${nodeModulesPath}:${nodeModulesPath}`);
  const distPath = path.join(projectRoot, 'dist');
  if (fs.existsSync(distPath)) {
    prootArgs.push(`--bind=${distPath}:${distPath}`);
  }

  // Also bind the container/agent-runner node_modules if it exists
  const agentRunnerNodeModules = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'node_modules',
  );
  if (fs.existsSync(agentRunnerNodeModules)) {
    prootArgs.push(
      `--bind=${agentRunnerNodeModules}:${agentRunnerNodeModules}`,
    );
  }

  // Bind blueprint protection config into sandbox (read-only at /etc/mobileclaw)
  if (blueprintName) {
    const configDir = getAgentConfigDir(blueprintName);
    if (fs.existsSync(configDir)) {
      prootArgs.push(`--bind=${configDir}:/etc/mobileclaw`);
    }
  }

  // Set working directory inside sandbox
  prootArgs.push('--cwd=/workspace/group');

  // The actual command: node running the pre-compiled agent-runner
  // (proot doesn't support lstat/symlinks needed by tsx, so we pre-compile to .mjs)
  prootArgs.push('node', agentRunnerPath);

  // Build environment variables
  // MobileClaw: In Termux, no Docker VM isolation — the sandbox subprocess
  // shares the host's network and auth. We inherit the host's environment
  // (which has real OAuth/API credentials from Claude Code) instead of
  // routing through the credential proxy with placeholder tokens.
  const projectNodeModules = path.join(projectRoot, 'node_modules');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TZ: TIMEZONE,
    // MobileClaw: keep real HOME so the SDK can find auth tokens in ~/.claude/
    // In Docker, HOME was /home/node (container user). In Termux, we need the real home.
    HOME: process.env.HOME || '/home/node',
    // Ensure node can find modules from the project root
    NODE_PATH: projectNodeModules,
    // Tag the process so cleanupOrphans can find it
    MOBILECLAW_SANDBOX_NAME: `mobileclaw-sandbox-${sandboxName}`,
    // MobileClaw mobile skills MCP server path
    MOBILECLAW_SKILLS_PATH: path.join(
      projectRoot,
      'dist',
      'skills',
      'mcp-mobile.js',
    ),
    // Approval IPC directory (shared between MCP server and host)
    MOBILECLAW_APPROVAL_DIR: path.join(DATA_DIR, 'approval-ipc'),
  };

  // Apply blueprint protection if available
  if (blueprintName) {
    const protection = loadProtectionConfig(blueprintName);

    // Layer 2: Process protection — set ulimit prefix and config path
    if (protection.process) {
      const ulimitPrefix = buildResourceLimits(protection.process);
      if (ulimitPrefix) {
        env.MOBILECLAW_ULIMIT_PREFIX = ulimitPrefix;
      }
      env.MOBILECLAW_PROCESS_CONFIG = '/etc/mobileclaw/process.json';
    }

    // Layer 5: Tool protection — pass config path for PreToolUse hook
    if (protection.tools) {
      env.MOBILECLAW_TOOL_POLICY = '/etc/mobileclaw/live/tools.json';
    }

    // Pass blueprint name so agent-runner knows which agent this is
    env.MOBILECLAW_BLUEPRINT = blueprintName;
  }

  // Remove placeholder ANTHROPIC_BASE_URL from Docker proxy routing.
  // If an inference gateway is active, it will be set later to the gateway's address.
  delete env.ANTHROPIC_BASE_URL;

  return { bin: CONTAINER_RUNTIME_BIN, args: prootArgs, env };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const sandboxName = `${safeName}-${Date.now()}`;

  // Find the agent-runner entry point
  // The pre-compiled agent-runner (ESM .mjs) lives in the per-group dir
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );

  // Check for compiled .js (from build-agent-runner.mjs), then fall back to .ts
  const jsRunner = path.join(groupAgentRunnerDir, 'index.js');
  const tsRunner = path.join(groupAgentRunnerDir, 'index.ts');
  const runnerEntry = fs.existsSync(jsRunner) ? jsRunner : tsRunner;

  const { bin, args, env } = buildSandboxArgs(
    mounts,
    sandboxName,
    runnerEntry,
    group.blueprintName,
  );

  // Layer 3: Start network proxy if blueprint has network config
  let networkProxy: NetworkLayer | null = null;
  if (group.blueprintName) {
    const protection = loadProtectionConfig(group.blueprintName);
    if (protection.network) {
      const agentLogDir = getAgentLogDir(group.blueprintName);
      networkProxy = new NetworkLayer(
        protection.network,
        group.blueprintName,
        agentLogDir,
      );
    }
  }

  let proxyPort = 0;
  if (networkProxy) {
    proxyPort = await networkProxy.start(0); // 0 = random available port
    // Inject proxy env vars so curl/wget/fetch route through our proxy
    env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    env.http_proxy = `http://127.0.0.1:${proxyPort}`;
    env.https_proxy = `http://127.0.0.1:${proxyPort}`;
    env.NO_PROXY = 'localhost,127.0.0.1';
    env.no_proxy = 'localhost,127.0.0.1';
    logger.info(
      {
        proxyPort,
        agentName: group.blueprintName,
        allowedHosts: (networkProxy as any).policy.allow.length,
      },
      'Network proxy started for agent',
    );
  }

  // Layer 4: Start inference gateway if blueprint has inference config
  let inferenceGateway: InferenceGateway | null = null;
  if (group.blueprintName) {
    const protection = loadProtectionConfig(group.blueprintName);
    if (protection.inference) {
      const agentLogDir = getAgentLogDir(group.blueprintName);
      inferenceGateway = new InferenceGateway(
        protection.inference,
        group.blueprintName,
        agentLogDir,
      );
    }
  }

  if (inferenceGateway) {
    const gwPort = await inferenceGateway.start();
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${gwPort}`;
    logger.info(
      { gwPort, agentName: group.blueprintName },
      'Inference gateway started for agent',
    );
  }

  logger.debug(
    {
      group: group.name,
      sandboxName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      command: `${bin} ${args.join(' ')}`,
      networkProxy: proxyPort > 0 ? `127.0.0.1:${proxyPort}` : 'none',
    },
    'Sandbox mount configuration',
  );

  logger.info(
    {
      group: group.name,
      sandboxName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning sandbox agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Canary integrity check: disabled for now.
  // proot on Termux shares $HOME with the host, so the canary file is always
  // readable — producing false-positive "escape detected" that kills every sandbox.
  // TODO: Re-enable when proot --rootfs isolation is configured properly.
  const sandboxProc: { current: ChildProcess | null } = { current: null };

  return new Promise((resolve) => {
    const container = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    sandboxProc.current = container;

    onProcess(container, sandboxName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Sandbox stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ sandbox: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Sandbox stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, sandboxName },
        'Sandbox timeout, stopping',
      );
      // proot child process — just kill it
      try {
        container.kill('SIGTERM');
        setTimeout(() => {
          try {
            container.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 5000);
      } catch {
        /* already dead */
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Stop network proxy
      if (networkProxy) {
        networkProxy.stop().catch(() => {
          /* ignore */
        });
        logger.debug({ group: group.name }, 'Network proxy stopped');
      }

      // Stop inference gateway
      if (inferenceGateway) {
        inferenceGateway.stop().catch(() => {
          /* ignore */
        });
        logger.debug({ group: group.name }, 'Inference gateway stopped');
      }

      // Clean up sandbox tmp
      const sandboxTmp = path.join(DATA_DIR, 'tmp', sandboxName);
      try {
        fs.rmSync(sandboxTmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `sandbox-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Sandbox Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Sandbox: ${sandboxName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, sandboxName, duration, code },
            'Sandbox timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, sandboxName, duration, code },
          'Sandbox timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Sandbox timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `sandbox-${timestamp}.log`);
      const isVerbose = ['debug', 'trace'].includes(
        process.env.MOBILECLAW_LOG_LEVEL || process.env.LOG_LEVEL || '',
      );

      const logLines = [
        `=== Sandbox Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Sandbox log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Sandbox exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Sandbox exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Sandbox completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse last output marker pair
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Sandbox completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse sandbox output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse sandbox output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, sandboxName, error: err },
        'Sandbox spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Sandbox spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
