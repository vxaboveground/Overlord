const form = document.getElementById("login-form");
const user = document.getElementById("user");
const pass = document.getElementById("pass");
const mfaGroup = document.getElementById("mfa-group");
const mfaCode = document.getElementById("mfa-code");
const errEl = document.getElementById("error");
const oidcLogin = document.getElementById("oidc-login");
const oidcLoginLabel = document.getElementById("oidc-login-label");
const loginBrand = document.getElementById("login-brand");
const loginTitle = document.getElementById("login-title");
const loginSubtitle = document.getElementById("login-subtitle");
const loginIcon = document.getElementById("login-icon");
const loginLogo = document.getElementById("login-logo");
const loginHeroImage = document.getElementById("login-hero-image");
const loginBrandFooter = document.getElementById("login-brand-footer");
const loginSupportLink = document.getElementById("login-support-link");

(() => {
  const params = new URLSearchParams(window.location.search);
  const oidcError = params.get("oidc_error");
  if (oidcError) {
    errEl.textContent = oidcError;
    window.history.replaceState({}, document.title, "/login.html");
  }
})();

(async () => {
  try {
    const res = await fetch("/api/login/branding");
    if (!res.ok) return;
    const data = await res.json();

    if (loginBrand && data.productName) loginBrand.textContent = data.productName;
    if (loginTitle && data.title) loginTitle.textContent = data.title;
    if (loginSubtitle && data.subtitle) loginSubtitle.textContent = data.subtitle;
    if (data.productName) document.title = `${data.productName} Login`;
    if (data.accentColor) document.documentElement.style.setProperty("--brand-accent", data.accentColor);

    if (loginIcon && data.iconClass) {
      loginIcon.className = `${data.iconClass} login-crown`;
    }

    if (loginLogo && loginIcon && data.logoUrl) {
      loginLogo.alt = data.logoAlt || `${data.productName || "Overlord"} logo`;
      loginLogo.onload = () => {
        loginLogo.style.display = "";
        loginIcon.style.display = "none";
      };
      loginLogo.onerror = () => {
        loginLogo.style.display = "none";
        loginIcon.style.display = "";
      };
      loginLogo.src = data.logoUrl;
    }

    if (loginHeroImage && data.heroImageUrl) {
      loginHeroImage.alt = data.heroImageAlt || "";
      loginHeroImage.onload = () => {
        loginHeroImage.style.display = "";
        document.body.classList.add("login-has-hero-image");
      };
      loginHeroImage.onerror = () => {
        loginHeroImage.style.display = "none";
        document.body.classList.remove("login-has-hero-image");
      };
      loginHeroImage.src = data.heroImageUrl;
    }

    if (loginBrandFooter && data.footerText) {
      loginBrandFooter.textContent = data.footerText;
      loginBrandFooter.style.display = "";
    }

    if (loginSupportLink && data.supportText && data.supportUrl) {
      loginSupportLink.textContent = data.supportText;
      loginSupportLink.href = data.supportUrl;
      if (!data.supportUrl.startsWith("/")) {
        loginSupportLink.target = "_blank";
        loginSupportLink.rel = "noopener noreferrer";
      }
      loginSupportLink.style.display = "";
    }
  } catch {}
})();

(async () => {
  try {
    const res = await fetch("/api/registration/status");
    const data = await res.json();
    if (data.enabled) {
      const el = document.getElementById("register-link");
      if (el) el.style.display = "";
    }
  } catch {}
})();

(async () => {
  try {
    const res = await fetch("/api/oidc/status");
    if (!res.ok) return;
    const data = await res.json();
    if (data.enabled && data.loginUrl && oidcLogin) {
      oidcLogin.href = data.loginUrl;
      if (oidcLoginLabel && data.label) oidcLoginLabel.textContent = data.label;
      oidcLogin.style.display = "";
    }
  } catch {}
})();

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
    scale: [1, 1.1, 1],
    duration: 2000,
    easing: "easeInOutQuad",
    loop: true,
  });

  const loginBtn = document.querySelector(".login-btn");
  if (loginBtn) {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let particleInterval = prefersReducedMotion ? 0 : 220;
    let currentInterval;

    function createParticle() {
      const btnRect = loginBtn.getBoundingClientRect();
      const particle = document.createElement("div");
      particle.className = "login-btn-particle";

      const edge = Math.random();
      let startX, startY, moveX, moveY;

      if (edge < 0.7) {
        startX = btnRect.left + Math.random() * btnRect.width;
        startY = btnRect.bottom;
        moveX = anime.random(-20, 20);
        moveY = anime.random(40, 80);
      } else if (edge < 0.8) {
        startX = btnRect.left;
        startY = btnRect.top + Math.random() * btnRect.height;
        moveX = anime.random(-50, -25);
        moveY = anime.random(-15, 25);
      } else if (edge < 0.9) {
        startX = btnRect.right;
        startY = btnRect.top + Math.random() * btnRect.height;
        moveX = anime.random(25, 50);
        moveY = anime.random(-15, 25);
      } else {
        startX = btnRect.left + Math.random() * btnRect.width;
        startY = btnRect.top;
        moveX = anime.random(-25, 25);
        moveY = anime.random(-50, -25);
      }

      const size = anime.random(3, 7);
      particle.style.width = size + "px";
      particle.style.height = size + "px";
      particle.style.left = startX + "px";
      particle.style.top = startY + "px";

      document.body.appendChild(particle);

      anime({
        targets: particle,
        translateX: [0, moveX],
        translateY: [0, moveY],
        opacity: [0, 0.9, 0.7, 0],
        scale: [0.5, 1, 0.8, 0.3],
        rotate: anime.random(-180, 180),
        duration: anime.random(1200, 2000),
        easing: "easeOutQuad",
        complete: () => particle.remove(),
      });
    }

    function startParticles(interval) {
      if (currentInterval) clearInterval(currentInterval);
      if (interval > 0) {
        currentInterval = setInterval(createParticle, interval);
      }
    }

    startParticles(particleInterval);

    loginBtn.addEventListener("mouseenter", () => {
      if (!prefersReducedMotion) {
        startParticles(120);
      }
    });

    loginBtn.addEventListener("mouseleave", () => {
      startParticles(particleInterval);
    });
  }

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

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (typeof anime !== "undefined" && submitBtn) {
    anime({
      targets: submitBtn,
      scale: [1, 0.95, 1],
      duration: 300,
      easing: "easeInOutQuad",
    });
  }

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: user.value,
        pass: pass.value,
        mfaCode: mfaCode?.value || "",
      }),
    });

    if (res.status === 202) {
      const data = await res.json().catch(() => ({}));
      if (data.mfaRequired) {
        if (mfaGroup) mfaGroup.style.display = "";
        if (mfaCode) {
          mfaCode.required = true;
          mfaCode.focus();
        }
        errEl.textContent = "Enter your authenticator code to continue.";
        return;
      }
    }

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Invalid credentials");
    }

    const data = await res.json();

    if (data.user && data.user.mustChangePassword) {
      sessionStorage.setItem("temp_token", data.token);
      sessionStorage.setItem("temp_user", JSON.stringify(data.user));

      window.location.href = "/change-password.html";
    } else {
      window.location.href = "/";
    }
  } catch (err) {
    errEl.textContent = err.message || "Login failed";

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
