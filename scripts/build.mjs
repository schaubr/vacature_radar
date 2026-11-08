import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const common = { bundle: true, sourcemap: true, logLevel: "info" };

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main/index.js",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload/index.js",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: { app: "src/renderer/main.tsx" },
    outdir: "dist/renderer",
    platform: "browser",
    format: "iife",
    target: "chrome152",
    jsx: "automatic",
    loader: { ".css": "css" },
    define: { "process.env.NODE_ENV": '"production"' },
  }),
]);

mkdirSync("dist/renderer", { recursive: true });
copyFileSync("src/renderer/index.html", "dist/renderer/index.html");
