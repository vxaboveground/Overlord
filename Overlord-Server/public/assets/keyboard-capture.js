export const CAPTURE_FLAG = "__overlordCapturingKeyboard";

function isEditableTarget(container) {
  const el = document.activeElement;
  if (!el) return false;
  if (el === document.body) return false;
  if (container && el === container) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function hasCaptureFocus(container) {
  if (!container) return true;
  const el = document.activeElement;
  return !!el && (el === container || container.contains(el));
}

const SYSTEM_KEY_CODES = [
  "Escape",
  "Tab",
  "ContextMenu",
  "MetaLeft", "MetaRight", "OSLeft", "OSRight",
  "AltLeft", "AltRight",
  "ControlLeft", "ControlRight",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "KeyT", "KeyN", "KeyW", "KeyL", "KeyR", "KeyS", "KeyF", "KeyP", "KeyJ", "KeyH",
  "PrintScreen",
];

function tryLock() {
  try {
    if (navigator.keyboard && navigator.keyboard.lock) {
      navigator.keyboard.lock(SYSTEM_KEY_CODES);
    }
  } catch {}
}

function tryUnlock() {
  try {
    if (navigator.keyboard && navigator.keyboard.unlock) {
      navigator.keyboard.unlock();
    }
  } catch {}
}

export function createKeyboardCapture({ container, sendKeyDown, sendKeyUp, onTextInput }) {
  let enabled = false;
  const pressed = new Map();

  function setCaptureFlag(active) {
    if (active) window[CAPTURE_FLAG] = true;
    else delete window[CAPTURE_FLAG];
  }

  function refreshCaptureState() {
    if (!enabled) {
      setCaptureFlag(false);
      return;
    }
    if (hasCaptureFocus(container)) {
      setCaptureFlag(true);
      tryLock();
    } else {
      setCaptureFlag(false);
      tryUnlock();
      releaseAll();
    }
  }

  function shouldCapture() {
    if (!enabled) return false;
    if (!hasCaptureFocus(container)) {
      refreshCaptureState();
      return false;
    }
    if (isEditableTarget(container)) return false;
    setCaptureFlag(true);
    return true;
  }

  function handleDown(e) {
    if (!shouldCapture()) return;
    pressed.set(e.code || e.key, { key: e.key, code: e.code });
    if (onTextInput && !e.ctrlKey && !e.metaKey && !e.altKey && typeof e.key === "string" && e.key.length === 1) {
      onTextInput(e);
    } else {
      sendKeyDown(e);
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function handleUp(e) {
    if (!shouldCapture()) return;
    pressed.delete(e.code || e.key);
    if (onTextInput && !e.ctrlKey && !e.metaKey && !e.altKey && typeof e.key === "string" && e.key.length === 1) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    sendKeyUp(e);
    e.preventDefault();
    e.stopPropagation();
  }

  function releaseAll() {
    for (const v of pressed.values()) sendKeyUp(v);
    pressed.clear();
  }

  function handleBlur() { releaseAll(); }
  function handleVisibility() { if (document.visibilityState === "hidden") releaseAll(); }
  function handleContextMenu(e) { if (shouldCapture()) e.preventDefault(); }
  function handleFocusChange() { setTimeout(refreshCaptureState, 0); }
  function handleFullscreenChange() { refreshCaptureState(); }

  return {
    isEnabled() { return enabled; },
    enable() {
      if (enabled) return;
      enabled = true;
      refreshCaptureState();
      window.addEventListener("keydown", handleDown, { capture: true });
      window.addEventListener("keyup", handleUp, { capture: true });
      window.addEventListener("blur", handleBlur);
      window.addEventListener("contextmenu", handleContextMenu, { capture: true });
      document.addEventListener("focusin", handleFocusChange);
      document.addEventListener("focusout", handleFocusChange);
      document.addEventListener("visibilitychange", handleVisibility);
      document.addEventListener("fullscreenchange", handleFullscreenChange);
    },
    disable() {
      if (!enabled) return;
      enabled = false;
      setCaptureFlag(false);
      window.removeEventListener("keydown", handleDown, { capture: true });
      window.removeEventListener("keyup", handleUp, { capture: true });
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("contextmenu", handleContextMenu, { capture: true });
      document.removeEventListener("focusin", handleFocusChange);
      document.removeEventListener("focusout", handleFocusChange);
      document.removeEventListener("visibilitychange", handleVisibility);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      tryUnlock();
      releaseAll();
    },
  };
}
