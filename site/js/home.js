function renderBrandIcons() {
  for (const tile of document.querySelectorAll("[data-icon]")) {
    const icon = window.GW_ICONS?.[tile.dataset.icon];
    if (!icon) continue;
    const color = icon.ink || icon.hex;
    if (color) tile.style.background = `color-mix(in oklch, ${color} 16%, transparent)`;
    tile.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="${color || "currentColor"}" d="${icon.d}"/></svg>`;
  }
}

// Mirrors the design's hero: every few seconds it highlights the next preview in the list, opens
// it in the mock browser, then goes back. Hovering pauses it; any click hands control to the reader.
function startBoard(board) {
  const rows = [...board.querySelectorAll("[data-row]")];
  const apps = [...board.querySelectorAll("[data-app]")];
  const tabs = [...board.querySelectorAll(".board-tab")];
  const url = board.querySelector("[data-demo-url]");
  const flag = board.querySelector("[data-demo-state]");
  const list = board.querySelector(".board-list");
  const demo = board.querySelector(".board-demo");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const s = { view: "list", row: 0, hot: -1, auto: !still, hover: false, next: 0 };
  let timer;

  function render() {
    board.dataset.view = s.view;
    board.dataset.auto = s.auto && !s.hover ? "on" : "off";
    rows.forEach((r, i) => r.classList.toggle("is-hot", i === s.hot));
    apps.forEach((a, i) => (a.hidden = i !== s.row));
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.show === s.view)));
    list.inert = s.view === "demo";
    demo.inert = s.view !== "demo";
    const row = rows[s.row];
    url.textContent = `https://${row.dataset.host}`;
    flag.dataset.state = row.dataset.state;
    flag.textContent = row.dataset.state;
  }

  const set = (patch) => {
    Object.assign(s, patch);
    render();
  };
  const running = () => s.auto && !s.hover;

  function tour(wait) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!running()) return;
      const i = s.next % rows.length;
      set({ view: "list", hot: i });
      timer = setTimeout(() => {
        if (!running()) return set({ hot: -1 });
        set({ view: "demo", row: i, hot: -1 });
        timer = setTimeout(() => {
          if (!running()) return;
          s.next = i + 1;
          set({ view: "list" });
          tour(1400);
        }, 3400);
      }, 700);
    }, wait);
  }

  const take = (patch) => {
    clearTimeout(timer);
    set({ auto: false, hot: -1, ...patch });
  };

  rows.forEach((r, i) => r.addEventListener("click", () => take({ view: "demo", row: i })));
  for (const b of board.querySelectorAll("[data-show]")) {
    b.addEventListener("click", () => take({ view: b.dataset.show }));
  }
  board.addEventListener("mouseenter", () => {
    clearTimeout(timer);
    set({ hover: true, hot: -1 });
  });
  board.addEventListener("mouseleave", () => {
    set({ hover: false });
    if (s.auto) tour(1200);
  });

  render();
  if (s.auto) tour(1800);
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
const board = document.querySelector("[data-board]");
if (board) startBoard(board);
