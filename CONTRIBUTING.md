# Contributing to MobileClaw

## Quick Start

```bash
# Clone and build
git clone https://github.com/jnishimura/mobileclaw && cd mobileclaw
npm install --ignore-scripts
npx tsc

# Run tests
npm test

# Create a test agent
node dist/cli/index.js onboard
```

## What We Accept

- **Bug fixes** — broken behavior, edge cases, platform compatibility
- **Security fixes** — layer bypasses, hardening improvements (see [SECURITY.md](SECURITY.md) for responsible disclosure)
- **New protection layers** — additional security mechanisms
- **New MCP tools** — device integration via Termux:API
- **Blueprint templates** — new use-case profiles
- **Documentation** — corrections, clarifications, guides

## How to Contribute

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure all tests pass: `npm test`
4. Ensure TypeScript compiles: `npx tsc --noEmit`
5. One thing per PR — don't mix unrelated changes
6. Open a PR with a clear description of what and why

## Code Style

- TypeScript with `strict: true`
- Tests use Vitest (`*.test.ts` alongside source files)
- Format with Prettier: `npm run format`
- Lint with ESLint: `npm run lint`

## Project Structure

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full code map.

Key directories:
- `src/protection/` — four security layers + canary + DNS monitor
- `src/blueprints/` — YAML schema, loader, planner, apply
- `src/approval/` — Android notification approval system
- `src/channels/` — terminal and web chat UI
- `src/skills/` — MCP mobile tools
- `src/cli/` — CLI entry point, commands, onboard wizard
- `blueprints/` — default YAML blueprint templates

## Security Reports

**Do not open public GitHub issues for security vulnerabilities.**

Email: security@mobileclaw.dev

See [SECURITY.md](SECURITY.md) for severity tiers and response timelines.
