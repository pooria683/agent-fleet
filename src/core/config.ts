import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { FleetError } from './errors.js';
import type { AdapterKind } from './types.js';

const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, 'Invalid agent/check name');
const commandSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();
const checkSchema = commandSchema.extend({ name: nameSchema });
const agentSchema = z
  .object({
    type: z.enum(['claude', 'codex', 'command']).default('command'),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    run: z
      .object({
        parallel: z.number().int().min(1).max(64).default(2),
        timeoutSeconds: z.number().int().min(1).max(86_400).default(1_800),
        checkTimeoutSeconds: z.number().int().min(1).max(86_400).default(600),
      })
      .strict()
      .default({ parallel: 2, timeoutSeconds: 1_800, checkTimeoutSeconds: 600 }),
    agents: z.record(nameSchema, agentSchema).default({}),
    setup: z.array(commandSchema).default([]),
    checks: z.union([z.literal('auto'), z.literal('none'), z.array(checkSchema)]).default('auto'),
  })
  .strict();

export type FleetConfig = z.output<typeof configSchema>;
export type CommandSpec = z.output<typeof commandSchema>;
export type CheckSpec = z.output<typeof checkSchema>;
export interface ResolvedAgent {
  name: string;
  kind: AdapterKind;
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface LoadedConfig {
  config: FleetConfig;
  path: string | null;
}

export async function loadConfig(repoRoot: string, explicitPath?: string): Promise<LoadedConfig> {
  let path: string | null = explicitPath ? resolve(explicitPath) : null;
  if (!explicitPath) {
    const candidates = [
      'agent-fleet.config.yaml',
      'agent-fleet.config.yml',
      'agent-fleet.config.json',
    ];
    const found: string[] = [];
    for (const candidate of candidates) {
      const full = resolve(repoRoot, candidate);
      try {
        await readFile(full);
        found.push(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (found.length > 1)
      throw new FleetError(`Use only one config file, or --config: ${found.join(', ')}`);
    path = found[0] ?? null;
  }
  if (path === null) return { config: configSchema.parse({}), path: null };
  let raw: unknown;
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 1_048_576)
      throw new FleetError('Configuration exceeds the 1 MiB safety limit.');
    raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 50 });
  } catch (error) {
    throw new FleetError(`Cannot read config ${path}: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`,
    );
    throw new FleetError(`Invalid config ${path}:\n${issues.join('\n')}`);
  }
  for (const name of ['claude', 'codex']) {
    const agent = parsed.data.agents[name];
    if (agent && agent.type !== name)
      throw new FleetError(`agents.${name}.type must be "${name}".`);
  }
  const names = Object.keys(parsed.data.agents);
  for (const name of names) resolveAgent(parsed.data, name);
  if (Array.isArray(parsed.data.checks)) {
    const checkNames = parsed.data.checks.map((check) => check.name);
    if (new Set(checkNames).size !== checkNames.length)
      throw new FleetError('Check names must be unique.');
  }
  return { config: parsed.data, path };
}

export function resolveAgent(config: FleetConfig, name: string): ResolvedAgent {
  if (!nameSchema.safeParse(name).success)
    throw new FleetError(`Invalid agent name: ${JSON.stringify(name)}`);
  const configured = config.agents[name];
  const builtin = name === 'claude' || name === 'codex';
  if (!configured && !builtin) {
    throw new FleetError(
      `Unknown agent "${name}". Define agents.${name} in agent-fleet.config.yaml.`,
    );
  }
  const kind = configured?.type ?? (builtin ? (name as 'claude' | 'codex') : 'command');
  const command = configured?.command ?? (builtin ? name : undefined);
  if (!command) throw new FleetError(`agents.${name}.command is required for a command adapter.`);
  return {
    name,
    kind,
    command,
    args: configured?.args ?? defaultAdapterArgs(kind),
    env: configured?.env ?? {},
  };
}

/** Configured args replace these defaults; protocol/output flags are adapter-owned. */
export function defaultAdapterArgs(kind: AdapterKind): string[] {
  if (kind === 'claude') return ['--permission-mode', 'acceptEdits'];
  if (kind === 'codex') return ['--sandbox', 'workspace-write'];
  return [];
}

export function parseAgentList(value: string): string[] {
  const names = value.split(',').map((name) => name.trim());
  if (names.some((name) => !nameSchema.safeParse(name).success)) {
    throw new FleetError(
      'Use comma-separated agent names containing only letters, numbers, _ and -.',
    );
  }
  if (new Set(names).size !== names.length)
    throw new FleetError('Each agent may appear only once per run.');
  if (names.length > 64) throw new FleetError('A run supports at most 64 agents.');
  return names;
}

export function expandArgs(args: readonly string[], variables: Record<string, string>): string[] {
  return args.map((arg) =>
    arg.replace(/\{(task|agent|repo|worktree|run_dir)\}/g, (token, key: string) => {
      const value = variables[key];
      if (value === undefined) throw new FleetError(`Unknown command placeholder: ${token}`);
      return value;
    }),
  );
}

export function resolveConfigPath(path: string | null, repoRoot: string): string | null {
  return path === null || isAbsolute(path) ? path : resolve(repoRoot, path);
}

export const defaultConfigText = `version: 1
run:
  parallel: 2
  timeoutSeconds: 1800
  checkTimeoutSeconds: 600

agents:
  claude:
    type: claude
    args: [--permission-mode, acceptEdits]
  codex:
    type: codex
    args: [--sandbox, workspace-write]

# Commands are argv arrays, never shell strings. Worktrees do not include node_modules.
# setup:
#   - command: npm
#     args: [ci]
# checks: auto # auto-detect package.json lint/test, or provide an explicit list:
# checks:
#   - name: lint
#     command: npm
#     args: [run, lint]
#   - name: test
#     command: npm
#     args: [test]
`;
