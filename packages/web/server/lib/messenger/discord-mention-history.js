/**
 * When a user @mentions the OpenChamber bot, they can ask it to read recent
 * channel messages as context:
 *   - empty body after the mention → read the previous message only
 *   - leading integer N → read the last N messages (optional prompt after)
 *   - any other text → normal prompt, no channel-history fetch
 */

export const MENTION_HISTORY_MAX = 50;

/**
 * @param {string} text - message body after the bot mention has been stripped
 * @returns {{ historyCount: number|null, prompt: string }}
 */
export function parseMentionHistoryRequest(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return { historyCount: 1, prompt: '' };
  }

  const onlyNumber = trimmed.match(/^(\d{1,3})$/);
  if (onlyNumber) {
    return { historyCount: clampHistoryCount(onlyNumber[1]), prompt: '' };
  }

  const numberAndPrompt = trimmed.match(/^(\d{1,3})\s+([\s\S]+)$/);
  if (numberAndPrompt) {
    return {
      historyCount: clampHistoryCount(numberAndPrompt[1]),
      prompt: numberAndPrompt[2].trim(),
    };
  }

  return { historyCount: null, prompt: trimmed };
}

function clampHistoryCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MENTION_HISTORY_MAX, Math.floor(n));
}

/**
 * Format Discord REST message objects (newest-first) into a prompt prefix.
 *
 * @param {object} args
 * @param {Array<object>} args.messages - Discord message objects, newest first
 * @param {string} [args.userPrompt]
 * @returns {string}
 */
export function formatChannelHistoryPrompt({ messages, userPrompt = '' } = {}) {
  const chronological = Array.isArray(messages) ? [...messages].reverse() : [];
  const lines = [];
  for (const msg of chronological) {
    const author =
      msg?.author?.global_name ||
      msg?.author?.username ||
      (msg?.author?.bot ? 'bot' : 'user');
    const content = typeof msg?.content === 'string' ? msg.content.trim() : '';
    const attachmentCount = Array.isArray(msg?.attachments) ? msg.attachments.length : 0;
    const attachmentNote =
      attachmentCount > 0
        ? `${content ? ' ' : ''}[${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}]`
        : '';
    const body = `${content}${attachmentNote}`.trim();
    if (!body) continue;
    lines.push(`${author}: ${body}`);
  }

  const historyBlock = lines.length > 0 ? lines.join('\n') : '';
  const prompt = typeof userPrompt === 'string' ? userPrompt.trim() : '';

  if (!historyBlock && !prompt) return '';
  if (!historyBlock) return prompt;
  if (!prompt) {
    return [
      'Recent channel messages:',
      historyBlock,
      '',
      'Respond to the conversation above.',
    ].join('\n');
  }
  return [
    'Recent channel messages:',
    historyBlock,
    '',
    'User request:',
    prompt,
  ].join('\n');
}
