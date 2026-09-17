import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from '../src/atomic.ts';

test('writeJsonAtomic replaces the file instead of truncating it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-atomic-'));
  try {
    const path = join(dir, 'result.json');
    await writeJsonAtomic(path, { frames: 1 });
    const before = await stat(path);

    await writeJsonAtomic(path, { frames: 2 });
    const after = await stat(path);

    // A rename swaps in a different file; truncate-and-write reuses the same
    // one, and for a moment that same one parses as nothing. The inode is how
    // you tell which of the two happened.
    assert.notEqual(before.ino, after.ino, 'the file was replaced, not rewritten in place');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { frames: 2 });
    // And the sibling it was staged through is gone.
    assert.deepEqual(await readdir(dir), ['result.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic leaves the previous file intact when the value cannot be serialised', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-atomic-'));
  try {
    const path = join(dir, 'result.json');
    await writeJsonAtomic(path, { frames: 1 });
    // A circular structure throws inside JSON.stringify.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(() => writeJsonAtomic(path, circular));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { frames: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
