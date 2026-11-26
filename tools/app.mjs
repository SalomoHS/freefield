// pnpm app                 start Freefield on this PC: ComfyUI, proxy, gateway and the studio on :3010
// pnpm app <id> [...]      run one app from the terminal (server/cli.ts app)
// The local stack lives outside the repo, in ../freefield-local (set FREEFIELD_LOCAL to use another folder).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let args = process.argv.slice(2);
if (args[0] === "--") args = args.slice(1); // pnpm hands the "--" over, npm does not

let command;
if (args[0] && !args[0].startsWith("-")) {
  const flags = ["--env-file-if-exists=.env", "--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
  command = [process.execPath, [...flags, "server/cli.ts", "app", ...args]];
} else {
  const local = process.env.FREEFIELD_LOCAL || join(root, "..", "freefield-local");
  const script = join(local, "start-local.ps1");
  if (!existsSync(script)) {
    console.error(`no local backend: ${script} is missing.\nSet it up (tools/local_backend.py), or run only the studio with: pnpm serve`);
    process.exit(1);
  }
  console.log('starting Freefield: open http://127.0.0.1:3010 once it says "ready" (Ctrl+C stops everything)');
  command = ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]];
}

process.on("SIGINT", () => {}); // Ctrl+C reaches the child too: wait while it shuts down
const child = spawn(command[0], command[1], { cwd: root, stdio: "inherit" });
child.on("error", (e) => {
  console.error(`could not start ${command[0]}: ${e.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
