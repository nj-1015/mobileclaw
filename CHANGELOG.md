# Changelog

## v1.1.0 (March 23, 2026) — Security Hardening

- **Process:** Switched from blocklist to allowlist (46 binaries, 3 tiers, chain splitting, args_deny)
- **Filesystem:** Added canary integrity check (30s escape detection → auto-kill + critical notification)
- **Network:** Added DNS monitoring (Shannon entropy exfiltration detection, proxy bypass correlation)
- **Docs:** Added VPN upgrade roadmap (Phase A proxy → Phase B VpnService, forward-compatible YAML)
- **Tests:** 113 tests across 6 suites (up from 60 tests in v1.0)

## v1.0.0 (March 22, 2026) — Initial Release

- Four-layer protection model (filesystem, process, network, inference)
- Blueprint-driven agent provisioning with 3 defaults (conservative, developer, airgapped)
- Operator approval via Android notifications (Allow Once / Allow Always / Block)
- Inference cost tracking with daily budget enforcement
- 8 MCP device tools (battery, clipboard, notifications, vibrate, toast, storage, device info)
- Web chat UI (zero-config, localhost:3002, SSE streaming)
- Terminal CLI channel
- 5-minute onboard wizard
- sql.js compatibility layer (WASM replacement for better-sqlite3)
- 60 tests across 4 suites
