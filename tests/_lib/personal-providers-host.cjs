// Test-only listener for exercising the in-process adapters with controlled upstreams.
const http = require('node:http');
const { createPersonalProviders } = require('../../scripts/personal-providers.cjs');
const providers = createPersonalProviders();
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/metrics') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/health' ? providers.health() : providers.diagnostics()));
    return;
  }
  void providers.handle(req, res);
});
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  // Existing fault-injection harnesses recognize this readiness line.
  console.log(`WebSocket relay on port ${server.address().port}`);
  console.log('Test mode enabled');
});
const close = async () => {
  await providers.close();
  server.closeAllConnections();
  server.close();
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
