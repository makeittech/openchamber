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

Use OpenCode AI from Telegram!

*Commands:*
/start - Show this help
/opencode [title] - Start OpenCode session
/prompt <text> - Send prompt to OpenCode
/endsession - End current session
/undo - Undo last change
/redo - Redo change
/projects - List projects
/sessions - List sessions

*Tips:*
• Each user has their own isolated session
• Sessions persist until you end them or they timeout
• Send any file to upload it (saved to /tmp/telegram-uploads/)`;
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
    lines.push(`${index + 1}. ${project.name || project.path || 'Unnamed'}`);
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
