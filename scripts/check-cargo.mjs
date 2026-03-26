import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const winCargo = join(homedir(), ".cargo", "bin", "cargo.exe");
const unixCargo = join(homedir(), ".cargo", "bin", "cargo");

function tryCargo(cmd, args, shell) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    shell: shell ?? false,
  });
}

let r = tryCargo("cargo", ["--version"], process.platform === "win32");
if (r.status !== 0 && process.platform !== "win32") {
  r = tryCargo("cargo", ["--version"], true);
}
if (r.status === 0) process.exit(0);

const fallback = process.platform === "win32" ? winCargo : unixCargo;
if (existsSync(fallback)) {
  r = spawnSync(fallback, ["--version"], { encoding: "utf8" });
  if (r.status === 0) {
    console.error(
      "\n[!] Rust is installed but `cargo` is not on your PATH.\n" +
        "    Add this folder to PATH, then reopen the terminal:\n" +
        `    ${join(homedir(), ".cargo", "bin")}\n`,
    );
    process.exit(1);
  }
}

console.error(
  "\n[!] Cargo was not found. Tauri needs Rust.\n" +
    "    1) Install: https://rustup.rs\n" +
    "    2) Restart the terminal (or VS Code)\n" +
    "    3) Run: npm run desktop\n",
);
process.exit(1);
