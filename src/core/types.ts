export type AgentStatus = 'queued' | 'running' | 'checking' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'cancelled';
export type AdapterKind = 'claude' | 'codex' | 'command';

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
  source: string;
}

export interface CheckResult {
  name: string;
  command: string[];
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  logFile: string | null;
  reason: string | null;
  /** Parsed lint summary count, or null when unavailable. Older manifests may omit it. */
  lintErrors?: number | null;
}

export interface ScoreBreakdown {
  checks: number;
  lint: number;
  scope: number;
  speed: number;
  safety: number;
}

export interface AgentResult {
  name: string;
  adapter: AdapterKind;
  status: AgentStatus;
  branch: string;
  worktree: string;
  directory: string;
  baseCommit: string;
  headCommit: string | null;
  snapshotTree: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number;
  agentDurationMs: number;
  exitCode: number | null;
  signal: string | null;
  pid: number | null;
  error: string | null;
  progress: number;
  lastMessage: string;
  usage: Usage;
  filesChanged: number;
  additions: number;
  deletions: number;
  risks: string[];
  checks: CheckResult[];
  score: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  command: string[];
}

export interface RunManifest {
  schemaVersion: 1;
  id: string;
  task: string;
  slug: string;
  repoRoot: string;
  baseCommit: string;
  sourceBranch: string | null;
  createdAt: string;
  finishedAt: string | null;
  status: RunStatus;
  parallel: number;
  timeoutSeconds: number;
  checkTimeoutSeconds: number;
  configPath: string | null;
  warnings: string[];
  ownerPid: number;
  agents: AgentResult[];
  merge: { agent: string; commit: string; targetBranch: string; mergedAt: string } | null;
}

export interface RunEvent {
  timestamp: string;
  runId: string;
  agent: string | null;
  type: 'status' | 'message' | 'tool' | 'usage' | 'check' | 'run';
  message: string;
}

export interface FileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface DiffSnapshot {
  tree: string;
  files: FileChange[];
  additions: number;
  deletions: number;
  risks: string[];
  patchFile: string;
}

export const emptyUsage = (): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  costUsd: null,
  source: 'not reported',
});

export const isTerminal = (status: AgentStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

export const isRunTerminal = (status: RunStatus): boolean => status !== 'running';
