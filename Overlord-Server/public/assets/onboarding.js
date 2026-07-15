const TELEGRAM_URL = "https://t.me/Onimai";
const GITHUB_ISSUES_URL = "https://github.com/vxaboveground/Overlord/issues/new";

let mounted = false;

export function showOnboardingIfNeeded(user) {
  if (!user?.needsOnboarding || mounted) return;
  mounted = true;

  const style = document.createElement("style");
  style.textContent = `
    .account-onboarding { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 1.25rem; background: rgba(2, 6, 23, .88); backdrop-filter: blur(10px); }
    .account-onboarding__panel { width: min(100%, 42rem); overflow: hidden; border: 1px solid rgba(71, 85, 105, .8); border-radius: 1rem; background: #0f172a; color: #e2e8f0; box-shadow: 0 24px 80px rgba(0, 0, 0, .55); }
    .account-onboarding__hero { padding: 2rem 2rem 1.25rem; text-align: center; background: radial-gradient(circle at top, rgba(14, 165, 233, .2), transparent 65%); }
    .account-onboarding__icon { display: grid; place-items: center; width: 3.5rem; height: 3.5rem; margin: 0 auto 1rem; border: 1px solid rgba(56, 189, 248, .4); border-radius: .9rem; background: rgba(14, 165, 233, .12); color: #38bdf8; font-size: 1.5rem; }
    .account-onboarding h1 { margin: 0; color: #f8fafc; font-size: 1.65rem; line-height: 1.2; font-weight: 700; }
    .account-onboarding__intro { margin: .65rem auto 0; max-width: 33rem; color: #94a3b8; line-height: 1.55; }
    .account-onboarding__progress { display: flex; align-items: center; justify-content: center; gap: .5rem; margin-top: 1.15rem; color: #64748b; font-size: .8rem; font-weight: 600; }
    .account-onboarding__dot { width: .55rem; height: .55rem; border-radius: 999px; background: #334155; }
    .account-onboarding__dot--active { background: #38bdf8; box-shadow: 0 0 0 4px rgba(56, 189, 248, .12); }
    .account-onboarding__step { padding: .25rem 2rem 1.25rem; }
    .account-onboarding__card { padding: 1.35rem; border: 1px solid #334155; border-radius: .85rem; background: rgba(30, 41, 59, .65); text-align: center; }
    .account-onboarding__card h2 { margin: 0 0 .55rem; color: #f8fafc; font-size: 1.2rem; }
    .account-onboarding__card p { margin: 0; color: #cbd5e1; line-height: 1.55; }
    .account-onboarding__url-label { margin-top: 1.15rem; color: #94a3b8; font-size: .75rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .account-onboarding__url { display: block; margin-top: .4rem; padding: .7rem .8rem; overflow-wrap: anywhere; border: 1px solid #475569; border-radius: .55rem; background: #020617; color: #7dd3fc; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88rem; text-decoration: underline; }
    .account-onboarding__open { display: inline-flex; align-items: center; justify-content: center; gap: .5rem; margin-top: 1rem; padding: .65rem 1rem; border: 1px solid #0369a1; border-radius: .6rem; background: rgba(3, 105, 161, .18); color: #e0f2fe; font-weight: 600; text-decoration: none; transition: background .15s, border-color .15s; }
    .account-onboarding__open:hover { border-color: #38bdf8; background: rgba(14, 165, 233, .28); }
    .account-onboarding__footer { padding: .5rem 2rem 1.5rem; text-align: center; }
    .account-onboarding__continue { width: 100%; padding: .75rem 1rem; border: 0; border-radius: .65rem; background: #0284c7; color: white; font: inherit; font-weight: 600; cursor: pointer; transition: background .15s; }
    .account-onboarding__continue:hover { background: #0ea5e9; }
    .account-onboarding__continue:disabled { cursor: wait; opacity: .65; }
    .account-onboarding__error { min-height: 1.25rem; margin: .55rem 0 0; color: #fca5a5; font-size: .8rem; }
    @media (max-width: 600px) { .account-onboarding__hero { padding: 1.5rem 1.25rem 1.1rem; } .account-onboarding__step { padding: .2rem 1.25rem 1rem; } .account-onboarding__footer { padding: .5rem 1.25rem 1.25rem; } }
  `;

  const overlay = document.createElement("div");
  overlay.className = "account-onboarding";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "account-onboarding-title");
  overlay.innerHTML = `
    <section class="account-onboarding__panel">
      <div class="account-onboarding__hero">
        <div class="account-onboarding__icon"><i class="fa-solid fa-crown" aria-hidden="true"></i></div>
        <h1 id="account-onboarding-title">Welcome to Overlord</h1>
        <p class="account-onboarding__intro">Please review both support resources so you always know exactly where to go.</p>
        <div class="account-onboarding__progress" aria-label="Onboarding progress">
          <span class="account-onboarding__dot account-onboarding__dot--active"></span>
          <span class="account-onboarding__progress-text">Step 1 of 2</span>
          <span class="account-onboarding__dot"></span>
        </div>
      </div>
      <div class="account-onboarding__step"></div>
      <div class="account-onboarding__footer">
        <button class="account-onboarding__continue" type="button">Confirm: I know where to get help</button>
        <p class="account-onboarding__error" role="alert"></p>
      </div>
    </section>
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const button = overlay.querySelector(".account-onboarding__continue");
  const error = overlay.querySelector(".account-onboarding__error");
  const stepContent = overlay.querySelector(".account-onboarding__step");
  const progressText = overlay.querySelector(".account-onboarding__progress-text");
  const progressDots = overlay.querySelectorAll(".account-onboarding__dot");
  let currentStep = 1;

  const renderStep = () => {
    if (currentStep === 1) {
      stepContent.innerHTML = `
        <div class="account-onboarding__card">
          <h2><i class="fa-brands fa-telegram" aria-hidden="true"></i> Need help? Use Telegram</h2>
          <p><strong>This is the place to ask for help and talk with the community.</strong> Join the Telegram if you have questions, need assistance, or want project updates.</p>
          <div class="account-onboarding__url-label">Full Telegram link</div>
          <a class="account-onboarding__url" href="${TELEGRAM_URL}" target="_blank" rel="noopener noreferrer">${TELEGRAM_URL}</a>
          <a class="account-onboarding__open" href="${TELEGRAM_URL}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-telegram" aria-hidden="true"></i> Open Telegram</a>
        </div>
      `;
      progressText.textContent = "Step 1 of 2";
      progressDots[0].classList.add("account-onboarding__dot--active");
      progressDots[1].classList.remove("account-onboarding__dot--active");
      button.textContent = "Confirm: I know where to get help";
      return;
    }

    stepContent.innerHTML = `
      <div class="account-onboarding__card">
        <h2><i class="fa-brands fa-github" aria-hidden="true"></i> Found a bug? Use GitHub Issues</h2>
        <p><strong>This is the official place to report bugs.</strong> Create a GitHub issue with what happened, what you expected, and any useful screenshots or logs so the problem can be tracked and fixed.</p>
        <div class="account-onboarding__url-label">Full bug report link</div>
        <a class="account-onboarding__url" href="${GITHUB_ISSUES_URL}" target="_blank" rel="noopener noreferrer">${GITHUB_ISSUES_URL}</a>
        <a class="account-onboarding__open" href="${GITHUB_ISSUES_URL}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-github" aria-hidden="true"></i> Create a GitHub issue</a>
      </div>
    `;
    progressText.textContent = "Step 2 of 2";
    progressDots[0].classList.remove("account-onboarding__dot--active");
    progressDots[1].classList.add("account-onboarding__dot--active");
    button.textContent = "Confirm: I know where to report bugs";
  };

  renderStep();
  button?.focus();
  button?.addEventListener("click", async () => {
    if (currentStep === 1) {
      currentStep = 2;
      renderStep();
      button.focus();
      return;
    }

    button.disabled = true;
    error.textContent = "";
    try {
      const response = await fetch("/api/auth/onboarding/complete", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not save your onboarding status.");
      overlay.remove();
      style.remove();
      document.body.style.overflow = "";
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : "Please try again.";
      button.disabled = false;
      button.focus();
    }
  });
}
