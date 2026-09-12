import { resolve } from 'node:path';

export function configuration(env = process.env) {
  const config = {
    port: Number(env.PORT || 8000),
    host: env.HOST || '0.0.0.0',
    landingPage: env.LANDING_PAGE === 'bio' ? 'bio' : 'games',
    databasePath:
      env.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(env.DATABASE_PATH || 'data/aubeig.sqlite'),
    publicOrigin: env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : '',
    production: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY === 'true',
    embeddedPreview: env.EMBEDDED_PREVIEW === 'true',
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramUsername: (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
    walletProvider: env.WALLET_PROVIDER || 'local',
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error('Invalid PORT');
  if (config.production && !config.publicOrigin.startsWith('https://'))
    throw new Error('PUBLIC_ORIGIN must be HTTPS in production');
  if (config.walletProvider !== 'local')
    throw new Error('The Violas integration is not configured. Select the local practice wallet explicitly.');
  return config;
}
