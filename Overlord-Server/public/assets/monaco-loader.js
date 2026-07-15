let monacoPromise = null;

export function loadMonaco() {
  if (window.monaco?.editor) return Promise.resolve(window.monaco);
  if (monacoPromise) return monacoPromise;

  monacoPromise = new Promise((resolve, reject) => {
    const configure = () => {
      if (typeof window.require !== "function") {
        reject(new Error("Monaco loader is unavailable"));
        return;
      }
      window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    };

    if (typeof window.require === "function") {
      configure();
      return;
    }

    const script = document.createElement("script");
    script.src = "/vendor/monaco/vs/loader.js";
    script.defer = true;
    script.onload = configure;
    script.onerror = () => reject(new Error("Failed to load Monaco"));
    document.head.appendChild(script);
  });

  return monacoPromise;
}

export function createMonacoEditorAdapter(editor, monaco) {
  return {
    getValue: () => editor.getValue(),
    setValue(value) {
      editor.setValue(value || "");
    },
    setLanguage(language) {
      const model = editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, language);
    },
    setSize(_width, height) {
      const domNode = editor.getDomNode();
      const host = domNode?.parentElement;
      if (host && height) host.style.height = height;
      editor.layout();
    },
    refresh() {
      editor.layout();
    },
    focus() {
      editor.focus();
    },
    dispose() {
      editor.dispose();
    },
  };
}
