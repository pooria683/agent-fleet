import { access, cp, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli', 'index.js');
await access(cli).catch(() => {
  throw new Error('Build first: npm run build (or use npm run demo).');
});
await mkdir(tmpdir(), { recursive: true });
const repo = await mkdtemp(join(tmpdir(), 'agent-fleet-demo-'));
await cp(join(root, 'examples', 'demo-project'), repo, { recursive: true });
const git = (...args) => execa('git', args, { cwd: repo, stdio: 'inherit' });
await git('init', '-b', 'main');
await git('config', 'user.name', 'agent-fleet demo');
await git('config', 'user.email', 'demo@example.invalid');
await git('add', '.');
await git('commit', '-m', 'Demo baseline');
console.log(
  `\nOffline fixture demo — no AI, API keys or network calls.\nDisposable repository: ${repo}\n`,
);
await execa(
  process.execPath,
  [
    cli,
    'run',
    '--repo',
    repo,
    '--task',
    'Add a formal greeting',
    '--agents',
    'demo-good,demo-risky',
    '--parallel',
    '2',
    '--no-tui',
  ],
  { stdio: 'inherit' },
);
console.log(
  `\nDemo repository retained at ${repo}\nNothing was merged. Review the report and try the diff/merge commands above.\n`,
);
