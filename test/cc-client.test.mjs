import test from 'node:test';
import assert from 'node:assert/strict';
import { filterProxyHeaders, isCommandCodeNativePath } from '../src/cc-client.mjs';

test('原生代理只接受 Command Code 官方 API namespace', () => {
  for (const path of [
    '/alpha/generate',
    '/beta/taste/packages',
    '/internal/profile',
    '/provider/v1/models',
  ]) {
    assert.equal(isCommandCodeNativePath(path), true, path);
  }

  for (const path of ['/alphabets/test', '/v1/chat/completions', '/oauth/token', '//example.com/alpha']) {
    assert.equal(isCommandCodeNativePath(path), false, path);
  }
});

test('HTTP 透传移除逐跳头和 Connection 声明的扩展头', () => {
  const headers = filterProxyHeaders({
    host: 'proxy.invalid',
    connection: 'keep-alive, x-private-hop',
    cookie: 'session=native-client',
    'keep-alive': 'timeout=5',
    'x-private-hop': 'remove-me',
    'proxy-connection': 'keep-alive',
    'set-cookie': ['session=upstream'],
    authorization: 'Bearer user_example',
    'x-command-code-version': '1.31.0',
  });

  assert.deepEqual(headers, {
    cookie: 'session=native-client',
    'set-cookie': ['session=upstream'],
    authorization: 'Bearer user_example',
    'x-command-code-version': '1.31.0',
  });
});
