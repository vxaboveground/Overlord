const DEFAULT_POLICY = {
  minLength: 6,
  requireUppercase: false,
  requireLowercase: false,
  requireNumber: false,
  requireSymbol: false,
};

function normalizePolicy(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    minLength: Math.min(128, Math.max(6, Number(source.minLength) || DEFAULT_POLICY.minLength)),
    requireUppercase: Boolean(source.requireUppercase),
    requireLowercase: Boolean(source.requireLowercase),
    requireNumber: Boolean(source.requireNumber),
    requireSymbol: Boolean(source.requireSymbol),
  };
}

export async function loadPasswordPolicy() {
  try {
    const res = await fetch("/api/registration/status", { credentials: "include" });
    if (!res.ok) return DEFAULT_POLICY;
    const data = await res.json().catch(() => ({}));
    return normalizePolicy(data.passwordPolicy);
  } catch {
    return DEFAULT_POLICY;
  }
}

function buildRules(password, confirmPassword, policy, includeMatch) {
  const rules = [
    {
      id: "minLength",
      label: `At least ${policy.minLength} characters`,
      met: password.length >= policy.minLength,
    },
  ];

  if (policy.requireUppercase) {
    rules.push({ id: "uppercase", label: "One uppercase letter", met: /[A-Z]/.test(password) });
  }
  if (policy.requireLowercase) {
    rules.push({ id: "lowercase", label: "One lowercase letter", met: /[a-z]/.test(password) });
  }
  if (policy.requireNumber) {
    rules.push({ id: "number", label: "One number", met: /[0-9]/.test(password) });
  }
  if (policy.requireSymbol) {
    rules.push({ id: "symbol", label: "One symbol", met: /[^A-Za-z0-9]/.test(password) });
  }
  if (includeMatch) {
    rules.push({
      id: "match",
      label: "Passwords match",
      met: password.length > 0 && confirmPassword.length > 0 && password === confirmPassword,
    });
  }

  return rules;
}

function render(container, rules) {
  container.innerHTML = `
    <div class="password-policy-title">
      <i class="fa-solid fa-shield-halved"></i>
      <span>Password requirements</span>
    </div>
    <ul class="password-policy-list">
      ${rules
        .map(
          (rule) => `
            <li class="password-policy-item ${rule.met ? "is-met" : "is-unmet"}" data-password-rule="${rule.id}">
              <i class="fa-solid ${rule.met ? "fa-circle-check" : "fa-circle"}"></i>
              <span>${rule.label}</span>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

export function createPasswordPolicyChecklist({ passwordInput, confirmInput, container }) {
  let policy = DEFAULT_POLICY;
  const includeMatch = Boolean(confirmInput);

  function currentRules() {
    return buildRules(passwordInput?.value || "", confirmInput?.value || "", policy, includeMatch);
  }

  function update() {
    if (!container) return;
    render(container, currentRules());
  }

  function firstError() {
    const failed = currentRules().find((rule) => !rule.met);
    return failed ? failed.label : null;
  }

  function isSatisfied() {
    return firstError() === null;
  }

  function setPolicy(nextPolicy) {
    policy = normalizePolicy(nextPolicy);
    if (passwordInput) {
      passwordInput.minLength = policy.minLength;
      passwordInput.placeholder = `At least ${policy.minLength} characters`;
    }
    if (confirmInput) {
      confirmInput.minLength = policy.minLength;
    }
    update();
  }

  passwordInput?.addEventListener("input", update);
  confirmInput?.addEventListener("input", update);
  update();

  return { firstError, isSatisfied, setPolicy, update };
}
