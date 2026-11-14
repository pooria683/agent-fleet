import assert from 'node:assert/strict';
import test from 'node:test';
import { greet } from '../src/greeting.js';

test('the existing greeting still works', () => {
  assert.equal(greet('Ada'), 'Hello Ada');
});
