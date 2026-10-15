// Exercise the actual Electron window using only a throwaway save and public sample assets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron} = require('../tests/ui/node_modules/playwright-core');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matcher window Zoë '));
  const executablePath = process.env.MATCHER_DESKTOP || require('../desktop/node_modules/electron');
  let electron, base;
  try {
    electron = await _electron.launch({executablePath, args: process.env.MATCHER_DESKTOP ? [] : [path.resolve(__dirname, '../desktop')],
      env: {...process.env, MATCHER_DATA: path.join(tmp, 'saves'), MATCHER_MODELS: path.join(tmp, 'models'),
        XDG_CONFIG_HOME: path.join(tmp, 'config'), APPDATA: path.join(tmp, 'config')}, timeout: 120000});
    const page = await electron.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, {timeout: 120000});
    await page.getByRole('button', {name: 'Choose folder…', exact: true}).waitFor();
    base = new URL(page.url()).origin;
    assert.deepEqual(await page.evaluate(() => ({bridge: typeof window.matcherDesktop.chooseFolder, node: typeof require, process: typeof process})),
      {bridge: 'function', node: 'undefined', process: 'undefined'});
    await electron.evaluate(({dialog}) => {
      dialog.showOpenDialog = async () => ({canceled: true, filePaths: []});
    });
    await page.getByRole('button', {name: 'Choose folder…', exact: true}).click();
    await page.getByRole('button', {name: 'Choose folder…', exact: true}).waitFor({state: 'visible'});
    assert.equal(await page.evaluate(async () => (await fetch('/api/state')).status), 200);
    await page.screenshot({path: process.env.MATCHER_DESKTOP_SHOT || path.join(tmp, 'desktop.png')});
    await electron.close();
    electron = null;
    await assert.rejects(fetch(base + '/'));
    console.log(JSON.stringify({ok: true, native_folder_cancel: true, isolated_renderer: true, clean_exit: true}));
  } finally {
    if (electron) await electron.close();
    fs.rmSync(tmp, {recursive: true, force: true});
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
