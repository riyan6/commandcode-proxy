// 指标仪表盘：单文件静态页面，无外部依赖。
// 交互方式：首次打开弹窗输入 API Key（user_ 前缀），保存在浏览器 localStorage，
// 之后自动携带访问 /stats；鉴权失败会重新弹窗。数据接口见 metrics.mjs。

export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CC Proxy 指标</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0f1117; color: #e6e6e6;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a8f9d; font-size: 12px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .card { background: #171a23; border: 1px solid #262b38; border-radius: 10px; padding: 12px 14px; }
  .card .label { color: #8a8f9d; font-size: 12px; }
  .card .value { font-size: 22px; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .card.warn .value { color: #f0a45c; }
  .card.bad .value { color: #ef6b6b; }
  .card.good .value { color: #63c98d; }
  section { margin-bottom: 20px; }
  h2 { font-size: 15px; margin: 0 0 8px; color: #c7cbd6; }
  table { width: 100%; border-collapse: collapse; background: #171a23; border: 1px solid #262b38; border-radius: 10px; overflow: hidden; }
  th, td { padding: 7px 12px; text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th { background: #1d2230; color: #8a8f9d; font-weight: 500; font-size: 12px; }
  tr:nth-child(even) td { background: #191d28; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; }
  .tag.ok { background: #12351f; color: #63c98d; }
  .tag.upstream_429, .tag.upstream_402 { background: #3a2413; color: #f0a45c; }
  .tag.timeout, .tag.proxy_error, .tag.upstream_error { background: #3a1414; color: #ef6b6b; }
  .tag.empty_output, .tag.client_disconnect { background: #2b2a35; color: #b8bdc9; }
  .actions { margin-bottom: 16px; }
  button { background: #262b38; color: #e6e6e6; border: 0; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
  button:hover { background: #313849; }
  .empty { color: #6b7180; padding: 14px; }
</style>
</head>
<body>
<h1>CC Proxy 指标</h1>
<div class="sub" id="meta">加载中…</div>
<div class="actions">
  <button onclick="refresh()">刷新</button>
  <button onclick="resetToken()">更换 Key</button>
  <span class="sub" id="refreshState"></span>
</div>

<section><h2>概览</h2><div class="cards" id="cards"></div></section>
<section><h2>延迟（基于最近请求明细）</h2><div class="cards" id="latency"></div></section>
<section><h2>按模型</h2><div id="models"></div></section>
<section><h2>最近限流事件（上游 429/402）</h2><div id="rateLimits"></div></section>
<section><h2>最近请求</h2><div id="requests"></div></section>

<script>
var TOKEN_KEY = 'cc-proxy-token';
var REFRESH_MS = 5000;
var timer = null;

function getToken(promptMessage) {
  var token = localStorage.getItem(TOKEN_KEY);
  if (token) return token;
  token = prompt(promptMessage || '请输入 API Key（user_ 前缀），将保存在浏览器本地：', '');
  if (token) localStorage.setItem(TOKEN_KEY, token.trim());
  return token;
}

function resetToken() {
  localStorage.removeItem(TOKEN_KEY);
  refresh();
}

function fmtMs(value) {
  if (value === null || value === undefined) return '—';
  if (value >= 1000) return (value / 1000).toFixed(1) + ' s';
  return Math.round(value) + ' ms';
}

function fmtUptime(ms) {
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600); s %= 3600;
  var m = Math.floor(s / 60); s %= 60;
  if (h > 0) return h + ' 时 ' + m + ' 分 ' + s + ' 秒';
  if (m > 0) return m + ' 分 ' + s + ' 秒';
  return s + ' 秒';
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function card(label, value, cls) {
  return '<div class="card ' + (cls || '') + '"><div class="label">' + escapeHtml(label)
    + '</div><div class="value">' + value + '</div></div>';
}

function render(stats) {
  var t = stats.totals;
  document.getElementById('meta').textContent =
    '启动于 ' + stats.startedAt + ' · 运行 ' + fmtUptime(stats.uptimeMs)
    + ' · 活跃请求 ' + stats.active + ' · 更新于 ' + new Date().toLocaleTimeString();

  document.getElementById('cards').innerHTML = [
    card('总请求', t.requests),
    card('成功', t.ok, 'good'),
    card('上游 429', t.upstream_429, t.upstream_429 > 0 ? 'warn' : ''),
    card('上游 402', t.upstream_402, t.upstream_402 > 0 ? 'bad' : ''),
    card('限流占比', (t.rateLimitRatio * 100).toFixed(1) + '%', t.rateLimitRatio > 0 ? 'warn' : ''),
    card('超时', t.timeout, t.timeout > 0 ? 'warn' : ''),
    card('零输出', t.empty_output),
    card('客户端断连', t.client_disconnect),
    card('上游/代理错误', t.upstream_error + t.proxy_error, (t.upstream_error + t.proxy_error) > 0 ? 'bad' : ''),
  ].join('');

  document.getElementById('latency').innerHTML = [
    card('首 token p50', fmtMs(stats.ttftMs.p50)),
    card('首 token p95', fmtMs(stats.ttftMs.p95)),
    card('首 token 平均', fmtMs(stats.ttftMs.avg)),
    card('总时长 p50', fmtMs(stats.durationMs.p50)),
    card('总时长 p95', fmtMs(stats.durationMs.p95)),
    card('总时长平均', fmtMs(stats.durationMs.avg)),
    card('总时长最大', fmtMs(stats.durationMs.max)),
  ].join('');

  var models = stats.byModel.map(function (m) {
    return '<tr><td>' + escapeHtml(m.model) + '</td><td>' + m.requests + '</td><td>' + m.ok
      + '</td><td>' + m.upstream_429 + '</td><td>' + m.upstream_402 + '</td></tr>';
  }).join('');
  document.getElementById('models').innerHTML = stats.byModel.length
    ? '<table><tr><th>模型</th><th>请求</th><th>成功</th><th>429</th><th>402</th></tr>' + models + '</table>'
    : '<div class="empty">暂无数据</div>';

  var limits = stats.recentRateLimits.map(function (e) {
    return '<tr><td>' + escapeHtml(e.ts) + '</td><td><span class="tag ' + e.outcome + '">'
      + e.outcome + '</span></td><td>' + escapeHtml(e.model) + '</td></tr>';
  }).join('');
  document.getElementById('rateLimits').innerHTML = stats.recentRateLimits.length
    ? '<table><tr><th>时间</th><th>类型</th><th>模型</th></tr>' + limits + '</table>'
    : '<div class="empty">最近没有上游限流/额度错误</div>';

  var rows = stats.recent.slice(0, 50).map(function (r) {
    return '<tr><td>' + escapeHtml(new Date(r.ts).toLocaleTimeString()) + '</td><td>'
      + escapeHtml(r.path) + '</td><td>' + escapeHtml(r.model) + '</td><td>'
      + (r.stream ? '流式' : '非流式') + '</td><td>' + fmtMs(r.ttftMs) + '</td><td>'
      + fmtMs(r.durationMs) + '</td><td><span class="tag ' + r.outcome + '">' + r.outcome
      + '</span></td></tr>';
  }).join('');
  document.getElementById('requests').innerHTML = stats.recent.length
    ? '<table><tr><th>时间</th><th>端点</th><th>模型</th><th>模式</th><th>首 token</th><th>总时长</th><th>结果</th></tr>' + rows + '</table>'
    : '<div class="empty">暂无请求</div>';
}

function refresh() {
  var token = getToken();
  if (!token) { document.getElementById('meta').textContent = '未配置 API Key'; return; }
  fetch('/stats', { headers: { Authorization: 'Bearer ' + token } })
    .then(function (response) {
      if (response.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        return refresh();
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (stats) { if (stats) render(stats); })
    .catch(function (error) {
      document.getElementById('meta').textContent = '加载失败：' + error.message;
    });
}

refresh();
timer = setInterval(refresh, REFRESH_MS);
</script>
</body>
</html>
`;
