# Model Selector Integration

This module provides intelligent model selection and failover for OpenChamber server operations.

## Overview

The model selector supports three modes:

1. **Default**: Use a configured default model
2. **Smart**: Evaluate rules against context to select the best model
3. **Prioritised**: Try models in priority order with automatic failover on errors

## Usage Examples

### Basic Model Selection

```javascript
import { selectServerModel, createServerContext } from './lib/model/integration.js';

// Get settings from disk
const settings = await readSettingsFromDisk();

// Create context for selection
const context = createServerContext({
  topic: 'code review',
  tokenCount: 5000
});

// Select model based on configuration
const model = selectServerModel(settings, context);

if (model) {
  // Use selected model for API call
  const response = await fetch('https://api.example.com/v1/completions', {
    method: 'POST',
    body: JSON.stringify({ model, prompt: '...' })
  });
}
```

### With Automatic Failover

```javascript
import { executeWithServerModel, createServerContext } from './lib/model/integration.js';

const settings = await readSettingsFromDisk();
const context = createServerContext({ topic: 'summarization' });

// Executor function receives the selected model
const executor = async (model) => {
  const response = await fetch('https://opencode.ai/zen/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: 'Summarize this...' }],
      stream: false
    })
  });
  
  if (!response.ok) {
    const error = new Error(`API error: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  
  return response.json();
};

// Execute with automatic failover
const result = await executeWithServerModel(settings, context, executor, {
  timeout: 60000 // 60 second timeout
});

if (result.success) {
  console.log(`Used model: ${result.model}`);
  console.log('Response:', result.result);
} else {
  console.error(`Failed after ${result.attempts.length} attempts:`, result.error);
}
```

### Integration with Zen API (Summarization)

Replace the current hardcoded model selection in `summarizeText`:

```javascript
import { executeWithServerModel, createServerContext } from './lib/model/integration.js';

const summarizeText = async (text, targetLength, zenModelOverride) => {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return text;
  }

  try {
    const prompt = `Summarize the following text in approximately ${targetLength} characters...`;
    
    const settings = await readSettingsFromDisk();
    const context = createServerContext({
      topic: 'summarization',
      tokenCount: text.length / 4 // Rough estimate
    });
    
    const executor = async (model) => {
      const completionTimeout = createTimeoutSignal(15000);
      try {
        const response = await fetch('https://opencode.ai/zen/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: [{ role: 'user', content: prompt }],
            max_output_tokens: 1000,
            stream: false,
            reasoning: { effort: 'low' },
          }),
          signal: completionTimeout.signal,
        });
        
        if (!response.ok) {
          const error = new Error(`Zen API error: ${response.status}`);
          error.status = response.status;
          throw error;
        }
        
        return response.json();
      } finally {
        completionTimeout.cleanup();
      }
    };
    
    const result = await executeWithServerModel(settings, context, executor);
    
    if (!result.success) {
      console.warn('Summarization failed:', result.error);
      return text;
    }
    
    const data = result.result;
    const summary = data?.output?.find((item) => item?.type === 'message')
      ?.content?.find((item) => item?.type === 'output_text')?.text?.trim();
    
    return summary || text;
  } catch (error) {
    console.warn('Summarization failed:', error);
    return text;
  }
};
```

## Configuration

The model selector is configured via `modelModeConfig` in settings:

### Default Mode

```json
{
  "modelModeConfig": {
    "mode": "default",
    "defaultModel": "zen/big-pickle"
  }
}
```

### Smart Mode

Rules are evaluated in order; first match wins.

```json
{
  "modelModeConfig": {
    "mode": "smart",
    "defaultModel": "zen/big-pickle",
    "rules": [
      {
        "condition": "topic",
        "value": "code review",
        "model": "zen/gpt-5-nano"
      },
      {
        "condition": "tokenCount",
        "value": ">=10000",
        "model": "zen/big-pickle"
      },
      {
        "condition": "time",
        "value": "9-17",
        "model": "zen/gpt-5-nano"
      }
    ]
  }
}
```

### Prioritised Mode

Models are tried in order with automatic failover.

```json
{
  "modelModeConfig": {
    "mode": "prioritised",
    "defaultModel": "zen/big-pickle",
    "priorities": [
      {
        "model": "zen/gpt-5-nano",
        "timeout": 30000,
        "retryOn": ["error", "timeout", "rateLimit"]
      },
      {
        "model": "zen/big-pickle",
        "timeout": 60000,
        "retryOn": ["error", "timeout"]
      }
    ]
  }
}
```

## Rule Conditions

### topic

Match against current topic/operation type.

- `coding` - Exact match (case-insensitive)
- `code*` - Starts with "code"
- `*review` - Ends with "review"
- `*debug*` - Contains "debug"

### time

Match against time of day (24-hour format).

- `9-17` - Between 9 AM and 5 PM
- `22-6` - Between 10 PM and 6 AM (spans midnight)

### promptPrefix

Match against prompt prefix.

- `DEBUG:` - Starts with "DEBUG:" (case-insensitive)

### tokenCount

Match against token count with operators.

- `<1000` - Less than 1000 tokens
- `>=5000` - Greater than or equal to 5000 tokens
- `10000` - Exactly 10000 tokens

## Error Classification

Errors are classified for retry decisions:

- **timeout**: Request timed out
- **rateLimit**: HTTP 429 or rate limit error
- **error**: HTTP 5xx or general error
- **permanent**: HTTP 4xx (non-429) - not retried

## Best Practices

1. **Set appropriate timeouts**: Configure per-model timeouts based on expected response times
2. **Configure retry conditions**: Only retry on transient errors, not permanent failures
3. **Order rules by specificity**: More specific rules should come first in smart mode
4. **Monitor failover**: Log attempts to understand which models are being used
5. **Test failover paths**: Verify that backup models work correctly

## Testing

Run tests:

```bash
bun test packages/web/server/lib/model/__tests__/
```

All tests should pass with coverage of:
- Model selection logic
- Rule evaluation
- Failover behavior
- Error classification
- Integration with settings
