import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const https = require('node:https');
const { postJsonWithPinnedAddress } = require('../scripts/lib/notification-webhook-ssrf.cjs');

const realRequest = https.request;

function answerWith(statusCode) {
  https.request = (_options, onResponse) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => true;
    req.destroy = (error) => { if (error) req.emit('error', error); };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.statusMessage = 'Odd';
      res.headers = { 'content-type': 'text/plain' };
      onResponse(res);
      res.emit('data', Buffer.from('ok'));
      res.emit('end');
    };
    return req;
  };
}

afterEach(() => { https.request = realRequest; });

const url = new URL('https://hooks.example.com/wm');

describe('pinned webhook POST response status', () => {
  it('rejects a status outside 200-599 instead of throwing from the end listener', async () => {
    answerWith(999);
    await assert.rejects(
      postJsonWithPinnedAddress(url, '{}', {}, ['93.184.216.34']),
      (error) => error.code === 'WEBHOOK_INVALID_STATUS' && error.statusCode === 999,
    );
  });

  it('still resolves an ordinary error status', async () => {
    answerWith(503);
    const response = await postJsonWithPinnedAddress(url, '{}', {}, ['93.184.216.34']);
    assert.equal(response.status, 503);
  });
});
