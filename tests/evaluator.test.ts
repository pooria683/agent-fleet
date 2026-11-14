import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/core/config.js';
import { detectChecks, executeCheck, parseLintErrorCount } from '../src/evaluator/checks.js';
import { renderReport } from '../src/evaluator/report.js';
import { rankAgents, SCORING_POLICY } from '../src/evaluator/score.js';
import { detectRisks } from '../src/worktree/manager.js';
import { manifestFixture, resultFixture, temporaryDirectory, writeFiles } from './helpers.js';

const passing = {
  name: 'test',
  command: ['npm', 'test'],
  status: 'passed' as const,
  exitCode: 0,
  durationMs: 10,
  logFile: 'check-test.log',
  reason: null,
};
const lintPass = { ...passing, name: 'lint', command: ['npm', 'run', 'lint'] };

describe('evaluation', () => {
  it('rewards checks and penalizes scope, duration and risk transparently', () => {
    const good = resultFixture({ name: 'good', durationMs: 1000, checks: [lintPass, passing] });
    const risky = resultFixture({
      name: 'risky',
      durationMs: 2000,
      filesChanged: 8,
      risks: ['config', 'delete'],
      checks: [{ ...lintPass, status: 'failed', exitCode: 1 }, passing],
    });
    rankAgents([good, risky]);
    expect(good.score).toBe(100);
    expect(risky.score).toBe(25 + 0 + 7 + 8 + 6);
    expect(good.scoreBreakdown).toEqual({ checks: 50, lint: 15, scope: 10, speed: 15, safety: 10 });
  });
  it('records explicit lint summary counts and adjusts score without inventing missing counts', async () => {
    const cwd = await temporaryDirectory();
    const result = await executeCheck(
      {
        command: process.execPath,
        args: ['-e', "console.error('✖ 3 problems (2 errors, 1 warning)'); process.exit(1)"],
        env: {},
      },
      'lint',
      cwd,
      `${cwd}/lint.log`,
      'lint.log',
      10,
      new AbortController().signal,
      {},
    );
    expect(result).toMatchObject({ status: 'failed', lintErrors: 2 });
    const candidate = resultFixture({ checks: [result, passing] });
    rankAgents([candidate]);
    expect(candidate.scoreBreakdown?.lint).toBe(9);
    expect(parseLintErrorCount('Found 12 errors.')).toBe(12);
    expect(parseLintErrorCount('Lint failed to start')).toBeNull();
    expect(renderReport(manifestFixture([candidate]))).toContain('reported lint errors 2');
    const unknown = resultFixture({ checks: [{ ...result, lintErrors: null }, passing] });
    rankAgents([unknown]);
    expect(unknown.scoreBreakdown?.lint).toBe(0);
  });
  it('does not rank failed or empty candidates or treat missing checks as passing', () => {
    const failed = resultFixture({ status: 'failed', checks: [passing] });
    const empty = resultFixture({ name: 'empty', filesChanged: 0 });
    const unchecked = resultFixture({ name: 'unchecked' });
    rankAgents([failed, empty, unchecked]);
    expect(failed.score).toBeNull();
    expect(empty.score).toBeNull();
    expect(unchecked.scoreBreakdown?.checks).toBe(0);
    expect(unchecked.scoreBreakdown?.lint).toBe(0);
    expect(unchecked.score).toBe(35);
  });
  it('detects project scripts and package manager without installing anything', async () => {
    const repo = await temporaryDirectory();
    await writeFiles(repo, {
      'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }),
      'pnpm-lock.yaml': '',
    });
    const result = await detectChecks(repo, configSchema.parse({}));
    expect(result.checks.map((check) => [check.name, check.command, check.args])).toEqual([
      ['lint', 'pnpm', ['run', 'lint']],
      ['test', 'pnpm', ['run', 'test']],
    ]);
    expect((await detectChecks(repo, configSchema.parse({ checks: 'none' }))).reason).toContain(
      'disabled',
    );
  });
  it('reports missing check configuration explicitly', async () => {
    const repo = await temporaryDirectory();
    expect((await detectChecks(repo, configSchema.parse({}))).reason).toContain('explicitly');
    await writeFiles(repo, { 'package.json': '{}' });
    expect((await detectChecks(repo, configSchema.parse({}))).reason).toContain('No lint/test');
  });
  it('flags deletions, configuration and large changes, not ordinary source files', () => {
    const risks = detectRisks([
      { path: 'src/app.ts', status: 'M', additions: 10, deletions: 0 },
      { path: 'package.json', status: 'M', additions: 1, deletions: 1 },
      { path: 'old.ts', status: 'D', additions: 0, deletions: 20 },
      { path: '.github/workflows/ci.yml', status: 'A', additions: 1500, deletions: 0 },
    ]);
    expect(risks).toHaveLength(4);
    expect(risks.join('\n')).toContain('Deleted file');
    expect(risks.join('\n')).toContain('Large change');
  });
  it('renders an escaped report with unknown costs, evidence links and explicit merge instructions', () => {
    const report = renderReport(
      manifestFixture([
        resultFixture({ checks: [passing, lintPass], score: 100 }),
        resultFixture({
          name: 'beta',
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cachedInputTokens: null,
            costUsd: 0.25,
            source: 'test',
          },
        }),
      ]),
    );
    expect(report).toContain('1/2 agents reporting');
    expect(report).toContain('$0.2500');
    expect(report).toContain('never free');
    expect(report).toContain('merge 20260101-000000-abcdef12');
    expect(report).toContain('agents/alpha/changes.diff');
    expect(report).toContain(SCORING_POLICY);
    expect(report).toContain('| alpha | completed |');
    const injected = manifestFixture();
    injected.task = '<script>alert(1)</script> | injection';
    expect(renderReport(injected)).toContain('&lt;script&gt;');
    expect(renderReport(injected)).toContain('\\| injection');
  });
});
