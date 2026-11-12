// Windows "Application Control" (Smart App Control / WDAC) can block rollup's native .node binary,
// which makes `vite build` and `vitest` fail with ERR_DLOPEN_FAILED. This swaps node_modules/rollup for
// the pure-WASM build (@rollup/wasm-node, same version, same API). Safe to re-run. Local to node_modules.
//
//   npm run fix-rollup -w scripts
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rollupDir = join(root, "node_modules", "rollup");
if (!existsSync(rollupDir)) { console.log("rollup is not installed; run npm install first."); process.exit(0); }

const pkg = JSON.parse(readFileSync(join(rollupDir, "package.json"), "utf8"));
if (pkg.name === "@rollup/wasm-node") { console.log("Already using @rollup/wasm-node."); process.exit(0); }

// Does the native binary load?
try {
  createRequire(join(rollupDir, "package.json"))("./dist/native.js");
  console.log("Native rollup loads fine; nothing to do.");
  process.exit(0);
} catch (e) {
  console.log(`Native rollup failed to load (${e.code ?? e.message}). Installing @rollup/wasm-node@${pkg.version}...`);
}

const tmp = mkdtempSync(join(tmpdir(), "rollup-wasm-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const out = execFileSync(npm, ["pack", `@rollup/wasm-node@${pkg.version}`, "--silent"], { cwd: tmp, encoding: "utf8", shell: process.platform === "win32" }).trim().split(/\r?\n/).pop();
  execFileSync("tar", ["xzf", out], { cwd: tmp });
  rmSync(rollupDir, { recursive: true, force: true });
  cpSync(join(tmp, "package"), rollupDir, { recursive: true });
  console.log("Replaced node_modules/rollup with @rollup/wasm-node. vite and vitest should work now.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
