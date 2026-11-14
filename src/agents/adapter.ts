import type { ResolvedAgent } from '../core/config.js';
import { expandArgs } from '../core/config.js';
import type { AdapterKind, Usage } from '../core/types.js';
import { oneLine } from '../utils/format.js';

export interface AdapterContext {
  task: string;
  repoRoot: string;
  worktree: string;
  runDirectory: string;
}
export interface AdapterUpdate {
  message?: string;
  tool?: string;
  usage?: Usage;
  failed?: string;
  progress?: number;
}
export interface AgentAdapter {
  readonly kind: AdapterKind;
  command(agent: ResolvedAgent, context: AdapterContext): string[];
  observe(line: string, stream: 'stdout' | 'stderr'): AdapterUpdate;
}

function jsonObject(line: string): Record<string, unknown> | null {
  if (!line.trimStart().startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function finiteNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? oneLine(value, 500) : undefined;
}

export function usageFrom(
  value: Record<string, unknown>,
  source: string,
  costValue: unknown = value.total_cost_usd ?? value.cost_usd,
): Usage {
  return {
    inputTokens: finiteNonnegative(value.input_tokens ?? value.prompt_tokens ?? value.inputTokens),
    outputTokens: finiteNonnegative(
      value.output_tokens ?? value.completion_tokens ?? value.outputTokens,
    ),
    cachedInputTokens: finiteNonnegative(
      value.cache_read_input_tokens ?? value.cached_input_tokens ?? value.cachedInputTokens,
    ),
    costUsd: finiteNonnegative(costValue),
    source,
  };
}

function hasUsage(usage: Usage): boolean {
  return (
    usage.inputTokens !== null ||
    usage.outputTokens !== null ||
    usage.cachedInputTokens !== null ||
    usage.costUsd !== null
  );
}

/** Shared by Claude Code and generic CLIs such as Cursor that emit assistant content blocks. */
function assistantUpdate(event: Record<string, unknown>, source: string): AdapterUpdate {
  const message = record(event.message);
  const content = Array.isArray(message.content) ? message.content : [];
  const tools = content.map(record).filter((item) => item.type === 'tool_use');
  const messages = content
    .map(record)
    .filter((item) => item.type === 'text')
    .map((item) => text(item.text))
    .filter(Boolean);
  const usage = usageFrom(record(message.usage), source);
  return {
    ...(messages.length ? { message: messages.join(' ') } : {}),
    ...(tools.length
      ? {
          tool: tools
            .map((tool) => `${String(tool.name ?? 'tool')} ${JSON.stringify(tool.input ?? {})}`)
            .join('\n'),
        }
      : {}),
    ...(hasUsage(usage) ? { usage } : {}),
  };
}

abstract class JsonAdapter implements AgentAdapter {
  abstract readonly kind: AdapterKind;
  abstract command(agent: ResolvedAgent, context: AdapterContext): string[];
  protected abstract inspect(event: Record<string, unknown>): AdapterUpdate;

  observe(line: string, stream: 'stdout' | 'stderr'): AdapterUpdate {
    if (!line.trim()) return {};
    const event = jsonObject(line);
    if (event) return this.inspect(event);
    const message = text(line);
    return message ? { message: `${stream === 'stderr' ? 'stderr: ' : ''}${message}` } : {};
  }
}

export class ClaudeAdapter extends JsonAdapter {
  readonly kind = 'claude' as const;
  command(agent: ResolvedAgent, context: AdapterContext): string[] {
    return [
      agent.command,
      ...agent.args,
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      context.task,
    ];
  }
  protected override inspect(event: Record<string, unknown>): AdapterUpdate {
    if (event.type === 'assistant') return assistantUpdate(event, 'Claude Code');
    if (event.type === 'result') {
      const usage = usageFrom(record(event.usage), 'Claude Code result', event.total_cost_usd);
      const message = text(event.result);
      return {
        usage,
        ...(message ? { message } : {}),
        ...(event.is_error === true ? { failed: message ?? 'Claude Code reported an error.' } : {}),
      };
    }
    if (event.type === 'system' && event.subtype === 'init')
      return { message: 'Session initialized.' };
    return {};
  }
}

export class CodexAdapter extends JsonAdapter {
  readonly kind = 'codex' as const;
  private usage: Usage = {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    costUsd: null,
    source: 'Codex JSONL',
  };
  command(agent: ResolvedAgent, context: AdapterContext): string[] {
    return [agent.command, 'exec', ...agent.args, '--json', context.task];
  }
  protected override inspect(event: Record<string, unknown>): AdapterUpdate {
    const item = record(event.item);
    if (event.type === 'turn.completed') {
      const usage = usageFrom(record(event.usage), 'Codex JSONL');
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
        if (usage[key] !== null) this.usage[key] = (this.usage[key] ?? 0) + (usage[key] ?? 0);
      }
      return { usage: { ...this.usage }, message: 'Agent turn completed; evaluating changes.' };
    }
    if (event.type === 'turn.failed') {
      return {
        failed: text(record(event.error).message) ?? 'Codex turn failed.',
        message: 'Codex turn failed.',
      };
    }
    if (event.type === 'error')
      return { message: text(event.message) ?? 'Codex reported an error.' };
    if (event.type === 'item.completed' || event.type === 'item.started') {
      if (item.type === 'agent_message' && event.type === 'item.completed')
        return { message: text(item.text) ?? 'Agent message received.' };
      if (item.type === 'command_execution')
        return {
          tool: text(item.command) ?? 'command',
          message: `Command: ${text(item.command) ?? 'running'}`,
        };
      if (item.type === 'file_change')
        return { tool: JSON.stringify(item.changes ?? item), message: 'Changed files.' };
      if (item.type === 'mcp_tool_call')
        return { tool: JSON.stringify(item), message: `Tool: ${String(item.tool ?? 'MCP')}` };
      if (item.type === 'plan') {
        const steps = Array.isArray(item.plan) ? item.plan.map(record) : [];
        const completed = steps.filter((step) => step.status === 'completed').length;
        return {
          message: `Plan: ${completed}/${steps.length} steps completed.`,
          ...(steps.length ? { progress: (completed / steps.length) * 90 } : {}),
        };
      }
    }
    if (event.type === 'thread.started') return { message: 'Session initialized.' };
    return {};
  }
}

