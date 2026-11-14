import { join } from 'node:path';
import type { RunManifest } from '../core/types.js';
import { isRunTerminal } from '../core/types.js';
import {
  formatCommand,
  formatCost,
  formatDuration,
  markdownCode,
  markdownText,
} from '../utils/format.js';
import { atomicWrite } from '../utils/fs.js';
import { SCORING_POLICY } from './score.js';

export function renderReport(run: RunManifest): string {
  const lines = [
    '# agent-fleet comparison',
    '',
    `**Run:** ${markdownCode(run.id)} · **Status:** ${run.status}`,
    `**Task:** ${markdownText(run.task)}`,
    `**Base:** ${markdownCode(run.baseCommit)} · **Source branch:** ${markdownCode(run.sourceBranch ?? '(detached HEAD)')}`,
    `**Started:** ${run.createdAt} · **Finished:** ${run.finishedAt ?? 'in progress'}`,
    `**Concurrency:** ${run.parallel} · **Agent timeout:** ${run.timeoutSeconds}s · **Check timeout:** ${run.checkTimeoutSeconds}s`,
    '',
    '> Review every diff before merging. Worktrees isolate Git changes, not malicious processes. Scores are a heuristic, not proof of correctness.',
    '',
  ];
  if (run.warnings.length) {
    lines.push('## Warnings', '');
    for (const warning of run.warnings) lines.push(`- ${markdownText(warning)}`);
    lines.push('');
  }
  lines.push(
    '## Comparison',
    '',
    '| Agent | Status | Score | Duration | Files | +/− | Checks | Reported cost | Exit |',
    '|---|---|---:|---:|---:|---:|---|---:|---:|',
  );
  const sorted = [...run.agents].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  for (const agent of sorted) {
    const checks = agent.checks.length
      ? agent.checks.map((check) => `${markdownText(check.name)}: ${check.status}`).join('; ')
      : 'not configured';
    lines.push(
      `| ${markdownText(agent.name)} | ${agent.status} | ${agent.score ?? 'unranked'} | ${formatDuration(agent.durationMs)} | ${agent.filesChanged} | +${agent.additions}/−${agent.deletions} | ${checks} | ${formatCost(agent.usage.costUsd)} | ${agent.exitCode ?? '—'} |`,
    );
  }
  const costs = run.agents
    .map((agent) => agent.usage.costUsd)
    .filter((cost): cost is number => cost !== null);
  lines.push(
    '',
    `**Known reported cost:** ${costs.length ? `$${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}` : 'not available'} (${costs.length}/${run.agents.length} agents reporting).`,
    '',
    '“—” means unknown, never free. Only agent-reported USD costs are summed; subscription charges and unreported check/tool spend are not inferred. Token counts are shown below when available.',
    '',
    '## Candidates',
    '',
  );
  for (const agent of sorted) {
    lines.push(
      `### ${markdownText(agent.name)}`,
      '',
      `- **Branch:** ${markdownCode(agent.branch)}`,
      `- **Worktree:** ${markdownCode(agent.worktree)}`,
      `- **Adapter:** ${agent.adapter}`,
      `- **Status:** ${agent.status}${agent.error ? ` — ${markdownText(agent.error)}` : ''}`,
      `- **Agent duration:** ${formatDuration(agent.agentDurationMs)}; **total including checks:** ${formatDuration(agent.durationMs)}`,
      `- **Started / finished:** ${agent.startedAt ?? 'not started'} / ${agent.finishedAt ?? 'not finished'}`,
      `- **Exit code:** ${agent.exitCode ?? 'unknown'}${agent.signal ? ` · signal ${agent.signal}` : ''}`,
      `- **Snapshot tree:** ${agent.snapshotTree ? markdownCode(agent.snapshotTree) : 'not captured'}`,
      `- **Tokens (input / output / cached):** ${agent.usage.inputTokens ?? '—'} / ${agent.usage.outputTokens ?? '—'} / ${agent.usage.cachedInputTokens ?? '—'} (${markdownText(agent.usage.source)})`,
      `- **Command:** ${markdownCode(formatCommand(agent.command))}`,
      '',
      '#### Checks',
      '',
    );
    if (!agent.checks.length) lines.push('No checks configured. This is not a passing result.', '');
    for (const check of agent.checks) {
      lines.push(
        `- **${markdownText(check.name)}:** ${check.status} · ${formatDuration(check.durationMs)} · exit ${check.exitCode ?? '—'}${/lint/i.test(check.name) ? ` · reported lint errors ${check.lintErrors ?? 'unknown'}` : ''}${check.reason ? ` · ${markdownText(check.reason)}` : ''}`,
      );
      lines.push(`  - Command: ${markdownCode(formatCommand(check.command))}`);
      if (check.logFile)
        lines.push(
          `  - [Full log](agents/${encodeURIComponent(agent.name)}/${encodeURIComponent(check.logFile)})`,
        );
    }
    lines.push('', '#### Risk flags', '');
    if (!agent.risks.length)
      lines.push('No flags from the filename/size heuristic. This does not establish safety.', '');
    else for (const risk of agent.risks) lines.push(`- ${markdownText(risk)}`);
    if (agent.scoreBreakdown) {
      const score = agent.scoreBreakdown;
      lines.push(
        '',
        `**Score:** ${agent.score}/100 = checks ${score.checks} + lint ${score.lint} + scope ${score.scope} + speed ${score.speed} + safety ${score.safety}`,
        '',
      );
    }
    lines.push(
      '#### Artifacts',
      '',
      `- [Full diff](agents/${encodeURIComponent(agent.name)}/changes.diff)`,
      `- [stdout](agents/${encodeURIComponent(agent.name)}/stdout.log) · [stderr](agents/${encodeURIComponent(agent.name)}/stderr.log) · [tool events](agents/${encodeURIComponent(agent.name)}/tools.jsonl)`,
      '',
      '```sh',
      `agent-fleet diff ${run.id} ${agent.name}`,
      `agent-fleet logs ${run.id} ${agent.name} --stream all`,
      '```',
      '',
    );
  }
  lines.push(
    '## Scoring',
    '',
    SCORING_POLICY,
    '',
    '## Select and merge',
    '',
    'Nothing is merged automatically. Inspect the diff and logs, then explicitly choose a candidate:',
    '',
    '```sh',
  );
  const example =
    sorted.find((agent) => agent.status === 'completed' && agent.filesChanged > 0) ?? sorted[0];
  if (example) {
    lines.push(`agent-fleet diff ${run.id} ${example.name}`);
    lines.push(
      `agent-fleet merge ${run.id} ${example.name} --into ${run.sourceBranch ?? '<target-branch>'} --dry-run`,
    );
    lines.push(
      `agent-fleet merge ${run.id} ${example.name} --into ${run.sourceBranch ?? '<target-branch>'}`,
    );
  }
  lines.push(
    '```',
    '',
    'Merge requires a clean target checkout and a completed, non-empty candidate. Conflicts abort the merge without leaving the target half-merged. Worktrees and logs are retained.',
    '',
  );
  if (run.merge)
    lines.push(
      `**Merged:** ${markdownText(run.merge.agent)} → ${markdownCode(run.merge.targetBranch)} at ${markdownCode(run.merge.commit)} (${run.merge.mergedAt}).`,
      '',
    );
  if (!isRunTerminal(run.status))
    lines.push(
      '_This is an interim report. Wait for the run to finish before selecting a candidate._',
      '',
    );
  return `${lines.join('\n')}\n`;
}

export async function writeReport(run: RunManifest, runDirectory: string): Promise<string> {
  const path = join(runDirectory, 'report.md');
  await atomicWrite(path, renderReport(run));
  return path;
}
