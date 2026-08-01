import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateStore } from '../src/state.mjs';

test('运行时状态按 API Key 隔离', () => {
  const store = createStateStore({
    generateFingerprint: () => ({ id: Math.random() }),
    log: () => {},
  });

  const keyA = 'user_state_a';
  const keyB = 'user_state_b';
  store.recordTimeout(keyA);
  store.recordTimeout(keyA);
  store.recordTimeout(keyB);

  assert.equal(store.getTimeoutCount(keyA), 2);
  assert.equal(store.getTimeoutCount(keyB), 1);
  assert.match(store.getSessionId({}, keyA), /^sess_[0-9a-f]{16}$/);
  assert.equal(store.getSessionId({}, keyA), store.getSessionId({}, keyA));

  store.setCachedModels(keyA, [{ id: 'model-a' }]);
  assert.deepEqual(store.getCachedModels(keyA, 60_000), [{ id: 'model-a' }]);
  assert.equal(store.getCachedModels(keyB, 60_000), null);
  store.stop();
});
