/**
 * PM2 process definition for the Zennara API.
 *
 * `pm2 reload ecosystem.config.js --update-env` is what the deploy script
 * runs after every pull — a zero-downtime restart that picks up .env changes.
 */
module.exports = {
  apps: [
    {
      name: 'zennara-api',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
