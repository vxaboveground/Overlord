export function applyUserRoleUI(user, refs) {
  const { usernameDisplay, roleBadge } = refs;

  if (!user || !usernameDisplay || !roleBadge) return;

  usernameDisplay.textContent = user.username || "unknown";

  const roleBadges = {
    admin: '<i class="fa-solid fa-crown mr-1"></i>Admin',
    operator: '<i class="fa-solid fa-sliders mr-1"></i>Operator',
    viewer: '<i class="fa-solid fa-eye mr-1"></i>Viewer',
  };

  if (roleBadges[user.role]) {
    roleBadge.innerHTML = roleBadges[user.role];
  } else {
    roleBadge.textContent = user.role || "user";
  }

  roleBadge.classList.remove(
    "bg-purple-900/50",
    "text-purple-300",
    "border",
    "border-purple-800",
    "bg-blue-900/50",
    "text-blue-300",
    "border-blue-800",
    "bg-slate-700",
    "text-slate-300",
    "border-slate-600",
  );

  if (user.role === "admin") {
    roleBadge.classList.add(
      "bg-purple-900/50",
      "text-purple-300",
      "border",
      "border-purple-800",
    );
  } else if (user.role === "operator") {
    roleBadge.classList.add(
      "bg-blue-900/50",
      "text-blue-300",
      "border",
      "border-blue-800",
    );
  } else {
    roleBadge.classList.add(
      "bg-slate-700",
      "text-slate-300",
      "border",
      "border-slate-600",
    );
  }

  // Helper: unhide an element by ID in both topbar and sidebar
  const unhide = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
  };

  if (user.role === "admin") {
    unhide("users-link");
    unhide("plugins-link");
    unhide("logs-link");
    unhide("sol-publish-link");
  }
  if (user.role === "admin" || user.role === "operator") {
    unhide("build-link");
    unhide("notifications-link");
    unhide("enrollment-link");
  }
  if (user.role !== "viewer") {
    unhide("scripts-link");
    unhide("file-share-link");
  }
}
