---
name: run-personal-portfolio
description: Build, run, screenshot, and audit the Mark Muhwezi portfolio site. Use when asked to start the portfolio, serve it locally, take a screenshot, check mobile rendering, verify icons or links, or interact with the running page.
---

A static single-page portfolio (`public/index.html` + `styles.css` + `script.js`)
deployed to Firebase Hosting. **No build step, no package.json at the repo root.**

Drive it with the REPL at `.claude/skills/run-personal-portfolio/driver.mjs` — it
serves `public/` on its own internal HTTP server *and* drives headless Chromium
against it, so there is no separate dev-server step. `chromium-cli` is not
installed on this machine; this driver is the Playwright fallback.

All paths below are relative to the repo root (`C:\projects\Personal-Portfolio`).

## Prerequisites

Node (verified on v24.13.0) and a one-time install inside the skill directory.
Playwright is scoped here so it never touches the deployed `public/` tree:

```bash
cd .claude/skills/run-personal-portfolio
npm install
npx playwright install chromium
```

The `npx playwright install chromium` step is **required even if
`~/AppData/Local/ms-playwright` already has a chromium build** — see Gotchas.

## Build

None. `public/` is served verbatim; edits to `index.html` / `styles.css` /
`script.js` are live on the next `nav` or `launch`.

## Run (agent path)

Pipe a script to stdin. Commands run in order (the driver serialises them):

```bash
printf 'launch\nss 01-desktop\nviewport mobile\nss 02-mobile\nquit\n' \
  | node .claude/skills/run-personal-portfolio/driver.mjs
```

After editing markup or CSS, run the full audit — this is the one that matters:

```bash
printf 'launch\naudit\nquit\n' \
  | node .claude/skills/run-personal-portfolio/driver.mjs
```

Verified output on a clean tree: `ICONS: OK`, `ANCHORS: OK`, `ASSETS: OK`,
`OVERFLOW: OK` at desktop/mobile/tiny, `no console errors`.

Screenshots land in `.claude/skills/run-personal-portfolio/shots/`
(override with `SCREENSHOT_DIR`). Server port defaults to 8791 (`PORT` to change).

**There is no tmux on this host** (Windows + Git Bash), so the usual
send-keys/capture-pane loop is not available. Re-invoke in batches instead —
a full `launch` (server + chromium + first paint) measured **~7s**, so a fresh
batch per iteration is cheap. Put the whole flow in one `printf`:

```bash
printf 'viewport mobile\nlaunch\nclick #hamburger\nsleep 700\nss-view menu-open\nquit\n' \
  | node .claude/skills/run-personal-portfolio/driver.mjs
```

Note `viewport` before `launch` sets the size the browser starts at, avoiding a
context teardown. After `launch` it recreates the context and reloads.

### Commands

| command | what it does |
|---|---|
| `launch` | start static server + chromium, load `/` |
| `nav <path>` | navigate (`/`, `/404.html`, or a full URL) |
| `viewport <name>` | `desktop` 1440 / `laptop` 1280 / `tablet` 768 / `mobile` 360 / `tiny` 320. Recreates the context and reloads. |
| `ss [name]` | full-page screenshot (forces scroll-animations visible first) |
| `ss-view [name]` | viewport-only screenshot |
| `sleep <ms>` | wait — needed after `click` for CSS transitions |
| `click <css>` | DOM `.click()` on a selector |
| `text [css]` | print innerText |
| `eval <js>` | evaluate in page, print JSON |
| `icons` | every `<use href="#id">` resolves to a `<symbol>`, none zero-sized |
| `anchors` | every `href="#x"` has a matching element id |
| `overflow` | horizontal-scroll detection + offending elements |
| `media` | which media queries match (incl. `hover:none`, `pointer:coarse`) |
| `assets` | broken images / failed local requests |
| `links` | HEAD-check every outbound `http(s)` link |
| `console [errors]` | console + pageerror + requestfailed log |
| `audit` | icons + anchors + assets + overflow at 3 widths + console errors |
| `quit` | close browser and server |

