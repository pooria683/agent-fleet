import { render } from 'ink';
import { errorMessage } from '../core/errors.js';
import type { FleetRunner } from '../runner/runner.js';
import { Dashboard } from './Dashboard.js';

export async function renderLiveRun(
  runner: FleetRunner,
  controller: AbortController,
): Promise<void> {
  let warning: string | null = null;
  const instance = render(
    <Dashboard
      run={structuredClone(runner.manifest)}
      onCancel={() => controller.abort()}
      onQuit={() => instance.unmount()}
    />,
    { exitOnCtrlC: false, patchConsole: false, maxFps: 10 },
  );
  const onUpdate = () =>
    instance.rerender(
      <Dashboard
        run={structuredClone(runner.manifest)}
        onCancel={() => controller.abort()}
        onQuit={() => instance.unmount()}
        warning={warning}
      />,
    );
  const onError = (error: Error) => {
    warning = errorMessage(error);
    onUpdate();
  };
  runner.on('update', onUpdate);
  runner.on('persistenceError', onError);
  try {
    await runner.run();
    onUpdate();
    if (!controller.signal.aborted) await instance.waitUntilExit();
  } finally {
    runner.off('update', onUpdate);
    runner.off('persistenceError', onError);
    instance.unmount();
    instance.cleanup();
  }
}
