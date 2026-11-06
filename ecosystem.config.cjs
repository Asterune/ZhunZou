/**
 * PM2 process file for single-host deployment.
 *
 * IMPORTANT: keep instances at 1. Long polling is woken by an in-process
 * EventEmitter; running multiple instances would split the waiters.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 reload ecosystem.config.cjs --update-env
 *   pm2 logs zhunzou
 */
module.exports = {
  apps: [
    {
      name: 'zhunzou',
      script: 'packages/server/dist/main.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      // PM2 SIGKILLs after this; the server drains held long polls in ~1s and
      // caps its own shutdown at 10s, so the gap is room, not a wait.
      kill_timeout: 12000,
      time: true,
      merge_logs: true,
      out_file: './logs/zhunzou.out.log',
      error_file: './logs/zhunzou.err.log',
      env: {
        NODE_ENV: 'production',
        PORT: '8787',
        // Bind to localhost and put nginx / caddy in front.
        // Change to 0.0.0.0 only if you have a firewall or private network.
        HOST: '127.0.0.1',
        SERVE_WEB: 'true',
      },
    },
  ],
};
