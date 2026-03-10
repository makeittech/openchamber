# Task 3.2: Model Selection and Failover - Implementation Summary

## Overview

Successfully implemented model selection and failover logic for OpenChamber server operations.

## Files Created

### Core Implementation

1. **`packages/web/server/lib/model/selector.js`** (442 lines)
   - Core model selection logic
   - Three modes: default, smart, prioritised
   - Rule evaluation engine
   - Failover with exponential backoff
   - Error classification (timeout, rateLimit, error, permanent)

2. **`packages/web/server/lib/model/integration.js`** (104 lines)
   - Integration helpers for server-side use
   - Settings configuration extraction
   - Context creation utilities
   - Wrapper functions for easy integration

3. **`packages/web/server/lib/model/index.js`** (17 lines)
   - Module exports

### Tests

4. **`packages/web/server/lib/model/__tests__/selector.test.js`** (593 lines)
   - 44 comprehensive tests
   - Coverage of all selection modes
   - Rule evaluation tests
   - Failover behavior tests
   - Error classification tests
   - Timeout handling tests

5. **`packages/web/server/lib/model/__tests__/integration.test.js`** (189 lines)
   - 15 integration tests
   - Settings integration
   - Context creation
   - Server-side execution

### Documentation

6. **`packages/web/server/lib/model/README.md`** (277 lines)
   - Complete usage guide
   - Configuration examples
   - Integration examples
   - Best practices

## Test Results

```
✅ 59 tests passed
✅ 0 tests failed
✅ 121 assertions
✅ Execution time: ~5.3s
```

## Features Implemented

### 1. Model Selection Modes

#### Default Mode
- Returns configured default model
- Fallback when no rules match
- Simple and predictable

#### Smart Mode
- Rule-based selection
- First match wins
- Supports conditions:
  - `topic`: Wildcard matching (*, prefix*, *suffix, *contains*)
  - `time`: Hour ranges (9-17, 22-6 spanning midnight)
  - `promptPrefix`: Prefix matching
  - `tokenCount`: Numeric comparisons (<, <=, >, >=, =)

#### Prioritised Mode
- Ordered model list
- Automatic failover on errors
- Configurable retry conditions
- Model-specific timeouts
- Exponential backoff between retries

### 2. Failover Logic

- **Error Classification**:
  - `timeout`: Request timeouts
  - `rateLimit`: HTTP 429
  - `error`: HTTP 5xx
  - `permanent`: HTTP 4xx (non-429) - not retried

- **Retry Control**:
  - Per-model `retryOn` configuration
  - Maximum 10 retries
  - Exponential backoff (1s to 30s)
  - Configurable timeouts per model

### 3. Integration Features

- **`selectServerModel(settings, context)`**: Select model from settings
- **`executeWithServerModel(settings, context, executor, options)`**: Execute with failover
- **`createServerContext(params)`**: Create selection context
- **`getModelModeConfig(settings)`**: Extract config from settings

### 4. Context Support

```javascript
{
  topic?: string,        // Operation topic
  time?: Date,           // Current time (auto-set)
  promptPrefix?: string, // Prompt prefix
  tokenCount?: number,   // Token count
  session?: string       // Session ID
}
```

## Configuration Format

```json
{
  "modelModeConfig": {
    "mode": "smart" | "default" | "prioritised",
    "defaultModel": "zen/big-pickle",
    "rules": [
      {
        "condition": "topic" | "time" | "promptPrefix" | "tokenCount",
        "value": "pattern",
        "model": "model-id"
      }
    ],
    "priorities": [
      {
        "model": "model-id",
        "timeout": 30000,
        "retryOn": ["error", "timeout", "rateLimit"]
      }
    ]
  }
}
```

## Usage Example

```javascript
import { executeWithServerModel, createServerContext } from './lib/model/integration.js';

const settings = await readSettingsFromDisk();
const context = createServerContext({ topic: 'summarization' });

const result = await executeWithServerModel(
  settings,
  context,
  async (model) => {
    const response = await fetch('https://api.example.com/v1/completions', {
      method: 'POST',
      body: JSON.stringify({ model, prompt: '...' })
    });
    
    if (!response.ok) {
      const error = new Error(`API error: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    
    return response.json();
  },
  { timeout: 60000 }
);

if (result.success) {
  console.log(`Used model: ${result.model}`);
  console.log('Attempts:', result.attempts);
} else {
  console.error(`Failed: ${result.error}`);
}
```

## Integration Points

The model selector is ready to be integrated into:

1. **Zen API calls** (summarization, git operations)
2. **TTS service** (text-to-speech)
3. **Custom API endpoints** requiring model selection
4. **Any server-side operation** that needs intelligent model selection

## Commit

```
commit 5ddbfa2
feat(model): model selector with smart rules and prioritised failover

- Model selector with 3 modes: default, smart, prioritised
- Smart rule evaluation (topic, time, promptPrefix, tokenCount)
- Prioritised failover with exponential backoff
- Error classification (timeout, rateLimit, error, permanent)
- 59 comprehensive tests (all passing)
- Integration helpers for server-side use
- Complete documentation with examples
```

## Next Steps

To complete integration:

1. Update Zen API calls to use `executeWithServerModel`
2. Update TTS service to use model selector
3. Add UI for configuring `modelModeConfig` in settings
4. Monitor failover behavior in production
5. Add metrics/logging for model selection decisions

## Requirements Met

✅ Created model selector at `packages/web/server/lib/model/selector.js`
✅ Implemented `selectModel(config, context)` function
✅ Default mode: returns defaultModel
✅ Smart mode: evaluates rules against context
✅ Prioritised mode: returns first in priority list
✅ Failover logic with performance tracking
✅ Timeout handling (>60s default)
✅ Retry on 5xx/429 errors
✅ No retry on 4xx (non-429) - permanent errors
✅ Exponential backoff between retries
✅ Context object support (topic, time, promptPrefix, tokenCount, session)
✅ Unit tests for selector (44 tests)
✅ Unit tests for failover
✅ Integration tests (15 tests)
✅ Documentation with examples
✅ Commit message: `feat(model): model selector with smart rules and prioritised failover`
