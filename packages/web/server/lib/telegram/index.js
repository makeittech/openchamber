import { createSessionManager } from './session-manager.js';
import { startTelegramBot, createTelegramBot } from './bot.js';

export function createTelegramBridge(config = {}) {
  const {
    token = process.env.TELEGRAM_BOT_TOKEN,
    allowedUserIds = process.env.ALLOWED_USER_IDS?.split(',').map(id => id.trim()).filter(Boolean) || [],
    adminUserId = process.env.ADMIN_USER_ID,
    opencodeConfig = {
      baseUrl: process.env.OPENCODE_HOST || `http://localhost:${process.env.OPENCODE_PORT || 3000}`,
      port: process.env.OPENCODE_PORT || 3000
    },
    logger = console
  } = config;

  if (!token) {
    logger.info('[Telegram] TELEGRAM_BOT_TOKEN not set, Telegram bridge disabled');
    return null;
  }

  logger.info('[Telegram] Initializing Telegram bridge...');
  logger.info(`[Telegram] Allowed users: ${allowedUserIds.length > 0 ? allowedUserIds.join(', ') : 'all'}`);
  
  if (adminUserId) {
    logger.info(`[Telegram] Admin user: ${adminUserId}`);
  }

  const sessionManager = createSessionManager(opencodeConfig);

  const cleanupInterval = setInterval(() => {
    const cleaned = sessionManager.cleanupInactiveSessions();
    if (cleaned > 0) {
      logger.info(`[Telegram] Cleaned up ${cleaned} inactive sessions`);
    }
  }, 5 * 60 * 1000);

  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return {
    bot: null,
    sessionManager,
    
    async start() {
      this.bot = await startTelegramBot({
        token,
        allowedUserIds,
        adminUserId,
        sessionManager,
        logger
      });
      
      return this.bot;
    },

    async stop() {
      if (cleanupInterval) {
        clearInterval(cleanupInterval);
      }
      
      if (this.bot) {
        this.bot.stop();
        this.bot = null;
      }
    },

    getActiveSessionCount() {
      return sessionManager.getActiveSessionCount();
    }
  };
}

export { createSessionManager } from './session-manager.js';
export { createTelegramBot, startTelegramBot } from './bot.js';
export * from './message-formatter.js';
