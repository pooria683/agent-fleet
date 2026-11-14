import { describe, expect, it } from 'vitest';
import {
  configSchema,
  expandArgs,
  loadConfig,
  parseAgentList,
  resolveAgent,
} from '../src/core/config.js';
import { temporaryDirectory, writeFiles } from './helpers.js';

describe('configuration', () => {
  it('provides bounded defaults and conservative built-in adapter flags', () => {
    const config = configSchema.parse({});
    expect(config.run).toEqual({ parallel: 2, timeoutSeconds: 1800, checkTimeoutSeconds: 600 });
    expect(resolveAgent(config, 'claude').args).toEqual(['--permission-mode', 'acceptEdits']);
    expect(resolveAgent(config, 'codex').args).toEqual(['--sandbox', 'workspace-write']);
  });
  it('rejects invalid limits, unknown keys and duplicate check names', async () => {
    expect(() => configSchema.parse({ run: { parallel: 0 } })).toThrow();
    expect(() => configSchema.parse({ typo: true })).toThrow();
    const repo = await temporaryDirectory();
    await writeFiles(repo, {
      'agent-fleet.config.json': JSON.stringify({
        checks: [
          { name: 'test', command: 'true' },
          { name: 'test', command: 'false' },
        ],
      }),
    });
    await expect(loadConfig(repo)).rejects.toThrow('unique');
  });
  it('requires a command for custom adapters and rejects path-like names', async () => {
    const repo = await temporaryDirectory();
    await writeFiles(repo, { 'agent-fleet.config.yaml': 'agents:\n  local:\n    type: command\n' });
    await expect(loadConfig(repo)).rejects.toThrow('command is required');
    expect(() => parseAgentList('claude,claude')).toThrow('once');
    expect(() => parseAgentList('../escape')).toThrow();
    expect(() => resolveAgent(configSchema.parse({}), 'unknown')).toThrow('Unknown agent');
  });
  it('loads YAML and replaces placeholders inside argv without shell evaluation', async () => {
    const repo = await temporaryDirectory();
    await writeFiles(repo, {
      'agent-fleet.config.yaml':
        'agents:\n  local:\n    command: node\n    args: [agent.mjs, "{task}"]\nchecks: none\n',
    });
    const { config, path } = await loadConfig(repo);
    expect(path).toContain('agent-fleet.config.yaml');
    expect(resolveAgent(config, 'local').command).toBe('node');
    const task = '$(touch injected); `whoami`; "hello"';
    expect(expandArgs(['prefix:{task}', '{agent}'], { task, agent: 'local' })).toEqual([
      `prefix:${task}`,
      'local',
    ]);
    expect(config.checks).toBe('none');
  });
  it('rejects oversized configuration before parsing', async () => {
    const repo = await temporaryDirectory();
    await writeFiles(repo, { 'agent-fleet.config.json': ' '.repeat(1_048_577) });
    await expect(loadConfig(repo)).rejects.toThrow('1 MiB safety limit');
  });
  it('does not silently choose between multiple default config files', async () => {
    const repo = await temporaryDirectory();
    await writeFiles(repo, {
      'agent-fleet.config.yaml': 'version: 1',
      'agent-fleet.config.json': '{}',
    });
    await expect(loadConfig(repo)).rejects.toThrow('only one');
  });
});
