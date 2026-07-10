# Contributing

Thanks for contributing to `affine-mcp-server`.

## Before You Start

- Node.js `20+` is required. Use the version in `.nvmrc` for local development.
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

## Destructive Live-Test Safety

Live integration tests create, update, and delete AFFiNE resources. They are
allowed against loopback targets by default and fail closed for every other
host. The Docker-backed runners use a unique Compose project, private random
credentials, and collision-resistant resource names for each run.

Use `npm run test:live-safety` to verify the guard without contacting AFFiNE.
Never point a live test at production. If a non-loopback disposable test
instance is intentionally required, both values below must match the exact
normalized target:

```bash
export AFFINE_BASE_URL="https://disposable-affine.example.test"
export AFFINE_ALLOW_REMOTE_DESTRUCTIVE_TESTS=1
export AFFINE_REMOTE_DESTRUCTIVE_TEST_CONFIRM="DESTROY https://disposable-affine.example.test"
node tests/test-database-creation.mjs
```

Unset both opt-in variables immediately after the run. Do not store them in a
shell profile, CI environment, or repository file.

## Tool Design Rules

- Keep tool names short and action-oriented, using `snake_case`.
- Avoid aliases for the same behavior.
- Avoid adding tools that require special environment setup unless they provide clear value.
- Update `tool-manifest.json` whenever tool list changes.
- Any tool addition/removal must keep `npm run test:tool-manifest` green.

## Pull Request Guidelines

- Keep each PR focused on one logical change.
- Use a dedicated, non-protected head branch for every pull request.
- Target `develop` for normal feature, fix, refactor, documentation, and maintenance pull requests.
- Only `release/*` branches may target `main`.
- Never use `main`, `develop`, `dev`, or `master` as a pull request head, regardless of the target branch.
- To synchronize release metadata from `main` back to `develop`, create a dedicated branch such as `chore/sync-v2.6.0-to-develop` from the confirmed `main` release commit.
- Include what changed and why.
- Include validation evidence (commands and result summary).
- Update docs (`README.md`, `CHANGELOG.md`) when behavior changes.

## Release Workflow

- Prepare releases from a `release/x.y.z` branch and merge that branch into `main`.
- Keep `package.json`, `package-lock.json`, `tool-manifest.json`, `README.md`, `CHANGELOG.md`, and `RELEASE_NOTES.md` in sync before tagging.
- Use the matching version section from `RELEASE_NOTES.md` as the source for the GitHub Release body.
- Treat `npm run ci` and `npm run test:e2e` as the release validation baseline.

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
