# Contributing

Thanks for contributing to `affine-mcp-server`.

## Before You Start

- Node.js `18+` is required (Node `20` recommended).
- You need one AFFiNE instance to run end-to-end checks.
- Read the project docs first:
  - `README.md`
  - `SECURITY.md`
  - `CODE_OF_CONDUCT.md`

## Development Setup

```bash
git clone https://github.com/dawncr0w/affine-mcp-server.git
cd affine-mcp-server
npm ci
npm run build
```

## Local Validation

Run these before opening a PR:

```bash
# Static quality gate (manifest + duplicate tool checks)
npm run test:tool-manifest

# Build
npm run build

# Package sanity check
npm run pack:check
```

If you have a reachable AFFiNE dev server:

```bash
AFFINE_BASE_URL=http://localhost:3010 \
AFFINE_EMAIL=dev@affine.pro \
AFFINE_PASSWORD=dev \
npm run test:comprehensive
```

## Tool Design Rules

- Keep tool names short and action-oriented, using `snake_case`.
- Avoid aliases for the same behavior.
- Avoid adding tools that require special environment setup unless they provide clear value.
- Update `tool-manifest.json` whenever tool list changes.
- Any tool addition/removal must keep `npm run test:tool-manifest` green.

## Pull Request Guidelines

- Keep each PR focused on one logical change.
- Include what changed and why.
- Include validation evidence (commands and result summary).
- Update docs (`README.md`, `CHANGELOG.md`) when behavior changes.

## Commit Message Style

Use conventional, readable commits:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`
- `refactor: ...`

## Reporting Bugs

- Use the GitHub issue templates.
- Include reproduction steps and expected vs actual behavior.
- If security-sensitive, do not open a public issue. Follow `SECURITY.md`.
