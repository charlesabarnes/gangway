for (const button of document.querySelectorAll("[data-copy]")) {
  const code = button.closest(".snippet").querySelector("[data-snippet]");
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = "Copied";
    } catch {
      getSelection().selectAllChildren(code);
      button.textContent = "Selected";
    }
    setTimeout(() => (button.textContent = "Copy"), 2000);
  });
}
