import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import providersModule from '../scripts/personal-providers.cjs';

function request(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('in-process sirens distinguish a successful empty reading from a failed source and recover', async t => {
  let result = [];
  const providers = providersModule.createPersonalProviders({ fetch: async () => {
    if (result instanceof Error) throw result;
    return Response.json(result);
  } });
  const server = http.createServer((req, res) => { void providers.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await providers.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  assert.equal((await request(server, '/oref/alerts')).status, 503);
  await providers.pollOref();
  let response = await request(server, '/oref/alerts');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.alerts, []);
  result = [{ notificationId: 'fixture-1', threat: 'rocket', cities: ['Test city'] }];
  await providers.pollOref();
  response = await request(server, '/oref/alerts');
  assert.equal(response.body.alerts[0].id, 'fixture-1');
  assert.equal((await request(server, '/oref/history')).body.history.length, 1);
  result = new Error('source unavailable');
  await providers.pollOref();
  response = await request(server, '/oref/alerts');
  assert.equal(response.status, 503);
  assert.match(response.body.error, /unavailable/);
  result = [];
  await providers.pollOref();
  response = await request(server, '/oref/alerts');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.alerts, []);
  assert.equal((await request(server, '/oref/history')).body.history.length, 1);
});
