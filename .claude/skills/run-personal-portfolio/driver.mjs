// REPL driver for the Personal-Portfolio static site.
//
// Self-contained: serves public/ over a local HTTP server AND drives a
// headless Chromium against it. No separate dev-server step.
//
// Designed for agents: wrap in tmux and send-keys, or pipe a script to stdin.
//   echo -e "launch\nss home\nquit" | node driver.mjs
//
// chromium-cli is not available on this machine, so this is the fallback
// harness described in the run-skill-generator playwright example.

import { chromium } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

const SKILL_DIR = import.meta.dirname;
const APP_DIR = path.resolve(SKILL_DIR, '../../..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(SKILL_DIR, 'shots');
const PORT = Number(process.env.PORT || 8791);

fs.mkdirSync(SHOT_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

// Low-end Android over mobile data. The portfolio claims this skill in its
// own application letters, so it is the profile that matters most here.
//
// NOTE: Playwright wants `viewport: {width, height}` NESTED. Passing width and
// height at the top level of newContext() is silently ignored and you measure
// everything at the 1280x720 default. ctxOpts() builds the correct shape.
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, dpr: 1, mobile: false },
  laptop: { width: 1280, height: 800, dpr: 1, mobile: false },
  tablet: { width: 768, height: 1024, dpr: 2, mobile: true },
  mobile: { width: 360, height: 640, dpr: 2, mobile: true },
  tiny: { width: 320, height: 568, dpr: 2, mobile: true },
};

function ctxOpts(name) {
  const v = VIEWPORTS[name];
  return {
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.dpr,
    isMobile: v.mobile,
    hasTouch: v.mobile, // drives @media (hover: none) / (pointer: coarse)
  };
}

let server = null;
let browser = null;
let context = null;
let page = null;
let consoleLog = [];
let currentViewport = 'desktop';

function log(...a) { console.log(...a); }

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      let file = path.join(PUBLIC_DIR, rel);
      // Keep traversal inside public/
      if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        // Mirror Firebase Hosting: unknown paths get 404.html
        const notFound = path.join(PUBLIC_DIR, '404.html');
        if (fs.existsSync(notFound)) {
          res.writeHead(404, { 'Content-Type': MIME['.html'] });
          res.end(fs.readFileSync(notFound));
        } else {
          res.writeHead(404).end('not found');
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve());
  });
}

