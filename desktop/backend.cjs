// Only the main process knows the backend's private link.
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');

function readyURL(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' ||
      !/^[A-Za-z0-9_-]{20,100}$/.test(url.searchParams.get('k') || '') || url.username || url.password || url.hash)
    throw new Error('The local photo engine returned an unexpected address.');
  return url;
}

function startBackend({packaged, resources, root, data, models, log}) {
  const executable = packaged ? path.join(resources, 'backend', process.platform === 'win32' ? 'matcher-backend.exe' : 'matcher-backend') :
    (process.env.MATCHER_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  const args = [...(packaged ? [] : ['-m', 'matcher']), '--desktop', '--no-browser', '--port', '0', '--data', data];
  const child = spawn(executable, args, {cwd: packaged ? path.dirname(executable) : root,
    env: {...process.env, MATCHER_DATA: data, MATCHER_MODELS: models, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1'},
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({code, signal})); child.once('error', () => resolve({code: -1})); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The photo engine took too long to start. See the startup log in Help.')), 120000);
    const lines = readline.createInterface({input: child.stdout});
    lines.on('line', line => {
      if (line.startsWith('MATCHER_READY ')) {
        try { const url = readyURL(JSON.parse(line.slice(14)).url); clearTimeout(timer); resolve(url); }
        catch (e) { clearTimeout(timer); reject(e); }
      } else log(line + '\n');
    });
    child.stderr.on('data', chunk => log(String(chunk)));
    child.once('error', e => { clearTimeout(timer); reject(new Error(`Couldn't start the photo engine: ${e.message}`)); });
    exited.then(({code}) => { clearTimeout(timer); reject(new Error(`The photo engine stopped (code ${code}). See the startup log in Help.`)); });
  });
  return {child, ready, exited, stop() { if (!child.stdin.destroyed) child.stdin.end('stop\n'); return exited; }};
}

module.exports = {readyURL, startBackend};
