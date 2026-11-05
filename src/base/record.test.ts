import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from './record.ts';

const line = (o: object) => JSON.stringify({ episode: 'ep-1', ...o }) + '\n';

test('summarize counts each kind', () => {
  const text = line({ kind: 'decision', request_id: 'r1' }) + line({ kind: 'decision', request_id: 'r2' }) +
    line({ kind: 'safe_stop' }) + line({ kind: 'rejected_command' }) + line({ kind: 'approval' }) + line({ kind: 'denied' });
  assert.deepEqual(summarize('ep-1', text), { decisions: 2, safeStops: 1, approvals: 1, denials: 1 });
});

test('summarize refuses what must never be anchored', () => {
  assert.throws(() => summarize('ep-1-mock', line({ episode: 'ep-1-mock', kind: 'decision' })), /mock Router/);
  assert.throws(() => summarize('ep-1', line({ kind: 'decision', request_id: 'mock-7' })), /mock decisions/);
  assert.throws(() => summarize('ep-1', line({ episode: 'ep-2', kind: 'decision' })), /another episode/);
  assert.throws(() => summarize('ep-1', ''), /no entries/);
});
