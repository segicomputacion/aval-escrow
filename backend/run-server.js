const { spawn } = require('child_process');
const path = require('path');
const dir = __dirname;
const env = { ...process.env };
env.PORT = '3002';
env.NODE_ENV = 'development';
env.ADMIN_PASSWORD = 'smoke-admin-pwd';
env.DB_PATH = path.join(dir, '..', 'smoke-db.json');
spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: 'inherit' });
