const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {createRequire} = require('node:module');
const {promisify} = require('node:util');

test('the builder downloader still sends requests through its proxy helper', async () => {
  const requests = [];
  const proxy = http.createServer((req, res) => {
    requests.push(req.url);
    res.end('download through proxy');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const downloader = createRequire(require.resolve('app-builder-lib')).resolve('@electron/get');
    // Use a child: the downloader patches HTTP globally, and its override must not change other tests.
    const script = `require(${JSON.stringify(downloader)}).initializeProxy();
      require('node:http').get('http://matcher-download.invalid/check', response => {
        response.setEncoding('utf8');response.on('data', chunk => process.stdout.write(chunk));
      }).on('error', error => {console.error(error);process.exitCode=1;});`;
    const {stdout} = await promisify(execFile)(process.execPath, ['-e', script], {
      timeout: 10000,
      env: {...process.env, GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, GLOBAL_AGENT_NO_PROXY: ''},
    });
    assert.equal(stdout, 'download through proxy');
    assert.deepEqual(requests, ['http://matcher-download.invalid/check']);
  } finally {
    await new Promise(resolve => proxy.close(resolve));
  }
});
