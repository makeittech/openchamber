# Telegram Bridge

Optional Telegram bot integration for OpenChamber, allowing users to interact with OpenCode AI from Telegram.

## Features

- 🤖 Full OpenCode AI access via Telegram
- 💬 Per-user isolated sessions
- 📁 File upload support
- 🔄 Session management (undo/redo)
- 🔒 User authorization via allowed user IDs
- 🧹 Automatic cleanup of inactive sessions

## Setup

### Environment Variables

```bash
# Required - Get from @BotFather on Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Optional - Comma-separated list of allowed Telegram user IDs
ALLOWED_USER_IDS=123456789,987654321

# Optional - Admin user ID for notifications
ADMIN_USER_ID=123456789

# Optional - Disable Telegram bridge
OPENCHAMBER_SKIP_TELEGRAM=1
```

### Getting Your Bot Token

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the instructions
3. Copy the bot token you receive

### Finding Your Telegram User ID

1. Start the bot (even without ALLOWED_USER_IDS configured)
2. Send any message to your bot
3. The bot will reply with your User ID
4. Add that ID to `ALLOWED_USER_IDS`
5. Restart the bot

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help message |
| `/opencode [title]` | Start OpenCode session |
| `/prompt <text>` | Send prompt to OpenCode |
| `/endsession` | End current session |
| `/undo` | Undo last change |
| `/redo` | Redo change |
| `/projects` | List projects |
| `/sessions` | List sessions |

## Usage

### Starting a Session

```
You: /opencode My Project

Bot: ✅ Session Active
ID: abc123...
Title: My Project
Age: 0m 0s
```

### Sending Prompts

```
You: /prompt Create a function to calculate factorial

Bot: ⏳ Thinking...

Bot: Here's a factorial function in JavaScript:

function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
```

### File Uploads

Send any file to the bot:
- Files are saved to `/tmp/telegram-uploads/`
- Bot replies with the file path
- Reference the file in your prompts

### Ending a Session

```
You: /endsession

Bot: ✅ Session ended
```

## Architecture

```
packages/web/server/lib/telegram/
├── index.js              # Main entry point
├── bot.js                # Grammy bot setup and handlers
├── session-manager.js    # Per-user session management
├── message-formatter.js  # Format responses for Telegram
└── __tests__/            # Test files
```

### Session Management

- Each Telegram user gets their own isolated OpenCode session
- Sessions persist until explicitly ended or timeout (30 min inactivity)
- Automatic cleanup runs every 5 minutes

### Integration

The Telegram bridge is automatically initialized when:
1. `TELEGRAM_BOT_TOKEN` is set
2. `OPENCHAMBER_SKIP_TELEGRAM` is not set to `1`
3. OpenCode server is ready

It connects to the same OpenCode instance as the web UI.

## Security

- Only authorized users can interact with the bot
- Unauthorized access attempts are logged and admin is notified
- Sessions are user-isolated
- No credentials are stored in the bot

## Development

### Running Tests

```bash
bun test packages/web/server/lib/telegram/__tests__/
```

### Local Testing

1. Create a test bot with @BotFather
2. Set environment variables
3. Start OpenChamber: `bun run dev:web:server`
4. Message your bot on Telegram

## Troubleshooting

### Bot not responding

1. Check `TELEGRAM_BOT_TOKEN` is set correctly
2. Verify your user ID is in `ALLOWED_USER_IDS`
3. Check server logs for errors
4. Ensure OpenCode server is running

### Session errors

1. Use `/endsession` to clear stuck sessions
2. Restart the bot if issues persist
3. Check OpenCode server logs

### File upload issues

1. Check `/tmp/telegram-uploads/` directory exists
2. Verify disk space
3. Check file size limits (Telegram: 50MB)
