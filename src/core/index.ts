/** Public, local-first orchestration API. CLI executables remain user-installed adapters. */

export type { AdapterContext, AdapterUpdate, AgentAdapter } from '../agents/adapter.js';
export { createAdapter } from '../agents/adapter.js';
export { renderReport } from '../evaluator/report.js';
export { rankAgents, SCORING_POLICY } from '../evaluator/score.js';
export type { MergeOptions, MergeResult } from '../runner/merge.js';
export { mergeCandidate } from '../runner/merge.js';
export type { PreparedRun, RunOptions } from '../runner/runner.js';
export { executeRun, FleetRunner, prepareRun } from '../runner/runner.js';
export type { CheckSpec, CommandSpec, FleetConfig, ResolvedAgent } from './config.js';
export { configSchema, expandArgs, loadConfig, parseAgentList, resolveAgent } from './config.js';
export * from './errors.js';
export { newRunId, RunStore } from './store.js';
export * from './types.js';