## Run (human path)

```bash
python -m http.server 8765 --directory public
```

Then open `http://localhost:8765`. Stop with Ctrl-C.

## Deploy

Firebase CLI is installed (v15.26.0) and `.firebaserc` targets project
`pearl-explore-49f3f`. The deploy command is `firebase deploy --only hosting`
— **not run in this session**, so treat it as unverified. It publishes
publicly; confirm with the user first.

## Gotchas

- **Playwright viewport must be nested.** `newContext({ width, height })` is
  silently ignored — you measure everything at the 1280×720 default and get
  false `OVERFLOW: OK` passes. It must be
  `newContext({ viewport: { width, height }, deviceScaleFactor, isMobile, hasTouch })`.
  `ctxOpts()` in the driver builds this; use it, don't hand-roll.
- **`hasTouch` is what makes `@media (hover: none)` match.** `styles.css` has a
  `hover: none` block that disables `translateX` hovers on touch. Without
  `hasTouch: true` on the context that block never applies and mobile overflow
  results are wrong. Verify with `media`.
- **`readline` does not await async `line` handlers.** Piping
  `launch\nicons\nquit` fires all three at once and `icons` runs before there is
  a browser (`ERROR: launch first`). The driver serialises through a promise
  queue — keep that if you edit it.
- **Piped stdin closes readline while the queue drains** → `ERR_USE_AFTER_CLOSE`
  from `rl.prompt()`. The driver guards with a `closed` flag.
- **Icons fail silently.** All icons are inline `<use href="#id">` against a
  hidden `<symbol>` sprite at the top of `index.html`. A typo'd id renders
  nothing, with no console error and no failed request. Run `icons` after
  touching markup — nothing else catches it.
- **Scroll animations blank out screenshots.** `script.js` sets
  `opacity: 0` on `.project-card`, `.skill-category`, `.timeline-item`,
  `.research-card`, `.about-text`, `.section-title` until an IntersectionObserver
  fires. `ss` forces them visible first; `ss-view` does not.
- **Screenshot immediately after `click` catches mid-transition.** Menu slide is
  0.4s. Use `click #hamburger` then `sleep 700` then `ss-view`.
- **LinkedIn returns HTTP 999** to non-browser clients. `links` reports it as
  `BAD 999`; it is not a broken link. Everything else should be 2xx/3xx.
- **`position: fixed` escapes `body { overflow-x: hidden }`.** The off-canvas
  nav at `right: -100%` caused a 10px sideways scroll on 360px screens until
  `overflow-x: hidden` was added to `html` too. If you reintroduce sideways
  scroll, check fixed-position elements first — `overflow` names the offender.
- **The driver's server mirrors Firebase Hosting's 404 behaviour** (unknown path
  → `404.html` with status 404), so `nav /nope` exercises the real 404 page.

## Troubleshooting

- **`browserType.launch: Executable doesn't exist at …chromium_headless_shell-1234`**:
  a cached chromium from a different Playwright version (e.g. `-1223`) does not
  satisfy `playwright-core` 1.62. Run `npx playwright install chromium` inside
  the skill dir. ~115 MB download.
- **`ERROR: launch first` on every command**: either `launch` itself failed
  (scroll up for the real error) or the promise queue was removed from the
  `line` handler.
- **`Error [ERR_USE_AFTER_CLOSE]: readline was closed`**: the `closed` guard
  around `rl.prompt()` was removed.
- **`listen EADDRINUSE 127.0.0.1:8791`**: a previous driver did not exit
  cleanly. `PORT=8792 node .claude/skills/run-personal-portfolio/driver.mjs`,
  or kill the listener.
- **`OVERFLOW: FAIL` listing `gradient-orb`**: the hero orbs are decorative and
  intentionally sit outside the viewport; they are reported as offenders but do
  not themselves cause `horizontalScroll: true`. Only act if
  `horizontalScroll` is `true`.
