import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite, makePrivateDirectory } from '../utils/fs.js';
import { FleetError } from './errors.js';
import type { RunEvent, RunManifest } from './types.js';

const RUN_ID = /^\d{8}-\d{6}-[a-f0-9]{8}$/;

export function newRunId(date = new Date()): string {
  const timestamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${timestamp}-${randomBytes(4).toString('hex')}`;
}

export function assertRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new FleetError('Invalid run ID. Use an ID from agent-fleet runs.');
}

export class RunStore {
  readonly root: string;
  constructor(readonly repoRoot: string) {
    this.root = join(repoRoot, '.agent-fleet');
  }

  get runsDirectory(): string {
    return join(this.root, 'runs');
  }

  runDirectory(id: string): string {
    assertRunId(id);
    return join(this.runsDirectory, id);
  }

  async create(manifest: RunManifest): Promise<string> {
    const dir = this.runDirectory(manifest.id);
    await makePrivateDirectory(this.runsDirectory);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(join(dir, 'events.jsonl'), '', { mode: 0o600, flag: 'wx' });
    return dir;
  }

  async save(manifest: RunManifest): Promise<void> {
    await atomicWrite(
      join(this.runDirectory(manifest.id), 'run.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  async load(id: string): Promise<RunManifest> {
    const directory = this.runDirectory(id);
    let path: string;
    try {
      path = await realpath(directory);
      if (path !== resolve(directory))
        throw new FleetError('Run directories must not be symbolic links.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new FleetError(`Run ${id} not found in ${this.repoRoot}.`);
      throw error;
    }
    let manifest: RunManifest;
    try {
      manifest = JSON.parse(await readFile(join(path, 'run.json'), 'utf8')) as RunManifest;
    } catch (error) {
      throw new FleetError(`Cannot read run ${id}: ${(error as Error).message}`);
    }
    if (
      manifest.schemaVersion !== 1 ||
      manifest.id !== id ||
      manifest.repoRoot !== this.repoRoot ||
      !Array.isArray(manifest.agents)
    ) {
      throw new FleetError(`Run ${id} has an incompatible or invalid manifest.`);
    }
    return manifest;
  }

  async list(): Promise<RunManifest[]> {
    const entries = await readdir(this.runsDirectory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const manifests: RunManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      try {
        manifests.push(await this.load(entry.name));
      } catch {
        // An incomplete/corrupt run should not hide all other runs.
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async latest(): Promise<RunManifest> {
    const manifest = (await this.list())[0];
    if (!manifest) throw new FleetError('No runs yet. Start one with agent-fleet run.');
    return manifest;
  }

  async resolveId(id?: string): Promise<RunManifest> {
    return id ? this.load(id) : this.latest();
  }

  async appendEvent(event: RunEvent): Promise<void> {
    await appendFile(
      join(this.runDirectory(event.runId), 'events.jsonl'),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    );
  }

  agentDirectory(id: string, agent: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(agent))
      throw new FleetError('Invalid agent name.');
    return join(this.runDirectory(id), 'agents', agent);
  }
}
