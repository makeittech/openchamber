import { Bot, GrammyError } from 'grammy';
import { formatMessage, formatHelpMessage, formatSessionInfo, formatProjectsList, formatSessionsList, formatErrorResponse, formatFileUploadInfo } from './message-formatter.js';

export function createTelegramBot(config) {
  const {
    token,
    allowedUserIds = [],
    adminUserId,
    sessionManager,
    logger = console
  } = config;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const bot = new Bot(token);
  const allowedSet = new Set(allowedUserIds.map(id => String(id)));

  const isAuthorized = (userId) => {
    if (allowedSet.size === 0) {
      return true;
    }
    return allowedSet.has(String(userId));
  };

  const notifyAdmin = async (message) => {
    if (adminUserId) {
      try {
        await bot.api.sendMessage(adminUserId, `⚠️ ${message}`);
      } catch (error) {
        logger.error('[Telegram] Failed to notify admin:', error);
      }
    }
  };

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    
    if (!userId) {
      return;
    }

    if (!isAuthorized(userId)) {
      logger.warn(`[Telegram] Unauthorized access attempt from user ${userId}`);
      await notifyAdmin(`Unauthorized access from user ${userId} (@${ctx.from?.username || 'unknown'})`);
      await ctx.reply('⛔ You are not authorized to use this bot.');
      return;
    }

    return next();
  });

  bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] /start from user ${userId}`);
    
    await ctx.reply(formatHelpMessage(), { parse_mode: 'Markdown' });
  });

  bot.command('opencode', async (ctx) => {
    const userId = ctx.from.id;
    const title = ctx.match || 'Telegram Session';
    
    logger.info(`[Telegram] /opencode from user ${userId}`);

    const result = await sessionManager.createSession(userId, title);
    
    if (result.success) {
      await ctx.reply(formatSessionInfo(result.session), { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.command('prompt', async (ctx) => {
    const userId = ctx.from.id;
    const prompt = ctx.match;

    if (!prompt) {
      await ctx.reply('Usage: /prompt <your message>', { parse_mode: 'Markdown' });
      return;
    }

    logger.info(`[Telegram] /prompt from user ${userId}: ${prompt.slice(0, 50)}...`);

    await ctx.reply('⏳ Thinking...');

    const result = await sessionManager.sendPrompt(userId, prompt);

    if (result.success) {
      const chunks = formatMessage(result.response);
      
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
        await ctx.reply(prefix + chunks[i], { parse_mode: 'Markdown' });
      }
    } else {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.command('endsession', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] /endsession from user ${userId}`);

    const result = await sessionManager.endSession(userId);

    if (result.success) {
      await ctx.reply('✅ Session ended');
    } else {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.command('undo', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] /undo from user ${userId}`);

    const result = await sessionManager.undo(userId);

    if (result.success) {
      await ctx.reply('↩️ ' + result.message);
    } else {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.command('redo', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] /redo from user ${userId}`);

    const result = await sessionManager.redo(userId);

    if (result.success) {
      await ctx.reply('↪️ ' + result.message);
    } else {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.command('projects', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] /projects from user ${userId}`);

    const result = await sessionManager.listProjects(userId);

    if (result.success) {
      await ctx.reply(formatProjectsList(result.projects), { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.command('sessions', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] /sessions from user ${userId}`);

    const result = await sessionManager.listSessions(userId);

    if (result.success) {
      await ctx.reply(formatSessionsList(result.sessions), { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.on('message:document', async (ctx) => {
    const userId = ctx.from.id;
    const document = ctx.message.document;
    
    logger.info(`[Telegram] File upload from user ${userId}: ${document.file_name}`);

    try {
      const file = await ctx.getFile();
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      
      const uploadDir = path.join(os.tmpdir(), 'telegram-uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const filePath = path.join(uploadDir, `${Date.now()}-${document.file_name}`);
      
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(buffer));

      await ctx.reply(formatFileUploadInfo(filePath, document.file_name), { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('[Telegram] Failed to handle file upload:', error);
      await ctx.reply(formatErrorResponse('Failed to upload file'), { parse_mode: 'Markdown' });
    }
  });

  bot.catch((error) => {
    logger.error('[Telegram] Bot error:', error);
  });

  return bot;
}

export async function startTelegramBot(config) {
  const bot = createTelegramBot(config);
  
  try {
    await bot.start({
      onStart: () => {
        config.logger?.info('[Telegram] Bot started successfully');
      }
    });
  } catch (error) {
    config.logger?.error('[Telegram] Failed to start bot:', error);
    throw error;
  }

  return bot;
}
