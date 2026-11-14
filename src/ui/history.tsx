import { render, useApp } from 'ink';
import { useEffect, useState } from 'react';
import type { RunStore } from '../core/store.js';
import type { RunManifest } from '../core/types.js';
import { isRunTerminal } from '../core/types.js';
import { Dashboard } from './Dashboard.js';

function HistoricalDashboard({ initial, store }: { initial: RunManifest; store: RunStore }) {
  const [run, setRun] = useState(initial);
  const [warning, setWarning] = useState<string | null>(null);
  const { exit } = useApp();
  useEffect(() => {
    if (isRunTerminal(run.status)) return;
    const timer = setInterval(() => {
      store
        .load(initial.id)
        .then(setRun)
        .catch((error: unknown) => setWarning(String(error)));
    }, 1_000);
    return () => clearInterval(timer);
  }, [initial.id, run.status, store]);
  return <Dashboard run={run} readOnly onCancel={() => {}} onQuit={exit} warning={warning} />;
}

export async function renderHistoricalRun(run: RunManifest, store: RunStore): Promise<void> {
  const instance = render(<HistoricalDashboard initial={run} store={store} />, {
    exitOnCtrlC: true,
  });
  await instance.waitUntilExit();
  instance.cleanup();
}
