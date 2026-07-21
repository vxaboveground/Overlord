import { createPasswordPolicyChecklist, loadPasswordPolicy } from "./password-policy.js";

const form = document.getElementById("change-password-form");
const currentPass = document.getElementById("current-pass");
const newPass = document.getElementById("new-pass");
const confirmPass = document.getElementById("confirm-pass");
const errEl = document.getElementById("error");
const successEl = document.getElementById("success");
const policyEl = document.getElementById("password-policy");

const tempToken = sessionStorage.getItem("temp_token");
const tempUser = sessionStorage.getItem("temp_user");

if (!tempToken || !tempUser) {
  window.location.href = "/";
}

const user = JSON.parse(tempUser);

const passwordChecklist = createPasswordPolicyChecklist({
  passwordInput: newPass,
  confirmInput: confirmPass,
  container: policyEl,
});

loadPasswordPolicy().then((policy) => passwordChecklist.setPolicy(policy));

if (typeof anime !== "undefined") {
  const particles = document.querySelectorAll(".particle");
  particles.forEach((particle, i) => {
    anime({
      targets: particle,
      translateX: () => anime.random(-100, 100),
      translateY: () => anime.random(-100, 100),
      scale: () => anime.random(0.5, 1.5),
      opacity: [0, 0.6, 0],
      duration: () => anime.random(3000, 6000),
      delay: i * 200,
      easing: "easeInOutQuad",
      loop: true,
    });
  });

  anime
    .timeline()
    .add({
      targets: ".login-card",
      opacity: [0, 1],
      translateY: [30, 0],
      duration: 800,
      easing: "easeOutExpo",
    })
    .add(
      {
        targets: ".login-crown-wrapper",
        scale: [0, 1],
        rotate: [180, 0],
        duration: 600,
        easing: "easeOutBack",
      },
      "-=400",
    )
    .add(
      {
        targets: ".login-brand",
        opacity: [0, 1],
        translateY: [-10, 0],
        duration: 500,
        easing: "easeOutQuad",
      },
      "-=300",
    )
    .add(
      {
        targets: ".login-title, .login-subtitle",
        opacity: [0, 1],
        translateY: [10, 0],
        duration: 500,
        delay: anime.stagger(100),
        easing: "easeOutQuad",
      },
      "-=300",
    )
    .add(
      {
        targets: ".form-group",
        opacity: [0, 1],
        translateY: [15, 0],
        duration: 500,
        delay: anime.stagger(100),
        easing: "easeOutQuad",
      },
      "-=300",
    )
    .add(
      {
        targets: ".login-btn",
        opacity: [0, 1],
        scale: [0.95, 1],
        duration: 400,
        easing: "easeOutQuad",
      },
      "-=200",
    );

  anime({
    targets: ".login-crown",
    scale: [1, 1.08, 1],
    duration: 2000,
    easing: "easeInOutQuad",
    loop: true,
  });

  document.querySelectorAll(".input-animated input").forEach((input) => {
    input.addEventListener("focus", (e) => {
      anime({
        targets: e.target.parentElement,
        scale: [1, 1.02],
        duration: 200,
        easing: "easeOutQuad",
      });
    });

    input.addEventListener("blur", (e) => {
      anime({
        targets: e.target.parentElement,
        scale: [1.02, 1],
        duration: 200,
        easing: "easeOutQuad",
      });
    });
  });
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.textContent = "";
  successEl.textContent = "";

  if (newPass.value !== confirmPass.value) {
    errEl.textContent = "New passwords do not match";
    return;
  }

  const policyError = passwordChecklist.firstError();
  if (policyError) {
    errEl.textContent = policyError;
    return;
  }


  try {
    const res = await fetch(`/api/users/${user.id}/password`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tempToken}`,
      },
      body: JSON.stringify({
        currentPassword: currentPass.value,
        newPassword: newPass.value,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to change password");
    }

    sessionStorage.removeItem("temp_token");
    sessionStorage.removeItem("temp_user");

    successEl.textContent = "Password changed successfully! Redirecting...";

    if (typeof anime !== "undefined") {
      anime({
        targets: successEl,
        translateY: [-5, 0],
        duration: 400,
        easing: "easeOutQuad",
      });
    }

    setTimeout(() => {
      window.location.href = "/";
    }, 2000);
  } catch (err) {
    errEl.textContent = err.message || "Failed to change password";

    if (typeof anime !== "undefined") {
      anime({
        targets: ".login-card",
        translateX: [
          { value: -10, duration: 100 },
          { value: 10, duration: 100 },
          { value: -10, duration: 100 },
          { value: 10, duration: 100 },
          { value: 0, duration: 100 },
        ],
        easing: "easeInOutQuad",
      });

      anime({
        targets: "#error",
        opacity: [0, 1],
        translateY: [-5, 0],
        duration: 300,
        easing: "easeOutQuad",
      });
    }
  }
});
