import { describe, expect, it } from 'vitest';
import { ClaudeAdapter, CodexAdapter, CommandAdapter } from '../src/agents/adapter.js';
import { configSchema, resolveAgent } from '../src/core/config.js';

const context = {
  task: 'Fix "quotes"; $(do-not-execute)',
  repoRoot: '/repo',
  worktree: '/worktree',
  runDirectory: '/runs/run',
};

describe('agent adapters', () => {
  it('builds Claude headless arguments with the task as one literal argument', () => {
    const command = new ClaudeAdapter().command(
      resolveAgent(configSchema.parse({}), 'claude'),
      context,
    );
    expect(command).toEqual([
      'claude',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      context.task,
    ]);
    expect(command.at(-1)).toBe(context.task);
  });
  it('builds Codex exec with workspace-write, never full access', () => {
    const command = new CodexAdapter().command(
      resolveAgent(configSchema.parse({}), 'codex'),
      context,
    );
    expect(command).toEqual([
      'codex',
      'exec',
      '--sandbox',
      'workspace-write',
      '--json',
      context.task,
    ]);
    expect(command).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('extracts Claude messages, tools, actual reported cost and protocol failure', () => {
    const adapter = new ClaudeAdapter();
    expect(
      adapter.observe(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Editing auth' },
              { type: 'tool_use', name: 'Edit', input: { file: 'auth.ts' } },
            ],
            usage: { input_tokens: 12, output_tokens: 5 },
          },
        }),
        'stdout',
      ),
    ).toMatchObject({
      message: 'Editing auth',
      tool: expect.stringContaining('auth.ts'),
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    const result = adapter.observe(
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Authentication required',
        total_cost_usd: 0.031,
        usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 3 },
      }),
      'stdout',
    );
    expect(result.failed).toBe('Authentication required');
    expect(result.usage).toMatchObject({
      costUsd: 0.031,
      inputTokens: 20,
      outputTokens: 8,
      cachedInputTokens: 3,
    });
  });
  it('extracts Codex command events and tokens without inventing a dollar price', () => {
    const adapter = new CodexAdapter();
    expect(
      adapter.observe(
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', command: 'npm test' },
        }),
        'stdout',
      ).tool,
    ).toBe('npm test');
    const result = adapter.observe(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 },
      }),
      'stdout',
    );
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      costUsd: null,
    });
    expect(
      adapter.observe(
        JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }),
        'stdout',
      ).failed,
    ).toBe('quota exceeded');
  });
  it('supports plain output and documented generic JSON events', () => {
    const adapter = new CommandAdapter();
    expect(adapter.observe('Working on tests', 'stdout').message).toBe('Working on tests');
    expect(adapter.observe('not json but useful', 'stderr').message).toContain('not json');
    expect(
      adapter.observe(
        JSON.stringify({ type: 'message', message: 'half done', progress: 50 }),
        'stdout',
      ),
    ).toMatchObject({ message: 'half done', progress: 50 });
    expect(
      adapter.observe(JSON.stringify({ type: 'tool', action: 'edit' }), 'stdout').tool,
    ).toContain('edit');
    expect(
      adapter.observe(JSON.stringify({ type: 'usage', cost_usd: 0.12 }), 'stdout').usage?.costUsd,
    ).toBe(0.12);
    expect(
      adapter.observe(JSON.stringify({ type: 'error', message: 'failed' }), 'stdout').failed,
    ).toBe('failed');
  });
  it('understands assistant content blocks and error results from compatible generic CLIs', () => {
    const adapter = new CommandAdapter();
    expect(
      adapter.observe(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Editing' },
              { type: 'tool_use', name: 'Edit', input: { path: 'a.ts' } },
            ],
          },
        }),
        'stdout',
      ),
    ).toMatchObject({ message: 'Editing', tool: expect.stringContaining('a.ts') });
    expect(
      adapter.observe(
        JSON.stringify({ type: 'result', is_error: true, result: 'Auth required' }),
        'stdout',
      ).failed,
    ).toBe('Auth required');
  });
  it('ignores malformed events and invalid numeric usage', () => {
    const adapter = new CommandAdapter();
    expect(adapter.observe('{bad json', 'stdout').message).toBe('{bad json');
    expect(
      adapter.observe(JSON.stringify({ type: 'usage', cost_usd: -5, progress: 500 }), 'stdout')
        .usage,
    ).toBeUndefined();
    expect(adapter.observe(JSON.stringify({ progress: '50' }), 'stdout').progress).toBeUndefined();
  });
});
