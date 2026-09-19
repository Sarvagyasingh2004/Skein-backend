const ROOT = "/home/ubuntu/apps/backend";
const LOGS = "/home/ubuntu/logs";
const base = {
  exec_mode: "fork", instances: 1, autorestart: true, watch: false,
  time: true, max_restarts: 10, min_uptime: "20s", restart_delay: 4000,
  kill_timeout: 5000, env: { NODE_ENV: "production" },
};
module.exports = { apps: [
  { ...base, name: "user", cwd: `${ROOT}/user`, script: "dist/index.js",
    max_memory_restart: "250M", out_file: `${LOGS}/user-out.log`, error_file: `${LOGS}/user-err.log` },
  { ...base, name: "chat", cwd: `${ROOT}/chat`, script: "dist/index.js",
    max_memory_restart: "300M", out_file: `${LOGS}/chat-out.log`, error_file: `${LOGS}/chat-err.log` },
  { ...base, name: "mail", cwd: `${ROOT}/mail`, script: "dist/index.js",
    max_memory_restart: "200M", out_file: `${LOGS}/mail-out.log`, error_file: `${LOGS}/mail-err.log` },
]};
