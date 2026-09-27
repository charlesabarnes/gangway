const KEY = "gw-theme";

// A cookie on the parent domain: the app and every preview under it share one choice.
function cookie(): string | null {
  try {
    return /(?:^|;\s*)gw-theme=(light|dark)(?:;|$)/.exec(document.cookie)?.[1] ?? null;
  } catch {
    return null;
  }
}

function save(value: string | null): void {
  const parent = location.hostname.split(".").slice(1).join(".");
  const domain = parent.includes(".") ? `; domain=${parent}` : "";
  const secure = location.protocol === "https:" ? "; secure" : "";
  const life = value ? "max-age=31536000" : "max-age=0";
  try {
    document.cookie = `${KEY}=${value ?? ""}; path=/; ${life}; samesite=lax${domain}${secure}`;
  } catch {}
}

function stored(): string | null {
  const shared = cookie();
  if (shared) return shared;
  // Before the cookie the choice lived in this host's storage; move it over once.
  try {
    const v = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    if (v === "light" || v === "dark") save(v);
    return v;
  } catch {
    return null;
  }
}

export function applyTheme(): void {
  const root = document.documentElement;
  let t = stored() ?? root.dataset["pref"];
  if (t !== "light" && t !== "dark")
    t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  root.dataset["theme"] = t;
}

const OPTIONS = [
  ["system", "◐"],
  ["light", "☼"],
  ["dark", "☾"],
] as const;

function toggle(): HTMLElement {
  const t = document.createElement("div");
  t.className = "gw-chrome gw-toggle";
  t.setAttribute("role", "group");
  t.setAttribute("aria-label", "Theme");
  let current = stored() ?? "system";
  const paint = () =>
    [...t.children].forEach((b, i) =>
      b.setAttribute("aria-pressed", String(OPTIONS[i]?.[0] === current)),
    );
  for (const [id, glyph] of OPTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = `${id[0]!.toUpperCase()}${id.slice(1)} theme`;
    b.textContent = glyph;
    b.onclick = () => {
      current = id;
      save(id === "system" ? null : id);
      applyTheme();
      paint();
    };
    t.appendChild(b);
  }
  paint();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  document.addEventListener("visibilitychange", () => {
    current = stored() ?? "system";
    applyTheme();
    paint();
  });
  return t;
}

/** The theme toggle on every artifact; gangway itself adds its watermark to the page. */
export function chrome(): void {
  if (document.querySelector(".gw-toggle")) return;
  document.body.append(toggle());
}
