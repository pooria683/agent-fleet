# Contributing to agent-fleet

Thanks for helping make coding-agent comparison more transparent and local-first.

## Setup

Use Node.js 22.12+ and Git 2.39+ on macOS/Linux (or WSL).

```sh
npm ci
npm run dev -- --help
npm run check
npm run demo
```

Keep changes focused. Open an issue for a new permission model, storage format, or breaking CLI/config change before implementing it.

## Engineering expectations

- Preserve the local-first MVP: no mandatory cloud service, telemetry, account or API key.
- Never add implicit shell evaluation of tasks/config arguments.
- Never auto-merge, auto-push, switch the user's branch, or discard uncommitted work.
- Treat worktrees as Git isolation, not a security sandbox.
- Keep unknown cost distinct from zero; do not infer provider billing from tokens.
- Keep manifest writes atomic and raw logs separate from bounded UI previews.
- Add real-Git/process tests for lifecycle changes and fixture-based protocol tests for adapters. CI must not require paid agent calls.
- Update docs and `CHANGELOG.md` for user-visible behavior.

## Pull requests

Run `npm run check`, describe the motivation and safety implications, and include a minimal reproduction for bug fixes. By contributing, you agree that your contribution is licensed under the repository's MIT license.

Do not include credentials, proprietary source code, or unredacted agent logs in issues, fixtures or pull requests.
