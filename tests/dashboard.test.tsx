import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../src/ui/Dashboard.js';
import { manifestFixture, resultFixture, temporaryDirectory, writeFiles } from './helpers.js';

afterEach(() => {
  import('ink-testing-library').then(({ cleanup }) => cleanup());
});
const tick = () => delay(60);

describe('Ink workbench', () => {
  it('shows statuses, approximate progress, costs and check results', async () => {
    const run = manifestFixture([
      resultFixture({ status: 'running', progress: 42, lastMessage: 'Editing auth.ts' }),
      resultFixture({ name: 'beta', status: 'queued', progress: 0 }),
    ]);
    run.status = 'running';
    const screen = render(<Dashboard run={run} onCancel={() => {}} onQuit={() => {}} />);
    await tick();
    expect(screen.lastFrame()).toContain('AGENT FLEET');
    expect(screen.lastFrame()).toContain('alpha');
    expect(screen.lastFrame()).toContain('running');
    expect(screen.lastFrame()).toContain('42%');
    expect(screen.lastFrame()).toContain('Editing auth.ts');
    screen.unmount();
  });
  it('supports agent selection, diff/log views and keyboard cancellation', async () => {
    const repo = await temporaryDirectory();
    const run = manifestFixture([resultFixture(), resultFixture({ name: 'beta' })]);
    run.repoRoot = repo;
    run.status = 'running';
    const first = run.agents[0];
    if (!first) throw new Error('Missing fixture agent');
    first.status = 'running';
    const directory = join(repo, '.agent-fleet', 'runs', run.id, 'agents');
    await writeFiles(directory, {
      'alpha/changes.diff': 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+  new indented\n',
      'alpha/stdout.log': 'alpha full stdout\n',
      'alpha/stderr.log': 'alpha diagnostic\n',
      'beta/stdout.log': 'beta full stdout\n',
      'beta/stderr.log': 'beta diagnostic\n',
    });
    const onCancel = vi.fn();
    const onQuit = vi.fn();
    const screen = render(<Dashboard run={run} onCancel={onCancel} onQuit={onQuit} />);
    await tick();
    screen.stdin.write('d');
    await tick();
    expect(screen.lastFrame()).toContain('new indented');
    screen.stdin.write('\x1b[C');
    screen.stdin.write('l');
    await tick();
    expect(screen.lastFrame()).toContain('beta full stdout');
    expect(screen.lastFrame()).toContain('beta diagnostic');
    screen.stdin.write('q');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onQuit).not.toHaveBeenCalled();
    screen.unmount();
  });
  it('quits a completed run and shows the explicit merge command', async () => {
    const repo = await temporaryDirectory();
    const run = manifestFixture();
    run.repoRoot = repo;
    const onQuit = vi.fn();
    const screen = render(<Dashboard run={run} onCancel={() => {}} onQuit={onQuit} />);
    await tick();
    screen.stdin.write('m');
    await tick();
    expect(screen.lastFrame()).toContain(`agent-fleet merge ${run.id} alpha`);
    screen.stdin.write('q');
    expect(onQuit).toHaveBeenCalledOnce();
    screen.unmount();
  });
});
