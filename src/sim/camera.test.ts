// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { STALE_MS, cameraFeed } from './camera.ts';

test('the camera feed gives the newest frame, and an error when it has none or it is stale', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cam-')), 'cam.jpg');
  const latest = cameraFeed(file);
  assert.throws(() => latest(), /no frame yet/);
  writeFileSync(file, createCanvas(320, 240).toBuffer('image/jpeg'));
  await new Promise((ok) => setTimeout(ok, 400));
  assert.equal(latest().width, 320);
  assert.throws(() => latest(Date.now() + STALE_MS + 100), /s old/);
});
