import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertRunId, newRunId, RunStore } from '../src/core/store.js';
import { readDocument } from '../src/ui/document.js';
import {
  formatCommand,
  formatCost,
  formatDuration,
  oneLine,
  plainLine,
  taskSlug,
} from '../src/utils/format.js';
import { runProcess } from '../src/utils/process.js';
import { manifestFixture, temporaryDirectory, writeFiles } from './helpers.js';

describe('local utilities', () => {
  it('formats durations, unknown costs and safe Git task slugs', () => {
    expect(formatDuration(65_400)).toBe('1m 5s');
    expect(formatCost(null)).toBe('—');
    expect(taskSlug('Implement password reset flow')).toBe('implement-password-reset-flow');
    expect(taskSlug('اصلاح رمز عبور')).toBe('task');
    expect(formatCommand(['node', '-e', "console.log('hi')"])).toBe(
      `node -e 'console.log('\\''hi'\\'')'`,
    );
    expect(oneLine('\x1b[31mhello\nworld\x1b[0m')).toBe('hello world');
    expect(plainLine('+  indented\x1b[31m red\x1b[0m')).toBe('+  indented red');
  });
  it('streams chunked UTF-8 JSONL and keeps stdout/stderr separate', async () => {
    const cwd = await temporaryDirectory();
    const lines: string[] = [];
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        `process.stdout.write(Buffer.from(JSON.stringify({message:'سلام'}) + '\\n')); console.error('separate diagnostic')`,
      ],
      { cwd, onLine: (line, stream) => lines.push(`${stream}:${line}`) },
    );
    expect(result.exitCode).toBe(0);
    expect(lines).toContain('stdout:{"message":"سلام"}');
    expect(lines).toContain('stderr:separate diagnostic');
  });
  it('returns actionable missing-executable errors and honors cancellation', async () => {
    const cwd = await temporaryDirectory();
    const missing = await runProcess('agent-fleet-definitely-missing-command', [], { cwd });
    expect(missing.exitCode).toBeNull();
    expect(missing.error).toBeTruthy();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const cancelled = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      cwd,
      signal: controller.signal,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.durationMs).toBeLessThan(3000);
  });
  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL for a process group that ignores SIGTERM',
    async () => {
      const cwd = await temporaryDirectory();
      const result = await runProcess(
        process.execPath,
        [
          '-e',
          `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync('late.txt','bad'),3000)"], {stdio:'ignore'}); setInterval(()=>{},1000)`,
        ],
        { cwd, timeoutMs: 100 },
      );
      expect(result.timedOut).toBe(true);
      expect(result.cancelled).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(1900);
      const { setTimeout: delay } = await import('node:timers/promises');
      await delay(1200);
      const { access } = await import('node:fs/promises');
      await expect(access(join(cwd, 'late.txt'))).rejects.toThrow();
    },
    8000,
  );
  it('bounds TUI document memory but labels truncation', async () => {
    const cwd = await temporaryDirectory();
    await writeFiles(cwd, { 'log.txt': 'first line\nsecond line\nthird line\n' });
    const page = await readDocument(join(cwd, 'log.txt'), 18);
    expect(page.truncated).toBe(true);
    expect(page.text).not.toContain('first line');
    expect(page.totalBytes).toBeGreaterThan(18);
  });
  it('validates run IDs and atomically persists manifests', async () => {
    const repo = await temporaryDirectory();
    const store = new RunStore(repo);
    expect(() => assertRunId('../../escape')).toThrow();
    expect(newRunId(new Date('2026-01-01T01:02:03Z'))).toMatch(/^20260101-010203-[a-f0-9]{8}$/);
    const manifest = manifestFixture();
    manifest.repoRoot = repo;
    await store.create(manifest);
    manifest.task = 'Updated';
    await store.save(manifest);
    expect((await store.load(manifest.id)).task).toBe('Updated');
    expect(await readFile(join(store.runDirectory(manifest.id), 'run.json'), 'utf8')).toContain(
      'Updated',
    );
    expect((await store.latest()).id).toBe(manifest.id);
    await expect(store.create(manifest)).rejects.toThrow();
  });
});
