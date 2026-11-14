# Offline demo

This is a tiny Git project with **deterministic command adapters**, not real AI agents. It requires no API keys, network access, or dependency installation.

- `demo-good` adds a formal greeting and a regression test.
- `demo-risky` adds the same feature, but changes package configuration and leaves a lint issue.
- `demo-broken` introduces a failing regression test.

From a built agent-fleet checkout, run `npm run demo`. The script creates a disposable Git repository in your system temp directory, runs two candidates in parallel, executes real lint/tests, and prints the report/worktree locations. It never merges anything.

To try manually, **copy this directory to a new location outside the agent-fleet checkout**, initialize Git, and commit the baseline:

```sh
cp -R examples/demo-project /tmp/fleet-demo
cd /tmp/fleet-demo
git init -b main
git add .
git -c user.name=Demo -c user.email=demo@example.invalid commit -m "Baseline"
node /absolute/path/to/agent-fleet/dist/cli/index.js run \
  --repo . --task "Add a formal greeting" \
  --agents demo-good,demo-risky --parallel 2
```

Use `--no-tui` outside an interactive terminal. After the run, inspect the report and diffs, then explicitly merge a reviewed candidate. See [../../docs/quickstart.md](../../docs/quickstart.md).
