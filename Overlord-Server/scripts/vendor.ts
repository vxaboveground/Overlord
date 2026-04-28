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
copyDir(
  path.join(NM, "ace-builds", "src-min-noconflict"),
  path.join(VENDOR, "ace-builds"),
);

/* ── Chart.js ────────────────────────────────────────────────────── */

console.log("Copying Chart.js ...");
copyFile(
  path.join(NM, "chart.js", "dist", "chart.umd.js"),
  path.join(VENDOR, "chart.js", "chart.umd.js"),
);

/* ── Leaflet ─────────────────────────────────────────────────────── */

console.log("Copying Leaflet ...");
const leafRoot = path.join(NM, "leaflet", "dist");
copyFile(path.join(leafRoot, "leaflet.js"), path.join(VENDOR, "leaflet", "leaflet.js"));
copyFile(path.join(leafRoot, "leaflet.css"), path.join(VENDOR, "leaflet", "leaflet.css"));
if (existsSync(path.join(leafRoot, "images"))) {
  copyDir(path.join(leafRoot, "images"), path.join(VENDOR, "leaflet", "images"));
}

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
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
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
