const form = document.querySelector("[data-waitlist]");
const notice = document.getElementById("joined");
const error = form.querySelector("[data-error]");
const button = form.querySelector("button[type=submit]");

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  button.disabled = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  let res;
  try {
    res = await fetch(form.action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
  } catch {
    return showError("The waitlist could not be reached. Check your connection and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return showError(body.error || "Something went wrong. Try again in a minute.");

  const email = notice.querySelector("[data-email]");
  email.textContent = form.email.value.trim();
  email.classList.add("mono");
  notice.classList.add("shown");
  notice.scrollIntoView({ block: "nearest" });
});
