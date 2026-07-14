/**
 * Copies vendor assets from node_modules into public/vendor/ and bundles
 * libraries that don't ship browser-ready builds.
 *
 * Usage:  bun run scripts/vendor.ts
 */

import { $ } from "bun";
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const NM = path.join(ROOT, "node_modules");
const VENDOR = path.join(ROOT, "public", "vendor");

/* ── helpers ─────────────────────────────────────────────────────── */

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function copyDir(src: string, dest: string) {
  cpSync(src, dest, { recursive: true });
}

function copyFile(src: string, dest: string) {
  ensureDir(path.dirname(dest));
  copyFileSync(src, dest);
}

/** Copy only specific files matching a filter from a flat directory */
function copyFilesFiltered(srcDir: string, destDir: string, filter: (name: string) => boolean) {
  ensureDir(destDir);
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && filter(entry.name)) {
      copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    }
  }
}

/* ── clean ───────────────────────────────────────────────────────── */

console.log("Cleaning public/vendor/ ...");
if (existsSync(VENDOR)) rmSync(VENDOR, { recursive: true });
ensureDir(VENDOR);

/* ── Font Awesome ────────────────────────────────────────────────── */

console.log("Copying Font Awesome ...");
const faRoot = path.join(NM, "@fortawesome", "fontawesome-free");
copyFile(
  path.join(faRoot, "css", "all.min.css"),
  path.join(VENDOR, "fontawesome", "css", "all.min.css"),
);
copyDir(
  path.join(faRoot, "webfonts"),
  path.join(VENDOR, "fontawesome", "webfonts"),
);

/* ── Fontsource Inter ────────────────────────────────────────────── */

console.log("Copying Inter font ...");
const interRoot = path.join(NM, "@fontsource", "inter");
for (const weight of ["400", "600", "700"]) {
  copyFile(
    path.join(interRoot, `${weight}.css`),
    path.join(VENDOR, "inter", `${weight}.css`),
  );
}
// Copy only the font files for the weights we use (normal only, no italic)
const interFilesDir = path.join(interRoot, "files");
copyFilesFiltered(interFilesDir, path.join(VENDOR, "inter", "files"), (name) => {
  return /^inter-.*-(400|600|700)-normal\.(woff2|woff)$/.test(name);
});

/* ── Fontsource JetBrains Mono ───────────────────────────────────── */

console.log("Copying JetBrains Mono font ...");
const jbRoot = path.join(NM, "@fontsource", "jetbrains-mono");
for (const weight of ["400", "600"]) {
  copyFile(
    path.join(jbRoot, `${weight}.css`),
    path.join(VENDOR, "jetbrains-mono", `${weight}.css`),
  );
}
const jbFilesDir = path.join(jbRoot, "files");
copyFilesFiltered(jbFilesDir, path.join(VENDOR, "jetbrains-mono", "files"), (name) => {
  return /^jetbrains-mono-.*-(400|600)-normal\.(woff2|woff)$/.test(name);
});

/* ── Flag Icons ──────────────────────────────────────────────────── */

console.log("Copying Flag Icons ...");
const flagRoot = path.join(NM, "flag-icons");
copyFile(
  path.join(flagRoot, "css", "flag-icons.min.css"),
  path.join(VENDOR, "flag-icons", "css", "flag-icons.min.css"),
);
copyDir(
  path.join(flagRoot, "flags"),
  path.join(VENDOR, "flag-icons", "flags"),
);

/* ── msgpackr ────────────────────────────────────────────────────── */

console.log("Copying msgpackr ...");
copyFile(
  path.join(NM, "msgpackr", "dist", "index.js"),
  path.join(VENDOR, "msgpackr", "msgpackr.js"),
);

/* ── anime.js ────────────────────────────────────────────────────── */

console.log("Copying anime.js ...");
copyFile(
  path.join(NM, "animejs", "lib", "anime.min.js"),
  path.join(VENDOR, "animejs", "anime.min.js"),
);

