/**
 * MobileClaw Blueprint Schema
 * Versioned YAML agent configurations inspired by NemoClaw's blueprint system.
 * Validated with Zod.
 */
import { z } from 'zod';

// --- Sub-schemas ---

const MountSchema = z.object({
  src: z.string(),
  dst: z.string(),
  mode: z.enum(['ro', 'rw']).default('ro'),
});

const SandboxSchema = z.object({
  runtime: z.enum(['termux-proot']).default('termux-proot'),
  workspace: z.object({
    path: z.string(),
    size_limit_mb: z.number().positive().default(2048),
  }),
  mounts: z.array(MountSchema).default(() => []),
  env: z.record(z.string(), z.string()).default(() => ({})),
});

// Layer 1: Filesystem protection
const FilesystemProtectionSchema = z.object({
  allow_read: z
    .array(z.string())
    .default(['/workspace/**', '/tools/**', '/tmp/**']),
  allow_write: z.array(z.string()).default(['/workspace/**', '/tmp/**']),
  deny: z
    .array(z.string())
    .default(['**/*.key', '**/*.pem', '**/.ssh/**', '**/.gnupg/**']),
});

// Layer 2: Process protection
const AllowEntrySchema = z.object({
  binary: z.string(),
  args_deny: z.array(z.string()).optional(),
  condition: z.string().optional(),
  rationale: z.string().optional(),
});

const DenyEntrySchema = z.object({
  binary: z.string().optional(),
  pattern: z.string().optional(),
});

const ProcessProtectionSchema = z.object({
  mode: z.enum(['allowlist', 'blocklist']).default('blocklist'),
  allow: z.array(AllowEntrySchema).optional(),
  deny_always: z.array(DenyEntrySchema).optional(),
  unknown_action: z.enum(['deny', 'ask_operator']).default('deny'),
  blocked_commands: z
    .array(z.string())
    .default([
      'rm -rf /',
      'rm -rf ~',
      'curl * | bash',
      'wget * | sh',
      'termux-camera-photo',
      'termux-sms-send',
      'termux-telephony-call',
      'ssh *',
      'dd if=*',
    ]),
  max_processes: z.number().positive().default(5),
  max_memory_mb: z.number().positive().default(512),
  max_cpu_percent: z.number().min(1).max(100).default(80),
});

// Layer 3: Network protection (hot-reloadable)
const NetworkAllowEntrySchema = z.object({
  host: z.string(),
  rate: z.string().optional(),
});

const NetworkProtectionSchema = z.object({
  mode: z.enum(['allowlist', 'blocklist', 'open']).default('allowlist'),
  enforcement: z.enum(['proxy', 'vpn']).default('proxy'),
  allow: z.array(NetworkAllowEntrySchema).default(() => []),
  unknown_host_action: z
    .enum(['ask_operator', 'block', 'allow_once'])
    .default('block'),
  log_all_requests: z.boolean().default(true),
});

// Layer 4: Inference protection (hot-reloadable)
const InferenceEngineSchema = z.object({
  engine: z.enum(['llama_cpp', 'cloud']),
  provider: z.string().optional(),
  model: z.string(),
  model_path: z.string().optional(),
  context_length: z.number().positive().optional(),
});

const InferenceRoutingSchema = z.object({
  simple_tasks: z.enum(['local', 'cloud']).default('cloud'),
  complex_tasks: z.enum(['local', 'cloud']).default('cloud'),
  sensitive_content: z.enum(['local', 'cloud']).default('local'),
});

const CostTrackingSchema = z.object({
  enabled: z.boolean().default(true),
  max_cloud_cost_per_day_usd: z.number().nonnegative().default(5.0),
});

const InferenceProtectionSchema = z.object({
  gateway_port: z.number().default(8080),
  primary: InferenceEngineSchema.optional(),
  fallback: InferenceEngineSchema.optional(),
  routing: InferenceRoutingSchema.optional(),
  cost_tracking: CostTrackingSchema.optional(),
});

// Layer 5: Tool protection (hot-reloadable)
const ToolApprovalEntrySchema = z.object({
  tool: z.string(),
  reason: z.string().optional(),
});

const ToolBlockEntrySchema = z.object({
  tool: z.string(),
});

const ToolProtectionSchema = z.object({
  require_approval: z.array(ToolApprovalEntrySchema).default(() => []),
  block: z.array(ToolBlockEntrySchema).default(() => []),
});

// Combined protection — use .optional() + .transform() instead of .default(() => ({}))
const ProtectionSchema = z
  .object({
    filesystem: FilesystemProtectionSchema.optional(),
    process: ProcessProtectionSchema.optional(),
    network: NetworkProtectionSchema.optional(),
    inference: InferenceProtectionSchema.optional(),
    tools: ToolProtectionSchema.optional(),
  })
  .transform((val) => ({
    filesystem: val.filesystem ?? FilesystemProtectionSchema.parse({}),
    process: val.process ?? ProcessProtectionSchema.parse({}),
    network: val.network ?? NetworkProtectionSchema.parse({}),
    inference: val.inference,
    tools: val.tools,
  }));

// Metadata
const MetadataSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      'Must be lowercase alphanumeric with hyphens',
    ),
  version: z.string().default('1.0.0'),
  description: z.string().default(''),
  digest: z.string().optional(),
});

// --- Top-level Blueprint Schema ---

export const BlueprintSchema = z.object({
  apiVersion: z.literal('mobileclaw/v1'),
  kind: z.literal('AgentBlueprint'),
  metadata: MetadataSchema,
  sandbox: SandboxSchema,
  protection: ProtectionSchema.optional().transform(
    (val) =>
      val ?? {
        filesystem: FilesystemProtectionSchema.parse({}),
        process: ProcessProtectionSchema.parse({}),
        network: NetworkProtectionSchema.parse({}),
        inference: undefined,
        tools: undefined,
      },
  ),
  skills: z.array(z.string()).default(() => []),
  channels: z
    .array(
      z.object({
        type: z.string(),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default(() => [{ type: 'terminal' }]),
});

export type Blueprint = z.infer<typeof BlueprintSchema>;
export type BlueprintMetadata = z.infer<typeof MetadataSchema>;
export type SandboxConfig = z.infer<typeof SandboxSchema>;
export type ProtectionConfig = z.output<typeof ProtectionSchema>;
export type NetworkProtection = z.infer<typeof NetworkProtectionSchema>;
export type InferenceProtection = z.infer<typeof InferenceProtectionSchema>;
export type FilesystemProtection = z.infer<typeof FilesystemProtectionSchema>;
export type ProcessProtection = z.infer<typeof ProcessProtectionSchema>;
export type ToolProtection = z.infer<typeof ToolProtectionSchema>;