const COMMANDS = {
  async launch() {
    if (browser) return log('already launched');
    if (!fs.existsSync(PUBLIC_DIR)) return log('ERROR: no public/ at', PUBLIC_DIR);
    await startServer();
    log('serving', PUBLIC_DIR, '→ http://127.0.0.1:' + PORT);
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    context = await browser.newContext(ctxOpts(currentViewport));
    page = await context.newPage();
    consoleLog = [];
    page.on('console', m => consoleLog.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', e => consoleLog.push({ type: 'pageerror', text: e.message }));
    page.on('requestfailed', r => consoleLog.push({ type: 'requestfailed', text: `${r.url()} — ${r.failure()?.errorText}` }));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    log('launched. viewport:', currentViewport, JSON.stringify(VIEWPORTS[currentViewport]));
    log('title:', await page.title());
  },

  async nav(p) {
    if (!page) return log('ERROR: launch first');
    const url = (p || '/').startsWith('http') ? p : `http://127.0.0.1:${PORT}${p.startsWith('/') ? p : '/' + p}`;
    const resp = await page.goto(url, { waitUntil: 'load' });
    log('nav', url, '→', resp?.status());
  },

  // Viewport switch. Recreates the context, so navigate again after.
  async viewport(name) {
    const vp = VIEWPORTS[name];
    if (!vp) return log('unknown viewport. try:', Object.keys(VIEWPORTS).join(', '));
    if (!browser) { currentViewport = name; return log('viewport set to', name, '(applies on launch)'); }
    const url = page ? page.url() : `http://127.0.0.1:${PORT}/`;
    await context.close();
    currentViewport = name;
    context = await browser.newContext(ctxOpts(name));
    page = await context.newPage();
    consoleLog = [];
    page.on('console', m => consoleLog.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', e => consoleLog.push({ type: 'pageerror', text: e.message }));
    page.on('requestfailed', r => consoleLog.push({ type: 'requestfailed', text: `${r.url()} — ${r.failure()?.errorText}` }));
    await page.goto(url, { waitUntil: 'load' });
    log('viewport →', name, JSON.stringify(vp));
  },

  async ss(name) {
    if (!page) return log('ERROR: launch first');
    // Scroll-triggered IntersectionObserver animations start elements at
    // opacity:0. Force them visible so screenshots are not half-blank.
    await page.evaluate(() => {
      document.querySelectorAll('.project-card, .skill-category, .timeline-item, .research-card, .about-text, .section-title')
        .forEach(el => { el.style.opacity = '1'; el.style.transform = 'none'; });
    });
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f, fullPage: true });
    log('screenshot:', f);
  },

  async 'ss-view'(name) {
    if (!page) return log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `view-${Date.now()}`) + '.png');
    await page.screenshot({ path: f, fullPage: false });
    log('screenshot (viewport only):', f);
  },

  // Every icon on this site is an inline <use href="#id"> against a hidden
  // <symbol> sprite in index.html. A typo renders nothing — silently, with
  // no console error. This catches that.
  async icons() {
    if (!page) return log('ERROR: launch first');
    const r = await page.evaluate(() => {
      const syms = [...document.querySelectorAll('symbol[id]')].map(s => s.id);
      const uses = [...document.querySelectorAll('use')].map(u => (u.getAttribute('href') || '').replace(/^#/, ''));
      const missing = [...new Set(uses)].filter(u => !syms.includes(u));
      const unused = syms.filter(s => !uses.includes(s));
      // An icon that resolves but renders at zero size is also broken.
      const zero = [...document.querySelectorAll('svg.icon')]
        .filter(s => { const b = s.getBoundingClientRect(); return b.width === 0 || b.height === 0; })
        .map(s => s.querySelector('use')?.getAttribute('href') || '?');
      return { symbols: syms.length, refs: uses.length, missing, unused, zeroSized: [...new Set(zero)] };
    });
    log(JSON.stringify(r, null, 2));
    log(r.missing.length || r.zeroSized.length ? 'ICONS: FAIL' : 'ICONS: OK');
  },

  // Nav links are in-page anchors. A renamed section id breaks them, and
  // script.js throws on a null querySelector when one is clicked.
  async anchors() {
    if (!page) return log('ERROR: launch first');
    const r = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
      const hrefs = [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href').slice(1)).filter(Boolean);
      const broken = [...new Set(hrefs)].filter(h => !ids.includes(h));
      const sections = [...document.querySelectorAll('section[id]')].map(s => s.id);
      return { sections, anchorTargets: [...new Set(hrefs)], broken };
    });
    log(JSON.stringify(r, null, 2));
    log(r.broken.length ? 'ANCHORS: FAIL' : 'ANCHORS: OK');
  },

  // Horizontal overflow is the classic mobile failure here: several hover
  // rules use translateX(10px) and long company strings do not wrap.
  async overflow() {
    if (!page) return log('ERROR: launch first');
    const r = await page.evaluate(() => {
      const docW = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        if (b.right > docW + 1 || b.left < -1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 60),
            left: Math.round(b.left), right: Math.round(b.right),
          });
        }
      }
      return {
        docWidth: docW,
        scrollWidth: document.documentElement.scrollWidth,
        horizontalScroll: document.documentElement.scrollWidth > docW + 1,
        offenders: offenders.slice(0, 15),
      };
    });
    log(JSON.stringify(r, null, 2));
    log(r.horizontalScroll ? 'OVERFLOW: FAIL — page scrolls sideways' : 'OVERFLOW: OK');
  },

  // Confirms the responsive/touch CSS actually engages. styles.css has a
  // `@media (hover: none)` block that kills translateX hovers on touch; if
  // hasTouch is not set on the context that block never applies and you get
  // a false pass from `overflow`.
  async media() {
    if (!page) return log('ERROR: launch first');
    const r = await page.evaluate(() => {
      const q = s => matchMedia(s).matches;
      return {
        innerWidth: window.innerWidth,
        dpr: window.devicePixelRatio,
        'max-width:992px': q('(max-width: 992px)'),
        'max-width:768px': q('(max-width: 768px)'),
        'max-width:480px': q('(max-width: 480px)'),
        'hover:none': q('(hover: none)'),
        'pointer:coarse': q('(pointer: coarse)'),
        'prefers-reduced-motion': q('(prefers-reduced-motion: reduce)'),
      };
    });
    log(JSON.stringify(r, null, 2));
  },

  // Outbound project links rot. blossomtech.site went NXDOMAIN while still
  // printed on the CV and linked from GitHub. Check them on every pass.
  async links() {
    if (!page) return log('ERROR: launch first');
    const urls = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll('a[href^="http"]')].map(a => a.href))]);
    log('checking', urls.length, 'external links...');
    let bad = 0;
    for (const u of urls) {
      let status;
      try {
        const ctl = AbortSignal.timeout(15000);
        let r = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: ctl });
        if (r.status === 405 || r.status === 501) r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        status = String(r.status);
      } catch (e) {
        status = 'ERR ' + (e.cause?.code || e.name || e.message);
      }
      const ok = /^[23]/.test(status);
      if (!ok) bad++;
      log(`  ${ok ? 'ok  ' : 'BAD '} ${status.padEnd(18)} ${u}`);
    }
    log(bad ? `LINKS: FAIL — ${bad} bad` : 'LINKS: OK');
  },

  // Local asset requests (css/js/img/pdf) that 404 or fail outright.
  async assets() {
    if (!page) return log('ERROR: launch first');
    const failed = consoleLog.filter(c => c.type === 'requestfailed');
    const urls = await page.evaluate(() => ({
      imgs: [...document.querySelectorAll('img')].map(i => ({ src: i.getAttribute('src'), broken: !i.complete || i.naturalWidth === 0 })),
      css: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.getAttribute('href')),
    }));
    log(JSON.stringify({ ...urls, requestFailures: failed }, null, 2));
    const broken = urls.imgs.filter(i => i.broken);
    log(broken.length || failed.length ? 'ASSETS: FAIL' : 'ASSETS: OK');
  },

  async console_(_) { return COMMANDS.console(_); },
  async console(filter) {
    const items = filter === 'errors'
      ? consoleLog.filter(c => c.type === 'error' || c.type === 'pageerror' || c.type === 'requestfailed')
      : consoleLog;
    if (!items.length) return log(filter === 'errors' ? 'no console errors' : 'console empty');
    for (const c of items) log(`  [${c.type}] ${c.text}`);
  },

  // CSS transitions here run 0.3-0.5s. Screenshotting straight after a click
  // catches the menu mid-slide or not moved at all. `sleep 700` after a click.
  async sleep(ms) { await new Promise(r => setTimeout(r, Number(ms) || 500)); },

  async text(sel) {
    if (!page) return log('ERROR: launch first');
    log(await page.evaluate(s => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null));
  },

  async click(sel) {
    if (!page) return log('ERROR: launch first');
    const r = await page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK';
    }, sel);
    log('click', sel, '→', r);
  },

  async eval(expr) {
    if (!page) return log('ERROR: launch first');
    try { log(JSON.stringify(await page.evaluate(expr), null, 2)); }
    catch (e) { log('ERROR:', e.message.split('\n')[0]); }
  },

  // Everything at once. This is the one to run after editing index.html.
  async audit() {
    if (!page) return log('ERROR: launch first');
    for (const name of ['icons', 'anchors', 'assets']) { log(`--- ${name} ---`); await COMMANDS[name](); }
    for (const vp of ['desktop', 'mobile', 'tiny']) {
      log(`--- overflow @ ${vp} ---`);
      await COMMANDS.viewport(vp);
      await COMMANDS.overflow();
    }
    log('--- console errors ---');
    await COMMANDS.console('errors');
  },

  async quit() {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise(r => server.close(r));
    browser = context = page = server = null;
  },

  help() {
    log('commands: ' + Object.keys(COMMANDS).filter(k => k !== 'console_').join(', '));
    log('viewports: ' + Object.keys(VIEWPORTS).join(', '));
    log('screenshots → ' + SHOT_DIR);
  },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' });

// readline does NOT await an async 'line' handler. When a script is piped in
// (printf "launch\nss\nquit" | node driver.mjs) every line fires at once and
// commands race — `ss` runs before `launch` has a browser. Serialise them.
//
// Piped stdin also emits 'close' while the queue is still draining, so
// prompt() must no-op after close or it throws ERR_USE_AFTER_CLOSE.
let queue = Promise.resolve();
let closed = false;
const prompt = () => { if (!closed) rl.prompt(); };

rl.on('line', line => {
  queue = queue.then(async () => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return prompt();
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const fn = COMMANDS[cmd];
    if (!fn) { log('unknown:', cmd, '— try: help'); return prompt(); }
    try { await fn.call(COMMANDS, rest.join(' ')); }
    catch (e) { log('ERROR:', e.message.split('\n')[0]); }
    if (cmd === 'quit') { closed = true; rl.close(); return; }
    prompt();
  });
});

rl.on('close', () => {
  closed = true;
  queue = queue.then(async () => { await COMMANDS.quit(); process.exit(0); });
});

log('portfolio driver — "help" for commands, "launch" to start');
rl.prompt();
