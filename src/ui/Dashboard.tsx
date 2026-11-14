import { join } from 'node:path';
import { Box, Text, useInput, useStdout } from 'ink';
import { useEffect, useState } from 'react';
import { errorMessage } from '../core/errors.js';
import type { AgentResult, RunManifest } from '../core/types.js';
import { isRunTerminal } from '../core/types.js';
import { summarizeChecks } from '../evaluator/checks.js';
import { formatCost, formatDuration, oneLine, plainLine } from '../utils/format.js';
import { type DocumentPage, readDocument } from './document.js';

export type DetailMode = 'overview' | 'diff' | 'logs' | 'tools' | 'checks' | 'merge';
const modes: DetailMode[] = ['overview', 'diff', 'logs', 'tools', 'checks', 'merge'];
const statusColors = {
  queued: 'gray',
  running: 'cyan',
  checking: 'yellow',
  completed: 'green',
  failed: 'red',
  cancelled: 'yellow',
} as const;

export interface DashboardProps {
  run: RunManifest;
  onCancel: () => void;
  onQuit: () => void;
  warning?: string | null;
  readOnly?: boolean;
}

function ProgressBar({ value }: { value: number }) {
  const filled = Math.max(0, Math.min(12, Math.round((value / 100) * 12)));
  return (
    <Text>
      <Text color="cyan">{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(12 - filled)}</Text> {Math.round(value).toString().padStart(3)}
      %
    </Text>
  );
}

