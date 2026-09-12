import { configuration } from './config.js';
import { createApp } from './app.js';

const config = configuration();
const { server, store } = createApp(config);
server.listen(config.port, config.host, () => {
  console.log(`Aubeig Games & Bio — port ${server.address().port}`);
  console.log(
    'Wallet: practice only. Telegram:',
    config.telegramToken && config.telegramUsername ? 'configured' : 'not configured',
  );
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
}
