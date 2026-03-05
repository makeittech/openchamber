---
name: cron
description: Control cron job scheduler - list, add, update, remove, and run scheduled jobs
license: MIT
compatibility: opencode
---

# Cron Job Control Skill

## Purpose

This skill provides tools for managing cron jobs in OpenChamber. It allows the agent to create, list, update, delete, and run scheduled tasks.

## Available Tools

### 1. list_cron_jobs

List all configured cron jobs.

**Usage:**
```
Use the list_cron_jobs tool to see all scheduled jobs.
```

**Returns:** Array of job objects with:
- `jobId`: Unique identifier
- `name`: Job name
- `description`: Optional description
- `schedule`: Schedule configuration (at/every/cron)
- `sessionTarget`: "main" or "isolated"
- `payload`: Job payload configuration
- `enabled`: Whether job is active

### 2. add_cron_job

Create a new cron job.

**Parameters:**
- `name` (required): Job name
- `description` (optional): Job description
- `schedule` (required): Schedule object with:
  - `kind`: "at" | "every" | "cron"
  - For "at": `at` - ISO date string
  - For "every": `everyMs` - interval in milliseconds
  - For "cron": `expr` - cron expression, optional `tz` timezone
- `sessionTarget` (required): "main" or "isolated"
- `payload` (required): Payload object with:
  - `kind`: "systemEvent" | "agentTurn"
  - For "systemEvent": `text` - event text
  - For "agentTurn": `message` - message text, optional `model`

**Example:**
```json
{
  "name": "Daily report",
  "description": "Generate daily status report",
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * *",
    "tz": "America/New_York"
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "Generate a daily status report of recent activity."
  }
}
```

### 3. update_cron_job

Update an existing cron job.

**Parameters:**
- `jobId` (required): Job ID to update
- Any fields from add_cron_job to update

### 4. remove_cron_job

Delete a cron job.

**Parameters:**
- `jobId` (required): Job ID to delete

### 5. run_cron_job

Manually trigger a cron job to run immediately.

**Parameters:**
- `jobId` (required): Job ID to run

### 6. get_cron_stats

Get scheduler statistics and status.

**Returns:**
- `running`: Whether scheduler is active
- `scheduledCount`: Number of scheduled jobs
- `activeRuns`: Currently running jobs
- `runHistoryCount`: Total runs recorded

### 7. get_cron_history

Get recent job execution history.

**Parameters:**
- `limit` (optional): Max history items to return (default 50)

**Returns:** Array of run records with:
- `runId`: Unique run identifier
- `jobId`: Job that ran
- `jobName`: Job name
- `startTime`: Unix timestamp
- `endTime`: Unix timestamp
- `success`: Whether run succeeded
- `output`: Output (truncated to 10000 chars)
- `error`: Error message if failed

## Schedule Types

### One-time (at)
Run once at a specific datetime.
```json
{
  "kind": "at",
  "at": "2024-12-25T09:00:00Z"
}
```

### Interval (every)
Run at regular intervals.
```json
{
  "kind": "every",
  "everyMs": 3600000  // Every hour
}
```

### Cron Expression
Run on cron schedule (6-field: seconds minutes hours day month weekday).
```json
{
  "kind": "cron",
  "expr": "0 */30 * * * *",  // Every 30 minutes
  "tz": "UTC"  // Optional timezone
}
```

Common cron patterns:
- `0 0 * * * *` - Every hour
- `0 0 9 * * *` - Daily at 9 AM
- `0 0 9 * * 1-5` - Weekdays at 9 AM
- `0 0 0 * * 0` - Weekly on Sunday midnight

## Session Targets

### Main Session
- Sends message to the current active session
- User can see the interaction in their chat
- Good for reminders, prompts that need context

### Isolated Session
- Creates temporary session for one turn
- Logs output to cron history
- Good for background tasks, reports

## Payload Types

### System Event
- Simple text event
- Not processed as agent message
- `{"kind": "systemEvent", "text": "Event text"}`

### Agent Turn
- Full agent interaction
- Agent processes and responds
- `{"kind": "agentTurn", "message": "Your message", "model": "optional-model-id"}`

## Environment Variable

Set `OPENCHAMBER_SKIP_CRON=1` to disable the cron scheduler.

## Examples

### Create a daily reminder
```
add_cron_job with:
{
  "name": "Morning standup reminder",
  "schedule": {"kind": "cron", "expr": "0 0 9 * * 1-5"},
  "sessionTarget": "main",
  "payload": {"kind": "agentTurn", "message": "Remind me about standup meeting"}
}
```

### Create a periodic cleanup task
```
add_cron_job with:
{
  "name": "Hourly cleanup",
  "schedule": {"kind": "every", "everyMs": 3600000},
  "sessionTarget": "isolated",
  "payload": {"kind": "agentTurn", "message": "Clean up temporary files"}
}
```

### Schedule a one-time task
```
add_cron_job with:
{
  "name": "Deploy reminder",
  "schedule": {"kind": "at", "at": "2024-12-31T23:00:00Z"},
  "sessionTarget": "main",
  "payload": {"kind": "systemEvent", "text": "Time to deploy!"}
}
```
