// Load .env into a plain object for pm2
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname);
const envPath = path.join(ROOT, ".env");
const envVars = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  line = line.trim();
  if (!line || line.startsWith("#")) return;
  const eq = line.indexOf("=");
  if (eq > 0) envVars[line.slice(0, eq)] = line.slice(eq + 1);
});

module.exports = {
  apps: [
    {
      name: "executor",
      script: "executor/index.js",
      cwd: ROOT,
      env: envVars,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "200M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: path.join(ROOT, "logs", "executor-error.log"),
      out_file: path.join(ROOT, "logs", "executor-out.log"),
      merge_logs: true,
    },
    {
      name: "ws-feed",
      script: "executor/ws-feed.js",
      cwd: ROOT,
      env: envVars,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "200M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: path.join(ROOT, "logs", "ws-feed-error.log"),
      out_file: path.join(ROOT, "logs", "ws-feed-out.log"),
      merge_logs: true,
    },
    {
      name: "event-scanner",
      script: "event-scanner.js",
      cwd: ROOT,
      env: envVars,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "150M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: path.join(ROOT, "logs", "event-scanner-error.log"),
      out_file: path.join(ROOT, "logs", "event-scanner-out.log"),
      merge_logs: true,
    },
  ],
};
