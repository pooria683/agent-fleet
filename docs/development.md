# Development

```sh
npm ci
npm run dev -- --help
npm run check
npm run test:coverage
npm run demo
npm pack --dry-run
```

- TypeScript uses strict mode, NodeNext modules and checked indexed access.
- Biome handles formatting, import organization and linting.
- Vitest uses real temporary Git repositories and local fake agents; no provider credentials are needed.
- Ink Testing Library exercises keyboard selection and artifact views without a real terminal.
- Keep generated `dist`, `coverage`, `node_modules` and `.agent-fleet` artifacts out of Git.
- CI runs Node 22/24 on Ubuntu/macOS, then lint, typecheck, tests, build and the offline demo.

Before a release, update the package version and changelog, run the full check and package inspection, and verify `node dist/cli/index.js --help` from the packed artifact. Publishing is intentionally not automated in the MVP.

See [Contributing](../CONTRIBUTING.md) for adapter/test expectations and [Security](../SECURITY.md) for vulnerability reporting.
