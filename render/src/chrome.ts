const KEY = "gw-theme";

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
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
      try {
        if (id === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, id);
      } catch {}
      applyTheme();
      paint();
    };
    t.appendChild(b);
  }
  paint();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  return t;
}

/** The theme toggle and a faint gangway mark, on every artifact. */
export function chrome(base: string, brand: boolean): void {
  if (document.querySelector(".gw-toggle")) return;
  document.body.append(toggle());
  if (!brand) return;
  const mark = document.createElement("div");
  mark.className = "gw-chrome gw-brand";
  mark.innerHTML = `<img class="l" src="${base}logo.svg" alt=""><img class="d" src="${base}logo-light.svg" alt="">gangway`;
  document.body.append(mark);
}
