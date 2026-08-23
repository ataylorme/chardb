# Contributing to Chardb

Chardb is an experimental database prototype. Do not test it with production data, credentials, or infrastructure. Read [STATUS.md](STATUS.md) before starting work so that isolated components are not mistaken for a working end-to-end system. [ARCHITECTURE.md](ARCHITECTURE.md) describes the current component boundaries, and [PLAN.md](PLAN.md) lists the dependency order for unfinished work.

## Setup

The repository uses Bun 1.2.22 or newer and treats `bun.lock` as the canonical lockfile.

```sh
bun install --frozen-lockfile
```

Do not add an npm lockfile at the repository root. If a root dependency changes, update `package.json` and `bun.lock` together. The chat consumer fixture keeps its own `package-lock.json` because it verifies installation of the packed package through npm.

## Verification

Run the checks that cover your change while developing. CI uses these commands:

```sh
bun run typecheck
bun run lint
bun test
bun run build
bun run --cwd landing build
npm pack --dry-run
```

The repository's current known verification limits are recorded in [STATUS.md](STATUS.md). If a command fails, include the command and relevant output in the pull request. Do not hide an existing failure by weakening a check or skipping a test.

For a focused test run, pass its path to Bun:

```sh
bun test test/path/to/file.test.ts
```

## Issues

Search the [issue tracker](https://github.com/zpg6/chardb/issues) before opening a report. A useful bug report includes:

- the commit or package version;
- the Bun version and operating system;
- the smallest schema and call sequence that reproduces the problem;
- expected and actual behavior;
- error output or a reduced test case using synthetic data.

State whether the failure occurs in a unit test, a focused workerd harness, or a complete Worker, Gateway, and Cdb path. That distinction matters in this repository.

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Pull requests

Keep a pull request narrow enough to review against one claimed behavior. Explain the runtime path affected and name the Durable Object or boundary involved. Add or update tests at the level where the behavior runs. A helper-only test does not establish that a public Worker path works.

Update [ARCHITECTURE.md](ARCHITECTURE.md) or [STATUS.md](STATUS.md) when a change moves a capability between missing, partial, isolated, and implemented. Describe readiness only to the extent supported by the tests and runtime path in the pull request.

Do not commit generated `dist` output, local `.chardb` state, logs, or test worker bundles.
