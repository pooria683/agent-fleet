#!/usr/bin/env node
// Deterministic fixture, NOT an AI agent. No network, credentials, tokens or model calls.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const name = args[args.indexOf('--name') + 1] ?? 'demo';
const task = args[args.indexOf('--task') + 1] ?? '';
const risky = name.includes('risky');
const broken = name.includes('broken');
const event = (value) =>
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...value }));
event({
  type: 'message',
  message: 'Deterministic demo fixture: planning a small, isolated change.',
  progress: 10,
});
await delay(120);
event({ type: 'tool', action: 'write_file', path: 'src/formal.js' });
await mkdir('src', { recursive: true });
await writeFile(
  'src/formal.js',
  `export function formalGreeting(name) {\n  return \`${broken ? 'Good morning' : 'Good morning,'} \${name}.\`;\n}\n${risky ? '// TODO: reconsider this API\n' : ''}`,
);
await writeFile(
  'test/formal.test.js',
  "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { formalGreeting } from '../src/formal.js';\n\ntest('formal greeting', () => {\n  assert.equal(formalGreeting('Ada'), 'Good morning, Ada.');\n});\n",
);
event({ type: 'message', message: 'Implementation and regression test written.', progress: 65 });
await mkdir('notes', { recursive: true });
await writeFile(
  `notes/${name}.md`,
  `# Demo candidate\n\nTask: ${task.replaceAll('\n', ' ')}\n\nThis file was produced by a deterministic local fixture, not a language model.\n`,
);
if (risky) {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  pkg.description = 'A configuration change that the comparison should flag.';
  await writeFile('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  event({
    type: 'message',
    message: 'Also changed package configuration and left a lint issue.',
    progress: 85,
  });
}
console.error('Fixture diagnostic: stderr is captured separately.');
await delay(risky ? 350 : 150);
event({
  type: 'message',
  message: 'Done. agent-fleet will now capture the diff and run checks.',
  progress: 90,
});
