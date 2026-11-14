import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';

export async function findExecutable(command: string, cwd: string): Promise<string | null> {
  const candidates =
    isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? [resolve(cwd, command)]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Not present/executable in this PATH entry. */
    }
  }
  return null;
}
