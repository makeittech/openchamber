import { Bot, GrammyError } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { formatMessage, formatHelpMessage, formatWelcomeMessage, formatSessionInfo, formatProjectsList, formatSessionsList, formatErrorResponse, formatFileUploadInfo, formatProvidersList, formatModelsList, formatModelSelected, formatSessionResumed, formatProjectSessionCreated, formatFreeSessionCreated } from './message-formatter.js';

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

  bot.catch((err) => {
    const desc = err?.description || err?.message || '';
    if (desc.includes('message is not modified')) {
      return;
    }
    logger.error('[Telegram] Bot error:', err);
  });

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
    
    const session = sessionManager.getSession(userId);
    if (session) {
      await ctx.reply(formatHelpMessage(), { parse_mode: 'Markdown' });
    } else {
      const keyboard = new InlineKeyboard()
        .text('📁 Open a project', 'onboard:projects').row()
        .text('💬 Resume a session', 'onboard:sessions').row()
        .text('🆓 Chat freely', 'onboard:free').row();

      await ctx.reply(formatWelcomeMessage(), {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
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

  bot.command('models', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] /models from user ${userId}`);

    const result = await sessionManager.listProviders(userId);

    if (!result.success) {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
      return;
    }

    const keyboard = new InlineKeyboard();
    result.providers.forEach((provider) => {
      keyboard.text(provider.name, `provider:${provider.id}`).row();
    });

    const currentModel = result.currentModel 
      ? `\n\n*Current:* ${result.currentModel.providerId}/${result.currentModel.modelId}`
      : '';

    await ctx.reply(formatProvidersList(result.providers) + currentModel, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  });

  bot.callbackQuery(/^provider:(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const providerId = ctx.match[1];
    logger.info(`[Telegram] Provider selected by user ${userId}: ${providerId}`);

    const result = await sessionManager.listProviders(userId);

    if (!result.success) {
      await ctx.answerCallbackQuery(result.error);
      return;
    }

    const provider = result.providers.find(p => p.id === providerId);
    if (!provider) {
      await ctx.answerCallbackQuery('Provider not found');
      return;
    }

    const keyboard = new InlineKeyboard();
    provider.models.forEach((model) => {
      keyboard.text(model.name || model.id, `model:${providerId}:${model.id}`).row();
    });
    keyboard.text('← Back to providers', 'back:providers').row();

    await ctx.editMessageText(formatModelsList(provider), {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^model:(.+?):(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const providerId = ctx.match[1];
    const modelId = ctx.match[2];
    logger.info(`[Telegram] Model selected by user ${userId}: ${providerId}/${modelId}`);

    const result = sessionManager.setSessionModel(userId, providerId, modelId);

    if (!result.success) {
      await ctx.answerCallbackQuery(result.error);
      return;
    }

    await ctx.editMessageText(formatModelSelected(providerId, modelId), {
      parse_mode: 'Markdown'
    });
    await ctx.answerCallbackQuery(`Model switched to ${providerId}/${modelId}`);
  });

  bot.callbackQuery('back:providers', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] Back to providers from user ${userId}`);

    const result = await sessionManager.listProviders(userId);

    if (!result.success) {
      await ctx.answerCallbackQuery(result.error);
      return;
    }

    const keyboard = new InlineKeyboard();
    result.providers.forEach((provider) => {
      keyboard.text(provider.name, `provider:${provider.id}`).row();
    });

    const currentModel = result.currentModel 
      ? `\n\n*Current:* ${result.currentModel.providerId}/${result.currentModel.modelId}`
      : '';

    await ctx.editMessageText(formatProvidersList(result.providers) + currentModel, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    await ctx.answerCallbackQuery();
  });

  // Helper: send pending message after session creation
  const processPendingMessage = async (ctx, userId) => {
    const pending = sessionManager.getPendingMessage(userId);
    if (!pending) return;

    const thinkingMessage = await ctx.reply('⏳ Thinking...');
    const result = await sessionManager.sendPrompt(userId, pending, async (statusText) => {
      try {
        await ctx.api.editMessageText(ctx.chat.id, thinkingMessage.message_id, statusText);
      } catch (err) {
        // Ignore "message is not modified" errors
      }
    });

    try {
      await ctx.api.deleteMessage(ctx.chat.id, thinkingMessage.message_id);
    } catch (err) {}

    if (result.success) {
      const chunks = formatMessage(result.response);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
        try {
          await ctx.reply(prefix + chunks[i], { parse_mode: 'Markdown' });
        } catch (err) {
          logger.warn(`[Telegram] Markdown parse failed for chunk ${i+1}/${chunks.length}. Sending plain text. Error: ${err.message}`);
          await ctx.reply(prefix + chunks[i]);
        }
      }
    } else {
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  };

  // --- Onboarding callback handlers ---

  // Temporary storage for project lists shown to users (for callback lookup)
  const pendingProjectLists = new Map();

  bot.callbackQuery('onboard:projects', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] onboard:projects from user ${userId}`);

    const result = await sessionManager.listProjects(userId);

    if (!result.success || !result.projects || result.projects.length === 0) {
      await ctx.editMessageText('No projects found. Starting a free chat instead...');
      await ctx.answerCallbackQuery();

      const createResult = await sessionManager.createFreeSession(userId);
      if (createResult.success) {
        await ctx.reply(formatFreeSessionCreated(), { parse_mode: 'Markdown' });
        await processPendingMessage(ctx, userId);
      } else {
        await ctx.reply(formatErrorResponse(createResult.error), { parse_mode: 'Markdown' });
      }
      return;
    }

    const projects = Array.isArray(result.projects) ? result.projects : [];
    // Store the list for lookup when user picks one
    pendingProjectLists.set(userId, projects);

    const keyboard = new InlineKeyboard();
    projects.slice(0, 15).forEach((project, index) => {
      const name = project.label || project.name || 'Unnamed';
      keyboard.text(`📁 ${name}`, `pick_project:${index}`).row();
    });
    keyboard.text('🆓 Chat freely instead', 'onboard:free').row();

    await ctx.editMessageText(formatProjectsList(projects), {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^pick_project:(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const projectIndex = parseInt(ctx.match[1], 10);
    logger.info(`[Telegram] pick_project from user ${userId}: index ${projectIndex}`);

    const projects = pendingProjectLists.get(userId);
    if (!projects || !projects[projectIndex]) {
      await ctx.answerCallbackQuery('Project list expired. Please try again.');
      return;
    }

    const project = projects[projectIndex];
    const projectPath = project.path || project.worktree || '';
    const projectName = project.label || project.name || 'Project';
    pendingProjectLists.delete(userId);

    const result = await sessionManager.createSessionWithProject(userId, projectPath, projectName);

    if (result.success) {
      await ctx.editMessageText(formatProjectSessionCreated(projectName), { parse_mode: 'Markdown' });
      await ctx.answerCallbackQuery(`Project: ${projectName}`);
      await processPendingMessage(ctx, userId);
    } else {
      await ctx.answerCallbackQuery(result.error);
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.callbackQuery('onboard:sessions', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] onboard:sessions from user ${userId}`);

    const result = await sessionManager.listSessions(userId);

    if (!result.success) {
      await ctx.editMessageText('Could not fetch sessions. Starting a free chat instead...');
      await ctx.answerCallbackQuery();

      const createResult = await sessionManager.createFreeSession(userId);
      if (createResult.success) {
        await ctx.reply(formatFreeSessionCreated(), { parse_mode: 'Markdown' });
        await processPendingMessage(ctx, userId);
      } else {
        await ctx.reply(formatErrorResponse(createResult.error), { parse_mode: 'Markdown' });
      }
      return;
    }

    const sessions = Array.isArray(result.sessions) ? result.sessions : [];

    if (sessions.length === 0) {
      await ctx.editMessageText('No previous sessions found. Starting a free chat instead...');
      await ctx.answerCallbackQuery();

      const createResult = await sessionManager.createFreeSession(userId);
      if (createResult.success) {
        await ctx.reply(formatFreeSessionCreated(), { parse_mode: 'Markdown' });
        await processPendingMessage(ctx, userId);
      } else {
        await ctx.reply(formatErrorResponse(createResult.error), { parse_mode: 'Markdown' });
      }
      return;
    }

    const keyboard = new InlineKeyboard();
    sessions.slice(0, 15).forEach((session) => {
      const title = session.title || 'Untitled';
      const shortId = session.id ? session.id.slice(0, 8) : '?';
      keyboard.text(`💬 ${title} (${shortId})`, `pick_session:${session.id}`).row();
    });
    keyboard.text('🆓 Chat freely instead', 'onboard:free').row();

    await ctx.editMessageText(formatSessionsList(sessions), {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^pick_session:(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const sessionId = ctx.match[1];
    logger.info(`[Telegram] pick_session from user ${userId}: ${sessionId}`);

    const result = await sessionManager.resumeSession(userId, sessionId);

    if (result.success) {
      await ctx.editMessageText(formatSessionResumed(result.session), { parse_mode: 'Markdown' });
      await ctx.answerCallbackQuery('Session resumed!');
      await processPendingMessage(ctx, userId);
    } else {
      await ctx.answerCallbackQuery(result.error);
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  bot.callbackQuery('onboard:free', async (ctx) => {
    const userId = ctx.from.id;
    logger.info(`[Telegram] onboard:free from user ${userId}`);

    const result = await sessionManager.createFreeSession(userId);

    if (result.success) {
      await ctx.editMessageText(formatFreeSessionCreated(), { parse_mode: 'Markdown' });
      await ctx.answerCallbackQuery('Free chat started!');
      await processPendingMessage(ctx, userId);
    } else {
      await ctx.answerCallbackQuery(result.error);
      await ctx.reply(formatErrorResponse(result.error), { parse_mode: 'Markdown' });
    }
  });

  // --- Main text handler ---

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text?.trim();
    if (!text) return;

    const session = sessionManager.getSession(userId);

    if (!session) {
      // No session yet — store message and show onboarding
      logger.info(`[Telegram] New user message without session from ${userId}, showing onboarding`);
      sessionManager.storePendingMessage(userId, text);

      const keyboard = new InlineKeyboard()
        .text('📁 Open a project', 'onboard:projects').row()
        .text('💬 Resume a session', 'onboard:sessions').row()
        .text('🆓 Chat freely', 'onboard:free').row();

      await ctx.reply(formatWelcomeMessage(), {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      return;
    }

    // Session exists — send directly
    logger.info(`[Telegram] message from user ${userId}: ${text.slice(0, 50)}...`);
    const thinkingMessage = await ctx.reply('⏳ Thinking...');

    const result = await sessionManager.sendPrompt(userId, text, async (statusText) => {
      try {
        await ctx.api.editMessageText(ctx.chat.id, thinkingMessage.message_id, statusText);
      } catch (err) {
        // Ignore "message is not modified" errors
      }
    });

    try {
      await ctx.api.deleteMessage(ctx.chat.id, thinkingMessage.message_id);
    } catch (err) {}

    if (result.success) {
      const chunks = formatMessage(result.response);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
        try {
          await ctx.reply(prefix + chunks[i], { parse_mode: 'Markdown' });
        } catch (err) {
          logger.warn(`[Telegram] Markdown parse failed for chunk ${i+1}/${chunks.length}. Sending plain text. Error: ${err.message}`);
          await ctx.reply(prefix + chunks[i]);
        }
      }
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

      const rawName = typeof document.file_name === 'string' ? document.file_name : 'document';
      const safeName = path.basename(rawName).replace(/[\0\\/]/g, '') || 'document';
      const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
      
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
