import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

let issues = 0;
for (const directory of ['src', 'test']) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.js')) continue;
    const path = join(directory, file);
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) {
      issues++;
      console.error(result.stderr);
    }
    if ((await readFile(path, 'utf8')).includes('TODO')) {
      issues++;
      console.error(`${path}: unresolved TODO`);
    }
  }
}
console.log(`lint: ${issues} issue(s)`);
process.exitCode = issues ? 1 : 0;
