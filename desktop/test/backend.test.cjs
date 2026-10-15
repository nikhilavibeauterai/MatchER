const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readyURL} = require('../backend.cjs');

test('only accepts a keyed loopback backend', () => {
  assert.equal(readyURL('http://127.0.0.1:12345/?k=abcdefghijklmnopqrstuvwx').port, '12345');
  for (const url of ['https://example.com/?k=abcdefghijklmnopqrstuvwx', 'http://localhost:12345/?k=abcdefghijklmnopqrstuvwx',
    'http://127.0.0.1:12345/', 'file:///etc/passwd', 'http://127.0.0.1:12345/other?k=abcdefghijklmnopqrstuvwx',
    'http://user@127.0.0.1:12345/?k=abcdefghijklmnopqrstuvwx']) assert.throws(() => readyURL(url));
});
