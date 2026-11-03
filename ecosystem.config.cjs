// pm2 settings for the worker on the VPS:  pm2 start ecosystem.config.cjs
// Keeps one worker running, restarts it if it crashes, and gives it 30 s to finish
// the batch in hand when stopped or restarted (unfinished rows return to the queue anyway).
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

// Bun installs into ~/.bun/bin, which isn't on PATH when pm2 restarts things after a reboot.
const homeBun = join(homedir(), ".bun", "bin", "bun");
const bun = process.env.BUN_PATH || (existsSync(homeBun) ? homeBun : "bun");

module.exports = {
  apps: [
    {
      name: "blitz-worker",
      script: "scripts/worker.ts",
      interpreter: bun,
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 30000,
      max_memory_restart: "800M",
      time: true, // timestamps in `pm2 logs`
      env: { NODE_ENV: "production", JOB_FILES: "off" },
    },
  ],
};
