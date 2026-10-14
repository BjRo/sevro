/** Real wildcard HTTP listener and loopback client, as used by Supertest. */
export const localHttpProbe = String.raw`
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const server = http.createServer((request, response) => response.end('local-http-ok'));
server.on('error', error => {
  if (process.argv[2] === 'denied') {
    assert.ok(['EPERM', 'EACCES'].includes(error.code), error.message);
    console.log('bind-denied');
  } else {
    console.log('bind-error:' + error.code);
    process.exitCode = 1;
  }
});
server.listen(0, async () => {
  try {
    assert.notEqual(process.argv[2], 'denied', 'default policy allowed binding');
    const body = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:' + server.address().port, response => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.equal(body, 'local-http-ok');
    await new Promise((resolve, reject) => {
      const socket = net.connect({host: '192.0.2.1', port: 9});
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('egress was not refused')); });
      socket.on('connect', () => { socket.destroy(); reject(new Error('outbound access allowed')); });
      socket.on('error', error => {
        assert.ok(['EPERM', 'EACCES', 'ENETUNREACH'].includes(error.code), error.message);
        resolve();
      });
    });
    console.log(body);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
`;
