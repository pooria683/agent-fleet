export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatCost(cost: number | null): string {
  return cost === null ? '—' : `$${cost.toFixed(4)}`;
}

export function formatCommand(command: readonly string[]): string {
  return command
    .map((arg) =>
      /^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`,
    )
    .join(' ');
}

export function taskSlug(task: string): string {
  const slug = task
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'task';
}

export function oneLine(value: string, maxLength = 160): string {
  const clean = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

/** Remove terminal control sequences while preserving diff indentation. */
export function plainLine(value: string, maxLength = 10_000): string {
  return value
    .replaceAll('\t', '  ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .slice(0, maxLength);
}

export function markdownText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()#!|]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}

export function markdownCode(value: string): string {
  return `\`${value.replaceAll('`', "'")}\``;
}

export function positiveInteger(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}.`);
  }
  return Number(value);
}
