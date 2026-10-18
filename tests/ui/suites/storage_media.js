// Synthetic mount events: never browse an owner's home, drives or photo library.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const { LINK, OUT } = process.env;
const HOME = '/test-home', CARD = '/run/media/test/0123-4567', PHOTO = `${CARD}/DCIM`;
const problems = [], res = {};
let page;
(async () => {
  const browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => problems.push(e.message));
  let connected = false, windows = false, polls = 0, savesReads = 0, writes = 0, listings = 0, nextGate = null;
  const slots = Array.from({ length: 13 }, (_, i) => ({
    path: i === 12 ? PHOTO : `${HOME}/save-${i}`, name: i === 12 ? '0123-4567' : `Test save ${i + 1}`,
    slug: `test-${i}`, exists: i !== 12 || connected, current: i === 12, fresh: true, mode: 'gallery',
  }));
  const suggestions = () => [{ label: 'Home', path: HOME },
    ...(connected ? [{ label: '0123-4567', path: CARD }] : []), ...(windows ? [{ label: 'E:', path: 'E:\\' }] : [])];
  await page.route('**/api/state', r => r.fulfill({ json: { library: null, recent: [{ path: PHOTO }] } }));
  await page.route('**/api/saves', r => {
    savesReads++;
    return r.fulfill({ json: { saves: slots.map(s => ({ ...s, exists: s.path !== PHOTO || connected })) } });
  });
  await page.route('**/api/storage**', async r => {
    polls++;
    const q = new URL(r.request().url()).searchParams, path = q.get('path');
    const json = { saves: slots.map(s => ({ path: s.path, exists: s.path !== PHOTO || connected })) };
    if (q.get('browse') === '1') {
      json.suggestions = suggestions();
      if (path) json.folder = { path, exists: !path.startsWith(CARD) || connected };
    }
    const gate = nextGate; nextGate = null;
    if (gate) { gate.arrived(); await gate.wait; }
    await r.fulfill({ json });
  });
  await page.route('**/api/browse**', r => {
    listings++;
    const path = new URL(r.request().url()).searchParams.get('path') || HOME;
    const onCard = path.startsWith(CARD), onWindows = path.startsWith('E:');
    if (onCard && !connected) return r.fulfill({ status: 404, json: { error: 'Not a folder.' } });
    const crumbs = onWindows ? [{ label: 'E:\\', path: 'E:\\' }]
      : [{ label: '/', path: '/' }, { label: onCard ? '0123-4567' : 'test-home', path }];
    return r.fulfill({ json: { path, crumbs, photos: null, suggestions: suggestions(),
      dirs: onCard ? [{ name: 'DCIM', path: PHOTO, photos: null }] : [] } });
  });
  await page.route('**/api/library', r => {
    writes++;
    assert.equal(r.request().postDataJSON().path, PHOTO);
    return r.fulfill({ status: 503, json: { error: 'Synthetic open reached' } });
  });
  const check = (key, value) => { res[key] = value; assert.equal(value, true, key); };
  const waitConnected = value => page.waitForFunction(v =>
    document.querySelector('[data-save="12"] .save-open')?.getAttribute('aria-disabled') === String(!v), value);
  const focusRefresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.goto(LINK);
  await page.waitForSelector('.save-grid');
  await waitConnected(false);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('.save-card')].flatMap(el => el.getAnimations()).map(a => a.finished.catch(() => {})));
  });
  check('disconnectedSaveVisibleOnStartup', await page.locator('[data-save="12"] .save-name').textContent() === '0123-4567');
  await page.locator('[data-save="12"] .save-open').focus();
  const before = await page.evaluate(() => {
    const card = document.querySelector('[data-save="12"]'); card.hotplugMark = true;
    return { scroll: document.querySelector('.saves .screen-body').scrollTop, count: document.querySelectorAll('[data-save]').length };
  });
  connected = true;
  await waitConnected(true);
  res.insertion = await page.evaluate(b => {
    const card = document.querySelector('[data-save="12"]');
    return { same: card.hotplugMark, connected: !card.classList.contains('missing'), focused: document.activeElement === card.querySelector('.save-open'),
      scroll: document.querySelector('.saves .screen-body').scrollTop, before: b.scroll, count: document.querySelectorAll('[data-save]').length, expected: b.count };
  }, before);
  check('insertionUpdatesWithoutRebuild', res.insertion.same && res.insertion.connected && res.insertion.focused
    && res.insertion.scroll === res.insertion.before && res.insertion.count === res.insertion.expected);
  check('continueReturns', await page.locator('#continue').count() === 1);
  await page.screenshot({ path: `${OUT}/storage-connected.png` });
  connected = false;
  await waitConnected(false);
  check('unplugUpdatesWithoutReload', await page.locator('[data-save="12"]').evaluate(el => el.classList.contains('missing'))
    && await page.locator('#continue').count() === 0 && writes === 0);
  await page.screenshot({ path: `${OUT}/storage-disconnected.png` });
  connected = true;
  await page.locator('[data-save="12"] .save-open').evaluate(el => { el.click(); el.click(); });
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Synthetic open reached');
  check('clickRechecksAndOpensOnlyOnce', writes === 1);
  connected = false;
  const polled = polls;
  await page.locator('[data-save="12"] .save-open').evaluate(el => el.click());
  await waitConnected(false);
  check('unplugBeforeClickCannotOpen', polls > polled && writes === 1);
  connected = true;
  await focusRefresh(); await waitConnected(true);
  check('windowFocusRefreshes', true);
  check('pollingNeverReloadsSaveDatabases', savesReads === 1);

  // A late connectivity reply belongs to the picker that requested it.
  let release, arrived;
  const ready = new Promise(r => { arrived = r; });
  nextGate = { arrived, wait: new Promise(r => { release = r; }) };
  await focusRefresh(); await ready;
  await page.evaluate(() => { location.hash = '#onboard?new=1'; });
  await page.waitForSelector('#path');
  const stoppedAt = polls;
  release(); await page.waitForTimeout(1700);
  check('oldViewStopsPollingAndIgnoresReply', polls === stoppedAt && await page.locator('#path').count() === 1);

  connected = false;
  await page.click('#toggle-browse'); await page.waitForSelector('#browser .crumbs');
  check('newSaveBrowserStartsWithoutMedia', await page.locator('#browser .suggest').getByText('0123-4567', { exact: true }).count() === 0);
  const originalListings = listings;
  connected = true;
  await page.waitForSelector(`#browser .suggest [data-go="${CARD}"]`);
  check('newMediaShortcutAppearsWithoutListingHomeAgain', listings === originalListings);
  await page.click(`#browser .suggest [data-go="${CARD}"]`);
  await page.waitForSelector(`#browser .dirs [data-go="${PHOTO}"]`);
  connected = false;
  await page.waitForFunction(() => document.querySelector('#use-this').disabled);
  check('unpluggedFolderCannotBeChosen', await page.locator('.browser-missing').isVisible() && !await page.locator('#browser .dirs').isVisible());
  const disconnectedListings = listings;
  connected = true;
  await page.waitForFunction(() => !document.querySelector('#use-this').disabled && document.querySelector('.browser-missing').hidden);
  check('reconnectedFolderListsOnce', listings === disconnectedListings + 1);
  windows = true;
  await focusRefresh();
  await page.locator('#browser .suggest').getByText('E:', { exact: true }).waitFor();
  await page.locator('#browser .suggest').getByText('E:', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#browser .crumbs button').dataset.go === 'E:\\');
  check('windowsDriveKeepsItsNativeRoot', await page.locator('#browser .crumbs button').textContent() === 'E:\\');
  await page.screenshot({ path: `${OUT}/storage-browser.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#use-this').scrollIntoViewIfNeeded();
  check('phoneFolderPickerFits', await page.evaluate(() => {
    const b = document.querySelector('#use-this').getBoundingClientRect();
    return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight;
  }));
  await page.screenshot({ path: `${OUT}/storage-browser-phone.png` });
  await page.click('#toggle-browse');
  const closedAt = polls;
  await page.waitForTimeout(1700);
  check('closedBrowserDoesNotPoll', polls === closedAt);
  check('noAutomaticLibraryOpen', writes === 1);
  check('noHorizontalOverflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(problems, []);
  console.log(JSON.stringify({ ...res, polls, listings, problems }));
  await browser.close();
})().catch(async e => {
  console.error('FAILED:', e.stack, JSON.stringify({ ...res, problems }));
  if (page) await page.screenshot({ path: `${OUT}/storage-fail.png` }).catch(() => {});
  process.exit(1);
});
