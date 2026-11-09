// `npm start`: on macOS, package the app (unsigned dir build, ad-hoc identity) and open it, so the Dock and menu bar
// show "Vacature Radar" instead of "Electron". Elsewhere, fall back to the development run.
import { spawnSync } from "node:child_process";

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (process.platform !== "darwin") {
  run("npm", ["run", "dev"]);
} else {
  console.log("Packaging Vacature Radar so macOS shows its name in the Dock and menu bar...");
  run("npm", ["run", "build"]);
  run("npx", ["electron-builder", "--mac", "--arm64", "--dir"]);
  run("open", ["-n", "release/mac-arm64/Vacature Radar.app"]);
}
