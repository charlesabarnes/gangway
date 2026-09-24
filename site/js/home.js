function renderBrandIcons() {
  for (const tile of document.querySelectorAll("[data-icon]")) {
    const icon = window.GW_ICONS?.[tile.dataset.icon];
    if (!icon) continue;
    const color = icon.ink || icon.hex;
    if (color) tile.style.background = `color-mix(in oklch, ${color} 16%, transparent)`;
    tile.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="${color || "currentColor"}" d="${icon.d}"/></svg>`;
  }
}

// Lucide glyphs the demo draws (the dashboard's preview icons use the same set).
const GLYPHS = {
  presentation:
    '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
  "app-window":
    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  "layout-dashboard":
    '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  "chart-line": '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  utensils:
    '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  wallet:
    '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
};
const glyph = (name) =>
  `<svg viewBox="0 0 24 24" class="line-icon" aria-hidden="true">${GLYPHS[name]}</svg>`;

// The two previews the demo makes. An upload from the browser has no title, so the dashboard
// lists it by its address with the grey fallback icon; the agent names it and picks an icon.
const MADE = {
  browser: {
    name: "growth-dashboard",
    glyph: "app-window",
    color: "#687283",
    host: "growth-dashboard.acme.dev",
    files: 3,
    bytes: 61240,
    site: "dash",
    siteTitle: "Growth dashboard",
    siteGlyph: "chart-line",
  },
  agent: {
    name: "Q3 board review",
    glyph: "presentation",
    color: "#1d3a66",
    host: "q3-board-review.acme.dev",
    files: 5,
    bytes: 38912,
    site: "deck",
    siteTitle: "Q3 board review",
    siteGlyph: "presentation",
  },
};
const CHAPTERS = ["browser", "agent"];

// Plays the hero in two chapters: deploying from the dashboard's New preview page, then from an
// agent over MCP. The strings are what gangway really prints (deploy results, system log lines).
// Hovering the stage, the Pause button, or scrolling it off screen pauses it; the chapter buttons
// jump; with reduced motion each chapter shows its last frame.
function startDemo(demo) {
  const $ = (sel) => demo.querySelector(sel);
  const el = {
    stage: $(".demo-stage"),
    view: $("[data-view]"),
    term: $("[data-term]"),
    tabApp: $('[data-tab="app"]'),
    tabSite: $('[data-tab="site"]'),
    tabTitle: $("[data-tab-title]"),
    siteGlyph: $("[data-site-glyph]"),
    siteTitle: $("[data-site-title]"),
    url: $("[data-url]"),
    app: $('[data-page="app"]'),
    site: $('[data-page="site"]'),
    screens: {
      list: $('[data-screen="list"]'),
      new: $('[data-screen="new"]'),
      detail: $('[data-screen="detail"]'),
    },
    rows: { browser: $('[data-row="browser"]'), agent: $('[data-row="agent"]') },
    count: $("[data-count]"),
    newButton: $("[data-new-button]"),
    drop: $("[data-drop]"),
    dropEmpty: $("[data-drop-empty]"),
    dropFull: $("[data-drop-full]"),
    deployButton: $("[data-deploy-button]"),
    progress: $("[data-progress]"),
    progressBar: $("[data-progress-bar]"),
    progressText: $("[data-progress-text]"),
    dIcon: $("[data-d-icon]"),
    dTitle: $("[data-d-title]"),
    dState: $("[data-d-state]"),
    dUrl: $("[data-d-url]"),
    log: $("[data-log]"),
    decks: { deck: $('[data-site="deck"]'), dash: $('[data-site="dash"]') },
    slideTitle: $("[data-slide-title]"),
    slideFig: $("[data-slide-fig]"),
    slideSub: $("[data-slide-sub]"),
    cursor: $("[data-cursor]"),
    drag: $("[data-drag]"),
    scene: $("[data-scene]"),
    go: [...demo.querySelectorAll("[data-go]")],
    pause: $("[data-pause]"),
    replay: $("[data-replay]"),
  };
  for (const g of demo.querySelectorAll("[data-glyph]")) g.innerHTML = glyph(g.dataset.glyph);

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const why = new Set(); // reasons it is paused: "button", "hover", "offscreen"
  let run = 0;
  let chapter = "browser";

  const STOP = Symbol("stop");
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  // Waits ms of unpaused time, in slices so a pause lands promptly; a replay or a chapter jump
  // abandons the old run at its next wait.
  async function wait(ms, mine) {
    if (mine !== run) throw STOP;
    if (still) return;
    for (let left = ms; left > 0;) {
      const from = performance.now();
      await sleep(Math.min(left, 150));
      if (mine !== run) throw STOP;
      if (why.size === 0) left -= performance.now() - from;
    }
  }

  // Terminal
  function line(kind, html) {
    const div = document.createElement("div");
    div.className = `term-line term-line--${kind}`;
    div.innerHTML = `<span>${html}</span>`;
    el.term.append(div);
    while (el.term.children.length > 9) el.term.firstElementChild.remove();
    return div.lastElementChild;
  }
  async function type(text, mine) {
    const span = line("you", "");
    span.classList.add("term-caret");
    for (const ch of still ? [text] : text) {
      span.textContent += ch;
      await wait(32, mine);
    }
    span.classList.remove("term-caret");
  }
  function tool(name, sub) {
    const span = line("tool", `<span class="term-tool">${name} <small>(MCP)</small></span>`);
    const note = document.createElement("span");
    note.className = "term-sub";
    note.textContent = `└ ${sub}`;
    span.append(note);
    span.parentElement.classList.add("is-busy");
    return {
      done(text) {
        note.textContent = `└ ${text}`;
        span.parentElement.classList.remove("is-busy");
      },
    };
  }

  // Dashboard
  let logN = 0;
  function log(text) {
    const div = document.createElement("div");
    div.className = "gw-log-line";
    div.dataset.stream = "system";
    div.innerHTML = `<i>${++logN}</i><span></span>`;
    div.lastElementChild.textContent = text;
    el.log.append(div);
    while (el.log.children.length > 6) el.log.firstElementChild.remove();
  }
  const setState = (node, s) => {
    node.dataset.state = s;
    node.textContent = s;
  };
  const rowState = (which) => el.rows[which].querySelector(".state");
  function tab(which) {
    el.tabApp.setAttribute("aria-selected", String(which === "app"));
    el.tabSite.setAttribute("aria-selected", String(which === "site"));
    el.app.hidden = which !== "app";
    el.site.hidden = which !== "site";
  }
  const ADDRESS = { list: "/previews", new: "/new" };
  const TITLE = {
    list: "Previews · gangway",
    new: "New preview · gangway",
    detail: "Preview · gangway",
  };
  function screen(which, p) {
    for (const [k, s] of Object.entries(el.screens)) s.hidden = k !== which;
    el.url.textContent = `gangway.acme.dev${ADDRESS[which] ?? `/previews/${p.host.split(".")[0]}`}`;
    el.tabTitle.textContent = TITLE[which];
    if (which !== "detail") return;
    el.dIcon.style.setProperty("--c", p.color);
    el.dIcon.innerHTML = glyph(p.glyph);
    el.dTitle.textContent = p.name;
    el.dUrl.textContent = `https://${p.host}`;
    setState(el.dState, "building");
    el.log.replaceChildren();
    logN = 0;
  }
  function openSite(p) {
    el.siteGlyph.innerHTML = glyph(p.siteGlyph);
    el.siteTitle.textContent = p.siteTitle;
    for (const [k, d] of Object.entries(el.decks)) d.hidden = k !== p.site;
    el.tabSite.hidden = false;
    el.url.textContent = p.host;
    tab("site");
  }
  async function deployLogs(p, mine) {
    log(`deploying gw-acme-${p.host.split(".")[0]} to host local`);
    await wait(600, mine);
    log(`unpacked ${p.files} files, ${p.bytes} bytes`);
    await wait(700, mine);
    log(`serving ${p.files} files from gangway: no container to start`);
    await wait(600, mine);
    log("awake");
  }

  // Pointer: moves to the middle of an element, presses it.
  function pointAt(target, jump = false) {
    const v = el.view.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const x = r.left - v.left + r.width / 2;
    const y = r.top - v.top + r.height / 2;
    if (jump) el.cursor.style.transition = "none";
    el.cursor.style.transform = `translate(${x}px, ${y}px)`;
    if (jump) {
      void el.cursor.offsetWidth;
      el.cursor.style.transition = "";
    }
    el.cursor.classList.add("is-on");
  }
  function pointAtCorner() {
    const v = el.view.getBoundingClientRect();
    el.cursor.style.transition = "none";
    el.cursor.style.transform = `translate(${v.width - 40}px, ${v.height - 30}px)`;
    void el.cursor.offsetWidth;
    el.cursor.style.transition = "";
  }
  async function move(target, mine) {
    pointAt(target);
    await wait(900, mine);
  }
  async function press(target, mine) {
    el.cursor.classList.add("is-press");
    target?.classList.add("is-press");
    await wait(180, mine);
    el.cursor.classList.remove("is-press");
    target?.classList.remove("is-press");
  }

  function reset(which) {
    demo.dataset.chapter = which;
    for (const b of el.go) b.setAttribute("aria-pressed", String(b.dataset.go === which));
    el.term.replaceChildren();
    el.log.replaceChildren();
    logN = 0;
    el.cursor.classList.remove("is-on", "is-press");
    el.drag.hidden = true;
    el.drop.classList.remove("is-over");
    el.dropEmpty.hidden = false;
    el.dropFull.hidden = true;
    el.progress.hidden = true;
    el.progressBar.style.width = "0";
    // The agent chapter follows the browser one, so the upload is already there and awake.
    el.rows.browser.hidden = which === "browser";
    setState(rowState("browser"), "awake");
    el.rows.agent.hidden = true;
    setState(rowState("agent"), "building");
    for (const r of Object.values(el.rows)) r.classList.remove("is-new", "is-hot");
    el.count.textContent = which === "browser" ? "3" : "4";
    el.tabSite.hidden = true;
    el.slideTitle.textContent = "Revenue grew in every region.";
    el.slideFig.textContent = "+18%";
    el.slideSub.textContent = "quarter on quarter, led by EMEA";
    el.site.classList.remove("is-fresh");
    tab("app");
    screen("list");
  }
  const scene = (text) => (el.scene.textContent = text);

  async function fromBrowser(mine) {
    const p = MADE.browser;
    reset("browser");
    scene("open New preview");
    await wait(900, mine);
    pointAt(el.screens.list.querySelector(".gw-table"), true);
    await wait(300, mine);
    await move(el.newButton, mine);
    await press(el.newButton, mine);
    screen("new");

    scene("drop a folder");
    await wait(700, mine);
    pointAtCorner();
    el.drag.hidden = false;
    await wait(200, mine);
    await move(el.drop, mine);
    el.drop.classList.add("is-over");
    await wait(500, mine);
    await press(null, mine);
    el.drag.hidden = true;
    el.drop.classList.remove("is-over");
    el.dropEmpty.hidden = true;
    el.dropFull.hidden = false;

    scene("gangway picks the runtime");
    await wait(1600, mine);
    await move(el.deployButton, mine);
    await press(el.deployButton, mine);
    el.progress.hidden = false;
    for (const pct of [40, 85, 100]) {
      el.progressBar.style.width = `${pct}%`;
      el.progressText.textContent = `Uploading… ${pct}%`;
      await wait(350, mine);
    }

    scene("it builds and starts");
    el.cursor.classList.remove("is-on");
    el.rows.browser.hidden = false;
    setState(rowState("browser"), "building");
    el.count.textContent = "4";
    screen("detail", p);
    await wait(400, mine);
    await deployLogs(p, mine);
    setState(el.dState, "awake");
    setState(rowState("browser"), "awake");

    scene("awake on its own URL");
    await wait(900, mine);
    await move(el.dUrl, mine);
    await press(el.dUrl, mine);
    el.cursor.classList.remove("is-on");
    openSite(p);
    await wait(3600, mine);
  }

  async function fromAgent(mine) {
    const p = MADE.agent;
    reset("agent");
    scene("you ask your agent");
    await wait(900, mine);
    await type("turn q3-numbers.csv into a board deck and put it on a url", mine);
    await wait(500, mine);
    line("say", "Four slides, one number each. Deploying it with gangway.");
    await wait(700, mine);
    const deploy = tool("gangway – deploy", "deploying q3-board-review…");

    scene("your agent deploys over MCP");
    await wait(600, mine);
    el.rows.agent.hidden = false;
    el.rows.agent.classList.add("is-new");
    el.count.textContent = "5";
    await wait(1200, mine);
    const name = el.rows.agent.querySelector(".gw-serif");
    pointAt(el.screens.list.querySelector(".gw-filters"), true);
    await wait(200, mine);
    await move(name, mine);
    el.rows.agent.classList.add("is-hot");
    await press(null, mine);
    el.cursor.classList.remove("is-on");

    scene("a new preview on your domain");
    screen("detail", p);
    await deployLogs(p, mine);
    setState(el.dState, "awake");
    setState(rowState("agent"), "awake");
    await wait(500, mine);
    deploy.done(`ready: https://${p.host}`);
    await wait(600, mine);
    line("say", `It's live at ${p.host}.`);
    await wait(900, mine);

    scene("open it at its own URL");
    openSite(p);
    await wait(2800, mine);

    scene("ask for a change");
    await type("lead with EMEA, it's the story", mine);
    await wait(500, mine);
    const again = tool("gangway – deploy", "rebuilding q3-board-review…");
    await wait(900, mine);
    log("rebuilt: serving 5 files from gangway");
    again.done(`ready: https://${p.host} (rebuilt)`);

    scene("same URL, new version");
    el.site.classList.remove("is-fresh");
    void el.site.offsetWidth; // restart the fade on the new slide
    el.site.classList.add("is-fresh");
    el.slideTitle.textContent = "EMEA led the quarter.";
    el.slideFig.textContent = "+31%";
    el.slideSub.textContent = "EMEA revenue, quarter on quarter";
    await wait(4200, mine);
  }

  const PLAY = { browser: fromBrowser, agent: fromAgent };
  async function play(from) {
    const mine = ++run;
    chapter = from;
    try {
      if (still) return await PLAY[from](mine);
      for (;;) {
        await PLAY[chapter](mine);
        chapter = CHAPTERS[(CHAPTERS.indexOf(chapter) + 1) % CHAPTERS.length];
      }
    } catch (e) {
      if (e !== STOP) throw e;
    }
  }

  function paused(reason, on) {
    if (on) why.add(reason);
    else why.delete(reason);
    demo.toggleAttribute("data-paused", why.size > 0);
  }
  el.pause.addEventListener("click", () => {
    const on = !why.has("button");
    paused("button", on);
    el.pause.textContent = on ? "Play" : "Pause";
    el.pause.setAttribute("aria-pressed", String(on));
  });
  el.replay.addEventListener("click", () => void play(chapter));
  for (const b of el.go) b.addEventListener("click", () => void play(b.dataset.go));
  el.stage.addEventListener("mouseenter", () => paused("hover", true));
  el.stage.addEventListener("mouseleave", () => paused("hover", false));
  new IntersectionObserver(([e]) => paused("offscreen", !e.isIntersecting)).observe(demo);

  if (still) el.pause.hidden = el.replay.hidden = true;
  void play("browser");
}

function startCopy(button) {
  const command = document.querySelector("[data-command]").textContent.trim().replace(/\s+/g, " ");
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = "Copied";
    } catch {
      getSelection().selectAllChildren(document.querySelector("[data-command]"));
      button.textContent = "Selected";
    }
    setTimeout(() => (button.textContent = "Copy"), 2000);
  });
}

renderBrandIcons();
const copy = document.querySelector("[data-copy]");
if (copy) startCopy(copy);
const demo = document.querySelector("[data-demo]");
if (demo) startDemo(demo);
