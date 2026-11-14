import type { RunStore } from '../core/store.js';
import type { RunManifest } from '../core/types.js';
import { isTerminal } from '../core/types.js';
import { writeReport } from '../evaluator/report.js';
import { rankAgents } from '../evaluator/score.js';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Called by inspection commands, never by a second supervisor trying to resume work. */
export async function recoverInterrupted(run: RunManifest, store: RunStore): Promise<RunManifest> {
  if (run.status !== 'running' || run.ownerPid === process.pid || processAlive(run.ownerPid))
    return run;
  run.status = 'interrupted';
  run.finishedAt = new Date().toISOString();
  for (const agent of run.agents) {
    if (isTerminal(agent.status)) continue;
    agent.status = 'failed';
    agent.error =
      'The agent-fleet supervisor exited before recording a final result. Inspect logs and worktree; do not assume the subprocess stopped.';
    agent.finishedAt = run.finishedAt;
    agent.pid = null;
  }
  rankAgents(run.agents);
  await store.save(run);
  await writeReport(run, store.runDirectory(run.id));
  return run;
}
