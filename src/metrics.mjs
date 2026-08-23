// 轻量运行时指标：仅保存在内存中，进程重启后清零。
// 目标是观察代理自身健康度（首 token 延迟、请求时长、上游 429/402 频率与时间点）；
// 用量统计由 commandcode 官方后台提供，这里刻意不做。

const MAX_RECENT = 500;          // 最近请求明细保留条数
const MAX_RATE_LIMIT_EVENTS = 100; // 限流事件时间线保留条数

// 上游 429/402 属于限流/额度类错误，单独归类并记录发生时间。
const RATE_LIMIT_OUTCOMES = new Set(['upstream_429', 'upstream_402']);

export function createMetricsStore({ now = Date.now } = {}) {
  const startedAt = now();
  const recent = [];
  const totals = {
    requests: 0,
    ok: 0,
    upstream_429: 0,
    upstream_402: 0,
    upstream_error: 0,
    timeout: 0,
    empty_output: 0,
    client_disconnect: 0,
    proxy_error: 0,
  };
  const byModel = new Map();
  const rateLimitEvents = [];
  let active = 0;

  function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index];
  }

  function latencyStats(values) {
    if (values.length === 0) return { count: 0, avg: null, p50: null, p95: null, max: null };
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    return {
      count: sorted.length,
      avg: Math.round(sum / sorted.length),
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1],
    };
  }

  function record(entry) {
    totals.requests += 1;
    if (entry.outcome in totals) totals[entry.outcome] += 1;

    const modelKey = entry.model || '(unknown)';
    const modelStat = byModel.get(modelKey)
      || { requests: 0, ok: 0, upstream_429: 0, upstream_402: 0 };
    modelStat.requests += 1;
    if (entry.outcome === 'ok') modelStat.ok += 1;
    if (entry.outcome === 'upstream_429') modelStat.upstream_429 += 1;
    if (entry.outcome === 'upstream_402') modelStat.upstream_402 += 1;
    byModel.set(modelKey, modelStat);

    if (RATE_LIMIT_OUTCOMES.has(entry.outcome)) {
      rateLimitEvents.push({ ts: entry.ts, outcome: entry.outcome, model: entry.model });
      if (rateLimitEvents.length > MAX_RATE_LIMIT_EVENTS) rateLimitEvents.shift();
    }

    recent.push(entry);
    if (recent.length > MAX_RECENT) recent.shift();
  }

  function snapshot() {
    // 延迟统计只基于最近 MAX_RECENT 条明细，避免长跑进程被历史均值拖平。
    const okEntries = recent.filter(entry => entry.outcome === 'ok');
    const ttftValues = okEntries.filter(entry => entry.ttftMs !== null).map(entry => entry.ttftMs);
    const durationValues = recent.map(entry => entry.durationMs);
    const rateLimited = totals.upstream_429 + totals.upstream_402;
    return {
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: now() - startedAt,
      active,
      totals: {
        ...totals,
        rateLimited,
        rateLimitRatio: totals.requests > 0 ? Number((rateLimited / totals.requests).toFixed(4)) : 0,
      },
      ttftMs: latencyStats(ttftValues),
      durationMs: latencyStats(durationValues),
      byModel: [...byModel.entries()].map(([model, stat]) => ({ model, ...stat })),
      recentRateLimits: [...rateLimitEvents].reverse(),
      recent: [...recent].reverse(),
    };
  }

  return {
    begin() { active += 1; },
    record(entry) {
      active -= 1;
      record(entry);
    },
    snapshot,
  };
}

// 单次请求的记录器：捕获首 token 延迟与总时长。
// finish 是幂等的——同一请求有多条终止路径（成功/超时/断连/错误），只记第一次。
export function beginRequest(store, { path, model, stream }) {
  const startedAtMs = Date.now();
  store.begin();
  let finished = false;
  const recorder = {
    ttftMs: null,
    markFirstToken() {
      if (recorder.ttftMs === null) recorder.ttftMs = Date.now() - startedAtMs;
    },
    finish(outcome, extra = {}) {
      if (finished) return;
      finished = true;
      store.record({
        ts: new Date().toISOString(),
        path,
        model,
        stream,
        ttftMs: recorder.ttftMs,
        durationMs: Date.now() - startedAtMs,
        outcome,
        ...extra,
      });
    },
  };
  return recorder;
}