/* ── CodeMirror 5 ────────────────────────────────────────────────── */

console.log("Copying CodeMirror ...");
const cmRoot = path.join(NM, "codemirror");
copyFile(path.join(cmRoot, "lib", "codemirror.js"), path.join(VENDOR, "codemirror", "lib", "codemirror.js"));
copyFile(path.join(cmRoot, "lib", "codemirror.css"), path.join(VENDOR, "codemirror", "lib", "codemirror.css"));
copyFile(
  path.join(cmRoot, "theme", "material-darker.css"),
  path.join(VENDOR, "codemirror", "theme", "material-darker.css"),
);
for (const mode of ["powershell", "shell", "python"]) {
  copyFile(
    path.join(cmRoot, "mode", mode, `${mode}.js`),
    path.join(VENDOR, "codemirror", "mode", mode, `${mode}.js`),
  );
}

/* ── Ace Editor ──────────────────────────────────────────────────── */

console.log("Copying Ace Editor ...");
const aceSrc = path.join(NM, "ace-builds", "src-min-noconflict");
const aceDst = path.join(VENDOR, "ace-builds");
for (const file of [
  "ace.js",
  "mode-json.js",
  "worker-json.js",
  "theme-tomorrow_night.js",
]) {
  copyFile(path.join(aceSrc, file), path.join(aceDst, file));
}

/* ── Chart.js ────────────────────────────────────────────────────── */

console.log("Copying Chart.js ...");
copyFile(
  path.join(NM, "chart.js", "dist", "chart.umd.js"),
  path.join(VENDOR, "chart.js", "chart.umd.js"),
);
const chartEntry = `
export { default } from '${path.join(NM, "chart.js", "auto", "auto.js").replace(/\\/g, "/")}';
`;
const chartTmp = path.join(ROOT, "scripts", "_chart-entry.ts");
await Bun.write(chartTmp, chartEntry);
const chartBuild = await Bun.build({
  entrypoints: [chartTmp],
  minify: true,
  target: "browser",
  format: "esm",
});
if (chartBuild.success) {
  await Bun.write(path.join(VENDOR, "chart.js", "chart.esm.js"), chartBuild.outputs[0]);
} else {
  console.error("Chart.js bundle failed:", chartBuild.logs);
  process.exit(1);
}
rmSync(chartTmp, { force: true });

/* ── Monaco Editor ───────────────────────────────────────────────── */

console.log("Copying Monaco Editor ...");
copyDir(
  path.join(NM, "monaco-editor", "min", "vs"),
  path.join(VENDOR, "monaco", "vs"),
);

/* ── Tabulator ───────────────────────────────────────────────────── */

console.log("Copying Tabulator ...");
copyFile(
  path.join(NM, "tabulator-tables", "dist", "js", "tabulator_esm.min.js"),
  path.join(VENDOR, "tabulator", "tabulator_esm.min.js"),
);
copyFile(
  path.join(NM, "tabulator-tables", "dist", "css", "tabulator_midnight.min.css"),
  path.join(VENDOR, "tabulator", "tabulator_midnight.min.css"),
);

/* ── GridStack ───────────────────────────────────────────────────── */

console.log("Copying GridStack ...");
const gridstackRoot = path.join(NM, "gridstack", "dist");
copyFile(
  path.join(gridstackRoot, "gridstack-all.js"),
  path.join(VENDOR, "gridstack", "gridstack-all.js"),
);
copyFile(
  path.join(gridstackRoot, "gridstack.min.css"),
  path.join(VENDOR, "gridstack", "gridstack.min.css"),
);

/* ── Cytoscape.js ────────────────────────────────────────────────── */

console.log("Copying Cytoscape.js ...");
copyFile(
  path.join(NM, "cytoscape", "dist", "cytoscape.esm.min.mjs"),
  path.join(VENDOR, "cytoscape", "cytoscape.esm.min.mjs"),
);

