// Everything local development needs, in one terminal:
//
//   npm run dev:all
//
// the site (Vite), the API (the Node server) and online play (the Worker),
// each line tagged with where it came from. Ctrl-C stops all three.

import { spawn } from "node:child_process";

const parts = [
  { name: "site", colour: 36, script: "dev" },
  { name: "api", colour: 35, script: "dev:server" },
  { name: "online", colour: 33, script: "dev:online" },
];

const children = parts.map(({ name, colour, script }) => {
  const child = spawn("npm", ["run", "--silent", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "1" } });
  const tag = `\u001b[${colour}m${name.padEnd(6)}\u001b[0m│ `;
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.on("data", (chunk) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(tag + line + "\n");
    });
  }
  child.on("exit", (code) => process.stdout.write(`${tag}stopped${code ? ` (exit ${code})` : ""}\n`));
  return child;
});

const stop = () => {
  for (const child of children) child.kill("SIGINT");
  setTimeout(() => process.exit(0), 1_500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
