// The header's light/dark button. The theme itself is set before first paint by the inline script
// in each page's <head>; this keeps it in step with the system until the visitor picks one. A block,
// because the pages' classic scripts share one global scope.
{
  const KEY = "gw-theme";
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  const button = document.querySelector("[data-theme-toggle]");

  function stored() {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch {
      return null;
    }
  }
  function apply(theme) {
    root.dataset.theme = theme;
    if (!button) return;
    const next = theme === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", `Switch to ${next} mode`);
    button.title = `Switch to ${next} mode`;
  }

  apply(stored() ?? (system.matches ? "dark" : "light"));
  system.addEventListener("change", (e) => {
    if (!stored()) apply(e.matches ? "dark" : "light");
  });
  if (button) {
    button.hidden = false;
    button.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      // Picking the system's own theme goes back to following it.
      try {
        if (next === (system.matches ? "dark" : "light")) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch {
        // Storage can be blocked; the choice still holds for this page.
      }
      apply(next);
    });
  }
}