/* ── Hotwire Turbo ───────────────────────────────────────────────── */

console.log("Copying Hotwire Turbo ...");
copyFile(
  path.join(NM, "@hotwired", "turbo", "dist", "turbo.es2017-esm.js"),
  path.join(VENDOR, "hotwired", "turbo.es2017-esm.js"),
);

/* ── Hotwire Stimulus ────────────────────────────────────────────── */

console.log("Copying Hotwire Stimulus ...");
copyFile(
  path.join(NM, "@hotwired", "stimulus", "dist", "stimulus.js"),
  path.join(VENDOR, "hotwired", "stimulus.js"),
);

/* ── highlight.js (bundle core + languages) ──────────────────────── */

console.log("Bundling highlight.js ...");
// Copy the CSS theme directly
copyFile(
  path.join(NM, "highlight.js", "styles", "atom-one-dark.min.css"),
  path.join(VENDOR, "highlight.js", "atom-one-dark.min.css"),
);

// Bundle core + needed languages into one browser-ready IIFE
const hljsEntry = `
import hljs from '${path.join(NM, "highlight.js", "lib", "core.js").replace(/\\/g, "/")}';
import bash from '${path.join(NM, "highlight.js", "lib", "languages", "bash.js").replace(/\\/g, "/")}';
import powershell from '${path.join(NM, "highlight.js", "lib", "languages", "powershell.js").replace(/\\/g, "/")}';
import python from '${path.join(NM, "highlight.js", "lib", "languages", "python.js").replace(/\\/g, "/")}';
import go from '${path.join(NM, "highlight.js", "lib", "languages", "go.js").replace(/\\/g, "/")}';
import rust from '${path.join(NM, "highlight.js", "lib", "languages", "rust.js").replace(/\\/g, "/")}';
import javascript from '${path.join(NM, "highlight.js", "lib", "languages", "javascript.js").replace(/\\/g, "/")}';
import typescript from '${path.join(NM, "highlight.js", "lib", "languages", "typescript.js").replace(/\\/g, "/")}';
import json from '${path.join(NM, "highlight.js", "lib", "languages", "json.js").replace(/\\/g, "/")}';
import xml from '${path.join(NM, "highlight.js", "lib", "languages", "xml.js").replace(/\\/g, "/")}';
import css from '${path.join(NM, "highlight.js", "lib", "languages", "css.js").replace(/\\/g, "/")}';
import scss from '${path.join(NM, "highlight.js", "lib", "languages", "scss.js").replace(/\\/g, "/")}';
import yaml from '${path.join(NM, "highlight.js", "lib", "languages", "yaml.js").replace(/\\/g, "/")}';
import markdown from '${path.join(NM, "highlight.js", "lib", "languages", "markdown.js").replace(/\\/g, "/")}';
import sql from '${path.join(NM, "highlight.js", "lib", "languages", "sql.js").replace(/\\/g, "/")}';
import ini from '${path.join(NM, "highlight.js", "lib", "languages", "ini.js").replace(/\\/g, "/")}';
import dockerfile from '${path.join(NM, "highlight.js", "lib", "languages", "dockerfile.js").replace(/\\/g, "/")}';
import makefile from '${path.join(NM, "highlight.js", "lib", "languages", "makefile.js").replace(/\\/g, "/")}';
import diff from '${path.join(NM, "highlight.js", "lib", "languages", "diff.js").replace(/\\/g, "/")}';
import nginx from '${path.join(NM, "highlight.js", "lib", "languages", "nginx.js").replace(/\\/g, "/")}';
import c from '${path.join(NM, "highlight.js", "lib", "languages", "c.js").replace(/\\/g, "/")}';
import cpp from '${path.join(NM, "highlight.js", "lib", "languages", "cpp.js").replace(/\\/g, "/")}';
import csharp from '${path.join(NM, "highlight.js", "lib", "languages", "csharp.js").replace(/\\/g, "/")}';
import java from '${path.join(NM, "highlight.js", "lib", "languages", "java.js").replace(/\\/g, "/")}';
import ruby from '${path.join(NM, "highlight.js", "lib", "languages", "ruby.js").replace(/\\/g, "/")}';
import php from '${path.join(NM, "highlight.js", "lib", "languages", "php.js").replace(/\\/g, "/")}';
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('makefile', makefile);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('nginx', nginx);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('java', java);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('php', php);
globalThis.hljs = hljs;
`;
const hljsTmp = path.join(ROOT, "scripts", "_hljs-entry.ts");
await Bun.write(hljsTmp, hljsEntry);
const hljsBuild = await Bun.build({
  entrypoints: [hljsTmp],
  minify: true,
  target: "browser",
  format: "iife",
});
if (hljsBuild.success) {
  const blob = hljsBuild.outputs[0];
  await Bun.write(path.join(VENDOR, "highlight.js", "highlight.bundle.js"), blob);
} else {
  console.error("highlight.js bundle failed:", hljsBuild.logs);
  process.exit(1);
}
rmSync(hljsTmp, { force: true });

