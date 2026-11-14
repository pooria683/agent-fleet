# Security policy

## Supported versions

The MVP is developed on the default branch and the latest released 0.1.x patch. Older snapshots are not maintained security releases.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository when available. If it is not enabled, contact the repository maintainer through GitHub to arrange a private channel; do **not** publish exploit details, credentials, proprietary code or sensitive agent logs in a public issue.

Include a minimal reproduction, affected versions, impact and any suggested mitigation. Redact secrets and private paths where possible.

## Important trust boundary

agent-fleet intentionally executes user-configured coding CLIs and project setup/lint/test commands. Git worktrees are not OS sandboxes. Running hostile code with your user privileges is outside the protection this tool provides. See [docs/safety.md](docs/safety.md) for container/VM guidance, permission defaults, process cleanup limits, artifact retention and merge rollback behavior.

Provider authentication and model billing are handled by the installed CLIs, not by agent-fleet.
