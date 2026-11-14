import type { AgentResult, ScoreBreakdown } from '../core/types.js';

export const SCORING_POLICY =
  'Heuristic v1: checks 50 (proportion passed; skipped/missing = 0), lint 15 (passed = 15; failed with a reported positive error count = 15 − 3 per error, min 0; unknown or zero errors on failure = 0), scope 10 (10 at ≤5 files, −1 per extra, min 0), speed 15 (fastest finished candidate gets 15, others proportional), safety 10 (−2 per risk, min 0). Failed/cancelled agents and empty diffs are unranked. This is a triage score, not a measure of correctness or semantic quality.';

export function baseScore(agent: AgentResult): ScoreBreakdown {
  const checks = agent.checks.filter((check) => check.status !== 'skipped');
  const passed = checks.filter((check) => check.status === 'passed').length;
  const lint = agent.checks.find((check) => /lint/i.test(check.name));
  return {
    checks: checks.length ? Math.round((passed / checks.length) * 50) : 0,
    lint:
      lint?.status === 'passed'
        ? 15
        : lint?.status === 'failed' && typeof lint.lintErrors === 'number' && lint.lintErrors > 0
          ? Math.max(0, 15 - 3 * lint.lintErrors)
          : 0,
    scope: Math.max(0, 10 - Math.max(0, agent.filesChanged - 5)),
    speed: 0,
    safety: Math.max(0, 10 - agent.risks.length * 2),
  };
}

export function rankAgents(agents: AgentResult[]): void {
  const eligible = agents.filter((agent) => agent.status === 'completed' && agent.filesChanged > 0);
  const fastest = Math.min(
    ...eligible.map((agent) => agent.durationMs).filter((duration) => duration > 0),
  );
  for (const agent of agents) {
    if (!eligible.includes(agent)) {
      agent.score = null;
      agent.scoreBreakdown = null;
      continue;
    }
    const breakdown = baseScore(agent);
    breakdown.speed = Number.isFinite(fastest)
      ? Math.round((fastest / Math.max(agent.durationMs, 1)) * 15)
      : 15;
    agent.scoreBreakdown = breakdown;
    agent.score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  }
}