/* ── xterm.js ────────────────────────────────────────────────────── */

console.log("Copying xterm.js ...");
const xtermRoot = path.join(NM, "@xterm");
copyFile(
  path.join(xtermRoot, "xterm", "lib", "xterm.mjs"),
  path.join(VENDOR, "xterm", "xterm.mjs"),
);
copyFile(
  path.join(xtermRoot, "xterm", "css", "xterm.css"),
  path.join(VENDOR, "xterm", "xterm.css"),
);
copyFile(
  path.join(xtermRoot, "addon-fit", "lib", "addon-fit.mjs"),
  path.join(VENDOR, "xterm", "addon-fit.mjs"),
);
copyFile(
  path.join(xtermRoot, "addon-web-links", "lib", "addon-web-links.mjs"),
  path.join(VENDOR, "xterm", "addon-web-links.mjs"),
);

/* ── ansi-to-html (bundle for ESM import) ────────────────────────── */

console.log("Bundling ansi-to-html ...");
const ansiEntry = `
export { default } from '${path.join(NM, "ansi-to-html", "lib", "ansi_to_html.js").replace(/\\/g, "/")}';
`;
const ansiTmp = path.join(ROOT, "scripts", "_ansi-entry.ts");
await Bun.write(ansiTmp, ansiEntry);
const ansiBuild = await Bun.build({
  entrypoints: [ansiTmp],
  minify: true,
  target: "browser",
  format: "esm",
});
if (ansiBuild.success) {
  const blob = ansiBuild.outputs[0];
  await Bun.write(path.join(VENDOR, "ansi-to-html", "ansi-to-html.esm.js"), blob);
} else {
  console.error("ansi-to-html bundle failed:", ansiBuild.logs);
  process.exit(1);
}
rmSync(ansiTmp, { force: true });

/* ── GeoJSON country boundaries ──────────────────────────────────── */

console.log("Downloading countries GeoJSON ...");
const geojsonDest = path.join(VENDOR, "geo-countries", "countries.geojson");
ensureDir(path.dirname(geojsonDest));
try {
  const resp = await fetch(
    "https://cdn.jsdelivr.net/gh/datasets/geo-countries@master/data/countries.geojson",
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  await Bun.write(geojsonDest, resp);
  console.log("  GeoJSON saved (" + ((await Bun.file(geojsonDest).size) / 1024 / 1024).toFixed(1) + " MB)");
} catch (err) {
  console.warn("  WARNING: Could not download GeoJSON. Map features may not work offline.", err);
}

/* ── done ─────────────────────────────────────────────────────────── */

console.log("\n✓ Vendor assets ready in public/vendor/");
