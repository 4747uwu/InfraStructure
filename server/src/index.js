import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { close, connect } from './db.js';

try {
  await connect();
} catch (err) {
  console.error(`\n  Cannot reach MongoDB at ${config.mongoUri}\n  ${err.message}\n`);
  console.error('  Start it with "npm start" from the project root (which launches the bundled mongod),');
  console.error('  or point MONGO_URI in .env at a running server.\n');
  process.exit(1);
}

await bootstrap();

const server = createApp().listen(config.port, () => {
  console.log(`\n  Router Hub is running  ->  http://localhost:${config.port}`);
  console.log(`  Storage: ${config.storageDir}\n`);
});
// Installers are large and links are slow; never time out a transfer that is still moving.
server.requestTimeout = 0;
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `\n  Port ${config.port} is already in use. Change PORT in .env.\n` : err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => close().finally(() => process.exit(0)));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
