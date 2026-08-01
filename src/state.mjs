import { randomBytes } from 'crypto';

// 集中管理运行时状态，避免不同 API Key 之间共享计数或模型缓存。
export function createStateStore({ generateFingerprint, log }) {
  const sessionStore = new Map();
  const keyStateStore = new Map();
  const modelCacheStore = new Map();
  const sessionDurationMs = 12 * 60 * 60 * 1000;
  const sessionJitterMs = 60 * 60 * 1000;
  const stateRetentionMs = sessionDurationMs + sessionJitterMs;

  function touchKey(apiKey) {
    const state = getOrCreateKeyState(apiKey);
    state.lastUsedAt = Date.now();
    return state;
  }

  function ensureSession(apiKey) {
    const now = Date.now();
    const entry = sessionStore.get(apiKey);
    if (entry && now < entry.expiresAt) {
      touchKey(apiKey);
      return entry.sessionId;
    }

    const jitter = Math.floor(Math.random() * sessionJitterMs);
    // 最新 CLI 使用 sess_ 前缀加 16 位十六进制随机值。
    const sessionId = `sess_${randomBytes(8).toString('hex')}`;
    sessionStore.set(apiKey, {
      sessionId,
      expiresAt: now + sessionDurationMs + jitter,
    });
    touchKey(apiKey);
    log('info', 'Session created', { sessionId: sessionId.slice(0, 8), storeSize: sessionStore.size });
    return sessionId;
  }

  function getSessionId(incomingHeaders, apiKey) {
    const candidates = [
      incomingHeaders['x-session-id'],
      incomingHeaders['x-claude-code-session-id'],
    ];
    for (const id of candidates) {
      if (id && typeof id === 'string' && id.length >= 8) {
        touchKey(apiKey);
        return id;
      }
    }
    return ensureSession(apiKey);
  }

  function getOrCreateKeyState(apiKey) {
    let state = keyStateStore.get(apiKey);
    if (!state) {
      state = {
        fingerprint: generateFingerprint(apiKey),
        nextInitAt: 0,
        consecutiveTimeouts: 0,
        lastUsedAt: Date.now(),
      };
      keyStateStore.set(apiKey, state);
      log('info', 'Fingerprint generated for key', { keyPrefix: apiKey.slice(0, 8) });
    }
    state.lastUsedAt = Date.now();
    return state;
  }

  function recordTimeout(apiKey) {
    const state = getOrCreateKeyState(apiKey);
    state.consecutiveTimeouts += 1;
    return state.consecutiveTimeouts;
  }

  function resetTimeout(apiKey) {
    getOrCreateKeyState(apiKey).consecutiveTimeouts = 0;
  }

  function getTimeoutCount(apiKey) {
    return getOrCreateKeyState(apiKey).consecutiveTimeouts;
  }

  function getCachedModels(apiKey, refreshIntervalMs) {
    if (!apiKey) return null;
    const entry = modelCacheStore.get(apiKey);
    if (!entry || Date.now() - entry.fetchedAt >= refreshIntervalMs) return null;
    touchKey(apiKey);
    return entry.models;
  }

  function setCachedModels(apiKey, models) {
    if (!apiKey) return;
    modelCacheStore.set(apiKey, { models, fetchedAt: Date.now() });
    touchKey(apiKey);
  }

  function cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [apiKey, entry] of sessionStore) {
      if (now >= entry.expiresAt) {
        sessionStore.delete(apiKey);
        cleaned += 1;
      }
    }
    for (const [apiKey, state] of keyStateStore) {
      if (now - state.lastUsedAt >= stateRetentionMs) {
        keyStateStore.delete(apiKey);
        modelCacheStore.delete(apiKey);
      }
    }
    for (const [apiKey, entry] of modelCacheStore) {
      if (!keyStateStore.has(apiKey) || now - entry.fetchedAt >= stateRetentionMs) {
        modelCacheStore.delete(apiKey);
      }
    }
    if (cleaned > 0) log('info', 'Session cleanup', { cleaned, remaining: sessionStore.size });
  }

  const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
  cleanupTimer.unref?.();

  return {
    ensureSession,
    getSessionId,
    getOrCreateKeyState,
    recordTimeout,
    resetTimeout,
    getTimeoutCount,
    getCachedModels,
    setCachedModels,
    cleanup,
    stop() {
      clearInterval(cleanupTimer);
    },
  };
}
