import { createPasswordPolicyChecklist, loadPasswordPolicy } from "./password-policy.js";

const form = document.getElementById("register-form");
const errorEl = document.getElementById("error");
const successEl = document.getElementById("success");
const keyGroup = document.getElementById("key-group");
const keyInput = document.getElementById("reg-key");
const passwordInput = document.getElementById("reg-pass");
const confirmPasswordInput = document.getElementById("reg-pass-confirm");
const policyEl = document.getElementById("password-policy");

const passwordChecklist = createPasswordPolicyChecklist({
  passwordInput,
  confirmInput: confirmPasswordInput,
  container: policyEl,
});

loadPasswordPolicy().then((policy) => passwordChecklist.setPolicy(policy));


async function checkStatus() {
  try {
    const res = await fetch("/api/registration/status");
    const data = await res.json();
    if (!data.enabled) {
      form.style.display = "none";
      errorEl.textContent = "Registration is currently disabled.";
      return;
    }
    if (data.mode === "key") {
      keyGroup.style.display = "";
      keyInput.required = true;
    }
  } catch {
    errorEl.textContent = "Unable to check registration status.";
  }
}
checkStatus();

if (window.anime) {
  document.querySelectorAll(".particle").forEach((p, i) => {
    anime({
      targets: p,
      translateX: () => anime.random(-300, 300),
      translateY: () => anime.random(-300, 300),
      scale: () => anime.random(5, 15) / 10,
      opacity: [{ value: 0.15, duration: 600 }, { value: 0, duration: 600 }],
      easing: "easeInOutQuad",
      duration: 3000,
      delay: i * 400,
      loop: true,
      direction: "alternate",
    });
  });

  anime.timeline()
    .add({
      targets: ".login-card",
      opacity: [0, 1],
      translateY: [30, 0],
      duration: 800,
      easing: "easeOutExpo",
    })
    .add({
      targets: ".login-crown-wrapper",
      scale: [0, 1],
      rotate: [180, 0],
      duration: 600,
      easing: "easeOutBack",
    }, "-=400")
    .add({
      targets: ".login-brand, .login-title, .login-subtitle",
      opacity: [0, 1],
      translateY: [10, 0],
      duration: 500,
      delay: anime.stagger(100),
      easing: "easeOutQuad",
    }, "-=300")
    .add({
      targets: ".form-group",
      opacity: [0, 1],
      translateY: [15, 0],
      duration: 500,
      delay: anime.stagger(100),
      easing: "easeOutQuad",
    }, "-=300")
    .add({
      targets: ".login-btn",
      opacity: [0, 1],
      scale: [0.95, 1],
      duration: 400,
      easing: "easeOutQuad",
    }, "-=200");
} else {
  document.querySelector(".login-card").style.opacity = "1";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";
  successEl.style.display = "none";

  const username = document.getElementById("reg-user").value.trim();
  const password = passwordInput.value;
  const confirmPassword = confirmPasswordInput.value;
  const key = keyInput.value.trim();

  if (password !== confirmPassword) {
    errorEl.textContent = "Passwords do not match.";
    return;
  }
  const policyError = passwordChecklist.firstError();
  if (policyError) {
    errorEl.textContent = policyError;
    return;
  }

  try {
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, key: key || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || "Registration failed.";
      return;
    }
    form.style.display = "none";
    successEl.style.display = "";
    successEl.textContent = data.message || "Account created!";
    if (!data.pending) {
      setTimeout(() => { window.location.href = "/"; }, 2000);
    }
  } catch {
    errorEl.textContent = "Network error. Please try again.";
  }
});
