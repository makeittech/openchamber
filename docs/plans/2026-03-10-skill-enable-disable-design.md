# Design: Skill Enable/Disable Per Project

## Overview

Add the ability to disable skills per project with a checkbox UI, storing the disabled state in project config. This lays groundwork for future conditional enable/disable based on model/provider.

## Requirements

- Checkbox next to each skill in sidebar to enable/disable
- Disabled skills shown in separate "Disabled" section at bottom
- Disabled skills not loaded by agent
- State persisted per-project in `.opencode/config.json`
- Extensible for future model/provider conditions

## Data Model

### Config Schema

Add `skills` object to `.opencode/config.json`:

```typescript
interface SkillConfig {
  enabled?: boolean;  // default: true if omitted
  // Future extensions:
  // provider?: string | string[];
  // model?: string | string[];
}

interface OpenCodeConfig {
  // ... existing fields
  skills?: Record<string, SkillConfig>;
}
```

### Example

```json
{
  "skills": {
    "brainstorming": { "enabled": false },
    "theme-system": { "enabled": true },
    "using-superpowers": {}  // enabled by default (omitted)
  }
}
```

### Default Behavior

- If skill not in `skills` object: **enabled** (default true)
- If skill in object but `enabled` omitted: **enabled** (default true)
- Only explicit `enabled: false` disables the skill

## UI Changes

### SkillsSidebar.tsx

1. **Checkbox per skill**: Add checkbox before skill name
   - Checked = enabled
   - Unchecked = disabled
   - Click toggles state via API call

2. **Grouped sections**:
   - "Enabled" section (expanded by default)
   - "Disabled" section (collapsed by default, at bottom)
   - Each section shows skill count

3. **Visual treatment**:
   - Disabled skills slightly dimmed (opacity)
   - Checkbox clearly visible for both states

### Store Changes (useSkillsStore.ts)

```typescript
interface DiscoveredSkill {
  // ... existing fields
  enabled: boolean;  // NEW: derived from config
}

// Add action
toggleSkillEnabled: (skillName: string) => Promise<void>;
```

## Backend Changes

### Config Endpoint

Update `/api/config` to handle `skills` field:
- GET: Return full config including `skills`
- PUT: Accept and persist `skills` field

### Skills Discovery

Update `/api/config/skills` response:
- Include `enabled` status for each skill
- Derive from config (true if not specified)

### Agent Skill Loading

When building agent context:
- Filter skills where `enabled !== false`
- Only pass enabled skills to agent

## Implementation Order

1. Backend: Add `skills` to config read/write
2. Backend: Include `enabled` in skills discovery
3. Frontend: Add `enabled` to store and types
4. Frontend: Add checkbox to sidebar
5. Frontend: Group into Enabled/Disabled sections
6. Backend: Filter disabled skills from agent context

## Future Extensions

The structured object format supports:
```json
{
  "skills": {
    "mcp-builder": { 
      "enabled": true, 
      "provider": ["anthropic", "openai"] 
    },
    "debugging": { 
      "enabled": true,
      "model": "claude-*"
    }
  }
}
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/ui/src/stores/useSkillsStore.ts` | Add `enabled` field, toggle action |
| `packages/ui/src/lib/api/types.ts` | Add `SkillConfig` type |
| `packages/ui/src/components/sections/skills/SkillsSidebar.tsx` | Checkbox + section grouping |
| `packages/web/server/index.js` | Config skills field, filter on agent load |
| Server skill discovery | Include enabled status |
