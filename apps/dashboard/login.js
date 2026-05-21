const form = document.querySelector("#loginForm");
const githubLogin = document.querySelector("#githubLogin");
const input = document.querySelector("#tokenInput");
const divider = document.querySelector("#loginDivider");
const message = document.querySelector("#loginMessage");

const statusResponse = await fetch("/api/auth/status", { cache: "no-store" });
const status = await statusResponse.json();
if (!status.authRequired || status.authenticated) {
  window.location.assign("/");
}

const params = new URLSearchParams(window.location.search);
if (params.get("error")) {
  message.textContent = errorMessage(params.get("error"));
}

if (!status.providers?.github) {
  githubLogin.hidden = true;
}

if (!status.providers?.token) {
  form.querySelector("label").hidden = true;
  form.querySelector("button[type='submit']").hidden = true;
}

if (!status.providers?.github || !status.providers?.token) {
  divider.hidden = true;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";

  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: input.value })
  });

  if (response.ok) {
    window.location.assign("/");
    return;
  }

  message.textContent = "Token rejected";
  input.select();
});

function errorMessage(error) {
  const messages = {
    github_auth_failed: "GitHub sign-in failed. Try again.",
    github_code: "GitHub did not return a sign-in code.",
    github_denied: "GitHub sign-in was cancelled.",
    github_not_authorized: "Your GitHub account is not authorized for Runnerly.",
    github_not_configured: "GitHub sign-in is not configured yet.",
    github_state: "GitHub sign-in expired. Try again."
  };

  return messages[error] ?? "Sign-in failed. Try again.";
}