export class CommandAdapter extends JsonAdapter {
  readonly kind = 'command' as const;
  command(agent: ResolvedAgent, context: AdapterContext): string[] {
    return [
      agent.command,
      ...expandArgs(agent.args, {
        task: context.task,
        agent: agent.name,
        repo: context.repoRoot,
        worktree: context.worktree,
        run_dir: context.runDirectory,
      }),
    ];
  }
  protected override inspect(event: Record<string, unknown>): AdapterUpdate {
    if (event.type === 'assistant') return assistantUpdate(event, 'command adapter');
    const usage = usageFrom(
      record(event.usage),
      'command adapter',
      event.cost_usd ?? event.total_cost_usd,
    );
    const message = text(event.message) ?? text(event.text) ?? text(event.result);
    const progress = finiteNonnegative(event.progress);
    const tool =
      event.type === 'tool' || event.type === 'tool_use' || event.type === 'action'
        ? JSON.stringify(event)
        : undefined;
    return {
      ...(message ? { message } : {}),
      ...(tool ? { tool } : {}),
      ...(hasUsage(usage) ? { usage } : {}),
      ...(progress !== null && progress <= 100 ? { progress } : {}),
      ...(event.type === 'error' ||
      event.type === 'failed' ||
      (event.type === 'result' && event.is_error === true)
        ? { failed: message ?? 'Command agent reported an error.' }
        : {}),
    };
  }
}

export function createAdapter(kind: AdapterKind): AgentAdapter {
  if (kind === 'claude') return new ClaudeAdapter();
  if (kind === 'codex') return new CodexAdapter();
  return new CommandAdapter();
}
