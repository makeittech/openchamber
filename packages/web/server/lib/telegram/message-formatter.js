const MAX_MESSAGE_LENGTH = 4096;

export function formatMessage(text) {
  if (!text || typeof text !== 'string') {
    return ['No content'];
  }

  if (text.length <= MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitPoint = MAX_MESSAGE_LENGTH;
    
    const codeBlockMatch = remaining.lastIndexOf('\n```\n', MAX_MESSAGE_LENGTH);
    if (codeBlockMatch > MAX_MESSAGE_LENGTH * 0.5) {
      splitPoint = codeBlockMatch + 4;
    } else {
      const paragraphBreak = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
      if (paragraphBreak > MAX_MESSAGE_LENGTH * 0.5) {
        splitPoint = paragraphBreak + 2;
      } else {
        const lineBreak = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
        if (lineBreak > MAX_MESSAGE_LENGTH * 0.5) {
          splitPoint = lineBreak + 1;
        }
      }
    }

    chunks.push(remaining.slice(0, splitPoint));
    remaining = remaining.slice(splitPoint);
  }

  return chunks;
}

export function formatHelpMessage() {
  return `🤖 *OpenChamber Telegram Bot*

Just send me a message and I'll help you right away!

*Commands:*
/start - Show this help
/opencode [title] - Start a named session
/models - Switch AI model for session
/endsession - End current session
/undo - Undo last change
/redo - Redo change
/projects - List projects
/sessions - List sessions

*Tips:*
• Send any message to start — I'll ask how you want to work
• Pick a project, resume a session, or just chat freely
• Each user has their own isolated session
• Sessions persist until you end them or they timeout
• Send any file to upload it (saved to /tmp/telegram-uploads/)`;
}

export function formatWelcomeMessage() {
  return `👋 *Welcome!*

How would you like to work?

📁 *Open a project* — work within a specific project directory
💬 *Resume a session* — continue a previous conversation
🆓 *Chat freely* — just talk, no project context`;
}

export function formatSessionInfo(session) {
  if (!session) {
    return 'No active session';
  }

  const age = Math.floor((Date.now() - session.createdAt) / 1000);
  const minutes = Math.floor(age / 60);
  const seconds = age % 60;

  return `✅ *Session Active*
ID: \`${session.id}\`
Title: ${session.title}
Age: ${minutes}m ${seconds}s`;
}

export function formatProjectsList(projects) {
  if (!projects || projects.length === 0) {
    return 'No projects found';
  }

  const lines = ['📁 *Projects*\n'];
  projects.slice(0, 20).forEach((project, index) => {
    const name = project.label || project.name || project.path || project.worktree || 'Unnamed';
    const path = project.path || project.worktree || '';
    lines.push(`${index + 1}. *${name}*`);
    if (path && path !== name) {
      lines.push(`   \`${path}\``);
    }
  });

  if (projects.length > 20) {
    lines.push(`\n_...and ${projects.length - 20} more_`);
  }

  return lines.join('\n');
}

export function formatSessionsList(sessions) {
  if (!sessions || sessions.length === 0) {
    return 'No sessions found';
  }

  const lines = ['💬 *Sessions*\n'];
  sessions.slice(0, 20).forEach((session, index) => {
    const title = session.title || 'Untitled';
    const id = session.id ? `\`${session.id.slice(0, 8)}\`` : 'N/A';
    lines.push(`${index + 1}. ${title} ${id}`);
  });

  if (sessions.length > 20) {
    lines.push(`\n_...and ${sessions.length - 20} more_`);
  }

  return lines.join('\n');
}

export function formatErrorResponse(error) {
  const message = typeof error === 'string' ? error : error.message || 'Unknown error';
  return `❌ *Error*\n\n${escapeMarkdown(message)}`;
}

export function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

export function formatFileUploadInfo(filePath, originalName) {
  return `📄 *File Uploaded*
Original: ${originalName}
Saved to: \`${filePath}\`

You can reference this file in your prompts.`;
}

export function formatProvidersList(providers) {
  if (!providers || providers.length === 0) {
    return 'No providers configured';
  }

  const lines = ['🤖 *Select a Provider*\n'];
  providers.forEach((provider, index) => {
    const modelCount = provider.models?.length || 0;
    lines.push(`${index + 1}. ${provider.name} (${modelCount} models)`);
  });

  return lines.join('\n');
}

export function formatModelsList(provider) {
  if (!provider || !provider.models || provider.models.length === 0) {
    return `No models available for ${provider?.name || 'this provider'}`;
  }

  const lines = [`🤖 *${provider.name} Models*\n`];
  provider.models.forEach((model, index) => {
    lines.push(`${index + 1}. ${model.name || model.id}`);
  });

  return lines.join('\n');
}

export function formatModelSelected(providerId, modelId) {
  return `✅ *Model Changed*

Provider: ${providerId}
Model: ${modelId}

This model will be used for future prompts in this session.`;
}

export function formatSessionResumed(session) {
  return `🔄 *Session Resumed*
Title: ${session.title || 'Untitled'}
ID: \`${session.id}\``;
}

export function formatProjectSessionCreated(projectName) {
  return `📁 *Project Session Started*
Project: ${projectName}`;
}

export function formatFreeSessionCreated() {
  return `🆓 *Free Chat Started*
No project context — just chatting!`;
}
