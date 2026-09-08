import test from 'node:test';
import assert from 'node:assert/strict';
import { readHostToken, storeHostToken, deleteHostToken } from '../src/adapters/keychain.js';
test('keychain refuses command-like identifiers and invalid token formats before invoking security', async () => {
  for (const value of ['', 'bad\ncommand', 'bad" -w secret', '-flag', 'x'.repeat(200)]) {
    await assert.rejects(readHostToken(value,'host'), /identifier/i);
    await assert.rejects(deleteHostToken('com.polyhedron.host',value), /identifier/i);
  }
  for (const token of ['short', 'secret\ncommand', '"'.repeat(40)]) await assert.rejects(storeHostToken('com.polyhedron.host','host',token), /token/i);
});