function useDocument(
  path: string | null,
  revision: number,
): DocumentPage & { error: string | null; loading: boolean } {
  const [document, setDocument] = useState<
    DocumentPage & { error: string | null; loading: boolean }
  >({ text: '', totalBytes: 0, truncated: false, error: null, loading: true });
  useEffect(() => {
    // revision is an explicit live-refresh trigger, not data read inside the effect.
    void revision;
    let active = true;
    setDocument({ text: '', totalBytes: 0, truncated: false, error: null, loading: path !== null });
    if (!path) {
      setDocument({ text: '', totalBytes: 0, truncated: false, error: null, loading: false });
      return;
    }
    readDocument(path)
      .then((page) => {
        if (active) setDocument({ ...page, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (active)
          setDocument({
            text: '',
            totalBytes: 0,
            truncated: false,
            error: errorMessage(error),
            loading: false,
          });
      });
    return () => {
      active = false;
    };
  }, [path, revision]);
  return document;
}

interface DocumentRow {
  text: string;
  key: number;
}
function DiffLines({ lines }: { lines: DocumentRow[] }) {
  return (
    <>
      {lines.map(({ text, key }) => {
        const color =
          text.startsWith('+') && !text.startsWith('+++')
            ? 'green'
            : text.startsWith('-') && !text.startsWith('---')
              ? 'red'
              : text.startsWith('@@')
                ? 'cyan'
                : text.startsWith('diff ')
                  ? 'magenta'
                  : 'white';
        return (
          <Text key={key} color={color} wrap="truncate-end">
            {plainLine(text) || ' '}
          </Text>
        );
      })}
    </>
  );
}

export function Dashboard({ run, onCancel, onQuit, warning, readOnly = false }: DashboardProps) {
  const { stdout } = useStdout();
  const columns = Math.max(60, stdout.columns ?? 100);
  const rows = Math.max(18, stdout.rows ?? 28);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<DetailMode>('overview');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [quitRequested, setQuitRequested] = useState(false);
  const finished = isRunTerminal(run.status);
  const agent = run.agents[Math.min(selected, run.agents.length - 1)];
  const agentDirectory = join(
    run.repoRoot,
    '.agent-fleet',
    'runs',
    run.id,
    'agents',
    agent?.name ?? '',
  );
  const active = finished ? 0 : revision;
  const diff = useDocument(
    mode === 'diff' && agent?.snapshotTree ? join(agentDirectory, 'changes.diff') : null,
    active,
  );
  const stdoutLog = useDocument(
    mode === 'logs' ? join(agentDirectory, 'stdout.log') : null,
    active,
  );
  const stderrLog = useDocument(
    mode === 'logs' ? join(agentDirectory, 'stderr.log') : null,
    active,
  );
  const tools = useDocument(mode === 'tools' ? join(agentDirectory, 'tools.jsonl') : null, active);
  const detailHeight = Math.max(
    5,
    rows - Math.min(Math.max(run.agents.length, 2), Math.floor(rows * 0.35)) - 13,
  );
  const contentWidth = columns - 6;

  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [finished]);
  useEffect(() => {
    // Changing the selected document resets its scroll position.
    void selected;
    void mode;
    setOffset(0);
  }, [selected, mode]);

  const quit = () => {
    if (finished || readOnly) onQuit();
    else {
      setQuitRequested(true);
      onCancel();
    }
  };
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      quit();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      setSelected(
        (value) => (value + (key.leftArrow ? -1 : 1) + run.agents.length) % run.agents.length,
      );
      return;
    }
    if (key.tab) {
      setMode(
        (value) =>
          modes[(modes.indexOf(value) + (key.shift ? -1 : 1) + modes.length) % modes.length] ??
          'overview',
      );
      return;
    }
    if (key.escape) {
      setMode('overview');
      return;
    }
    if (key.return) {
      setMode('diff');
      return;
    }
    if (input === 'd') {
      setMode('diff');
      return;
    }
    if (input === 'l') {
      setMode('logs');
      return;
    }
    if (input === 't') {
      setMode('tools');
      return;
    }
    if (input === 'c') {
      setMode('checks');
      return;
    }
    if (input === 'm') {
      setMode('merge');
      return;
    }
    if (key.upArrow)
      mode === 'overview'
        ? setSelected((value) => Math.max(0, value - 1))
        : setOffset((value) => Math.max(0, value - 1));
    if (key.downArrow)
      mode === 'overview'
        ? setSelected((value) => Math.min(run.agents.length - 1, value + 1))
        : setOffset((value) => value + 1);
    if (key.pageUp) setOffset((value) => Math.max(0, value - detailHeight));
    if (key.pageDown) setOffset((value) => value + detailHeight);
    if (key.home) setOffset(0);
    if (key.end) setOffset(1_000_000);
  });

  let lines: string[] = [];
  let documentError: string | null = null;
  let truncated = false;
  let loading = false;
  if (agent) {
    if (mode === 'overview') {
      lines = [
        `Branch     ${agent.branch}`,
        `Worktree   ${agent.worktree}`,
        `Timing     agent ${formatDuration(agent.agentDurationMs)} / total ${formatDuration(agent.durationMs)} / exit ${agent.exitCode ?? '—'}`,
        `Changes    ${agent.filesChanged} files, +${agent.additions}/−${agent.deletions}`,
        `Checks     ${summarizeChecks(agent.checks)}`,
        `Usage      in ${agent.usage.inputTokens ?? '—'} / out ${agent.usage.outputTokens ?? '—'} / cached ${agent.usage.cachedInputTokens ?? '—'} tokens`,
        `Score      ${agent.score === null ? 'unranked (finished candidates with changes only)' : `${agent.score}/100 · heuristic, review required`}`,
        `Risks      ${agent.risks.length ? agent.risks.join('; ') : 'No heuristic flags; not a safety guarantee.'}`,
        `Message    ${agent.lastMessage}`,
        ...(agent.error ? [`Error      ${agent.error}`] : []),
      ];
    } else if (mode === 'diff') {
      lines = agent.snapshotTree
        ? diff.text.split(/\r?\n/)
        : ['The final diff is captured after the agent process exits.'];
      documentError = diff.error;
      truncated = diff.truncated;
      loading = diff.loading;
      if (!agent.snapshotTree && !documentError) documentError = null;
    } else if (mode === 'logs') {
      lines = [
        '── stdout ──',
        ...stdoutLog.text.split(/\r?\n/),
        '── stderr ──',
        ...stderrLog.text.split(/\r?\n/),
      ];
      documentError = stdoutLog.error ?? stderrLog.error;
      truncated = stdoutLog.truncated || stderrLog.truncated;
      loading = stdoutLog.loading || stderrLog.loading;
    } else if (mode === 'tools') {
      lines = tools.text
        ? tools.text.split(/\r?\n/)
        : ['No tool events reported yet. Raw output is available in Logs.'];
      documentError = tools.error;
      truncated = tools.truncated;
      loading = tools.loading;
    } else if (mode === 'checks') {
      lines = agent.checks.length
        ? agent.checks.flatMap((check) => [
            `${check.status.toUpperCase()}  ${check.name}  ·  ${formatDuration(check.durationMs)}  ·  exit ${check.exitCode ?? '—'}`,
            `  ${check.command.join(' ')}`,
            ...(check.reason ? [`  ${check.reason}`] : []),
            ...(check.logFile ? [`  ${join(agentDirectory, check.logFile)}`] : []),
            '',
          ])
        : ['No checks configured. Missing checks do not count as passing.'];
    } else {
      lines = [
        'Nothing is merged from the dashboard. Review first, then run:',
        '',
        `agent-fleet diff ${run.id} ${agent.name}`,
        `agent-fleet merge ${run.id} ${agent.name} --into ${run.sourceBranch ?? '<branch>'} --dry-run`,
        `agent-fleet merge ${run.id} ${agent.name} --into ${run.sourceBranch ?? '<branch>'}`,
        '',
        'The merge command asks for confirmation and requires a clean target.',
        'Only completed, non-empty candidates with an unchanged snapshot qualify.',
        ...(run.merge
          ? [`Already merged: ${run.merge.agent} → ${run.merge.targetBranch} (${run.merge.commit})`]
          : []),
      ];
    }
  }
  const boundedOffset = Math.min(offset, Math.max(0, lines.length - detailHeight));
  const visibleLines = lines.slice(boundedOffset, boundedOffset + detailHeight);
  const visibleRows: DocumentRow[] = visibleLines.map((text, index) => ({
    text,
    key: boundedOffset + index,
  }));
  const tableCapacity = Math.max(2, Math.min(run.agents.length, Math.floor(rows * 0.35)));
  const tableStart = Math.max(
    0,
    Math.min(selected - Math.floor(tableCapacity / 2), run.agents.length - tableCapacity),
  );
  const visibleAgents = run.agents.slice(tableStart, tableStart + tableCapacity);
  const completed = run.agents.filter((candidate) => candidate.status === 'completed').length;
  const knownCosts = run.agents
    .map((candidate) => candidate.usage.costUsd)
    .filter((cost): cost is number => cost !== null);

  return (
    <Box flexDirection="column" height={rows - 1} paddingX={1}>
      <Box justifyContent="space-between" flexShrink={0}>
        <Text bold color="cyan">
          AGENT FLEET <Text color="gray">/ local workbench</Text>
        </Text>
        <Text color={finished ? (run.status === 'completed' ? 'green' : 'yellow') : 'cyan'}>
          {run.status.toUpperCase()} · {completed}/{run.agents.length} completed
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color="gray">
          {run.id} · parallel {run.parallel} · cost{' '}
          {knownCosts.length
            ? formatCost(knownCosts.reduce((sum, cost) => sum + cost, 0))
            : 'unknown'}
          {knownCosts.length > 0 && knownCosts.length < run.agents.length ? ' (partial)' : ''}
        </Text>
      </Box>
      <Box flexShrink={0} marginBottom={1}>
        <Text wrap="truncate-end">Task: {oneLine(run.task, contentWidth - 6)}</Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexShrink={0}
      >
        <Box>
          <Text color="gray">
            {'  '}
            {'AGENT'.padEnd(16)}
            {'STATUS'.padEnd(12)}
            {'PROGRESS'.padEnd(20)}
            {'FILES'.padEnd(7)}
            {'TIME'.padEnd(9)}
            {'COST'.padEnd(10)}CHECKS
          </Text>
        </Box>
        {visibleAgents.map((candidate: AgentResult, index: number) => {
          const actualIndex = tableStart + index;
          return (
            <Box key={candidate.name} gap={1}>
              <Text color={actualIndex === selected ? 'cyan' : 'white'}>
                {actualIndex === selected ? '›' : ' '}
              </Text>
              <Text bold={actualIndex === selected}>
                <Text>{candidate.name.slice(0, 15).padEnd(16)}</Text>
              </Text>
              <Text color={statusColors[candidate.status]}>{candidate.status.padEnd(11)}</Text>
              <ProgressBar value={candidate.progress} />
              <Text>
                {String(candidate.filesChanged).padEnd(7)}
                {formatDuration(candidate.durationMs).padEnd(9)}
                {formatCost(candidate.usage.costUsd).padEnd(10)}
                <Text color="gray">
                  {summarizeChecks(candidate.checks).slice(0, Math.max(8, columns - 91))}
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={mode === 'diff' ? 'cyan' : 'gray'}
        paddingX={1}
        flexGrow={1}
        overflow="hidden"
      >
        <Box justifyContent="space-between" flexShrink={0}>
          <Text bold color="magenta">
            {agent?.name ?? 'No agent'} <Text color="gray">/ {mode}</Text>
          </Text>
          <Text color="gray">
            {mode === 'overview'
              ? 'Enter: diff'
              : `${Math.min(boundedOffset + 1, lines.length)}–${Math.min(boundedOffset + detailHeight, lines.length)} / ${lines.length} lines`}
            {truncated ? ' · tail only' : ''}
          </Text>
        </Box>
        {warning ? (
          <Text color="yellow" wrap="truncate-end">
            Storage warning: {warning}
          </Text>
        ) : null}
        {documentError ? (
          <Text color="yellow" wrap="truncate-end">
            {documentError.includes('ENOENT') ? 'Artifact not available yet.' : documentError}
          </Text>
        ) : loading ? (
          <Text color="gray">Loading…</Text>
        ) : mode === 'diff' ? (
          <DiffLines lines={visibleRows} />
        ) : (
          visibleRows.map(({ text, key }) => (
            <Text
              key={key}
              wrap="truncate-end"
              color={text.startsWith('Error') || text.startsWith('FAILED') ? 'red' : 'white'}
            >
              {plainLine(text, contentWidth) || ' '}
            </Text>
          ))
        )}
        {truncated ? (
          <Text color="yellow">Large file: use the diff/logs CLI for the complete artifact.</Text>
        ) : null}
      </Box>
      <Box flexShrink={0} flexDirection="column">
        <Text color="gray">
          ←/→ agent · Tab view · d diff · l logs · t tools · c checks · m merge · ↑/↓ scroll
        </Text>
        <Text color={quitRequested ? 'yellow' : 'gray'}>
          {quitRequested
            ? 'Stopping agents and checks… please wait; worktrees and logs are retained.'
            : readOnly
              ? 'q quit · inspection only; no automatic merging'
              : finished
                ? 'q quit · review the diff before merging; progress is approximate until completion'
                : 'q / Ctrl+C cancel run · no automatic merging · worktrees are retained'}
        </Text>
      </Box>
    </Box>
  );
}
