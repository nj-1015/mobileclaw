# MobileClaw

Secure AI agents on Android via Termux. Fork of NanoClaw with four-layer protection: filesystem (proot), process limits, network proxy, and operator approval.

## Quick Context

Single Node.js process running in Termux. Messages arrive via WhatsApp (Baileys), route to Claude Agent SDK running in proot sandboxes. Each group has isolated filesystem and memory. Blueprints (YAML) define per-agent security policies.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/container-runner.ts` | Spawns proot sandbox with mounts and protection layers |
| `src/container-runtime.ts` | Runtime abstraction (proot binary, process cleanup) |
| `src/config.ts` | Paths, trigger pattern, intervals |
| `src/db.ts` | SQLite operations (sql.js for Termux compat) |
| `src/blueprints/schema.ts` | Zod schema for blueprint YAML validation |
| `src/blueprints/apply.ts` | Writes per-agent protection configs from blueprints |
| `src/protection/` | Layer implementations (filesystem, process, network, inference, canary) |
| `src/approval/operator.ts` | Termux notification approval system (IPC) |
| `container/agent-runner/` | Runs inside proot sandbox — Claude SDK, MCP server, hooks |
| `blueprints/*.yaml` | Security profiles (developer, conservative, airgapped) |
| `groups/{name}/CLAUDE.md` | Per-group agent persona and memory |

## Architecture

```
WhatsApp → index.ts → container-runner.ts → proot sandbox
                                              ├─ agent-runner (Claude SDK)
                                              ├─ MCP server (IPC tools)
                                              └─ protection layers (fs/process/network/tools)
```

Blueprints define what each agent can do. Applied at `~/agents/{name}/config/`:
- `filesystem.json` — path allowlists
- `process.json` — command blocklist, resource limits
- `live/network.json` — host allowlist (hot-reloadable)
- `live/tools.json` — MCP tool approval policies (hot-reloadable)

## Development

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript + agent-runner
npm test             # Vitest
```

Deploy to phone:
```bash
bash assemble-repo.sh                    # Build repo/ + tar.gz
adb push mobileclaw-repo.tar.gz /sdcard/Download/
# On phone: bash update.sh
```

## Termux Notes

- **No Docker** — uses proot for filesystem isolation (no root required)
- **sharp** unavailable on android-arm64 — lazy-loaded with graceful fallback
- **tsx** doesn't work inside proot (lstat ENOSYS) — agent-runner is pre-compiled to JS via esbuild
- **Shell scripts** must have LF line endings (`.gitattributes` enforces this)
- **sql.js** used instead of native better-sqlite3 (no native compilation on Termux)

## Testing

```bash
npm test             # All tests
npm test -- src/image.test.ts  # Single file
```

Tests mock proot/sandbox — they run on any platform.
