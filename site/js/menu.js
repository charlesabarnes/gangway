const header = document.querySelector(".site-header");
const toggle = header.querySelector(".menu-toggle");
const narrow = matchMedia("(max-width: 720px)");

function setOpen(open) {
  header.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.textContent = open ? "Close" : "Menu";
}

header.dataset.menu = "";
toggle.hidden = false;
toggle.addEventListener("click", () => setOpen(!header.classList.contains("is-open")));
for (const link of header.querySelectorAll(".header-menu a")) {
  link.addEventListener("click", () => setOpen(false));
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && header.classList.contains("is-open")) {
    setOpen(false);
    toggle.focus();
  }
});
document.addEventListener("click", (event) => {
  if (!header.contains(event.target)) setOpen(false);
});
narrow.addEventListener("change", () => setOpen(false));
