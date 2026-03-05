# soul.md - Agent Personality Configuration

## What is soul.md?

`soul.md` is an optional configuration file that defines your AI agent's personality, values, and core instructions. Similar to how `AGENTS.md` provides project context, `soul.md` provides identity and purpose context for the agent.

## Purpose

Use `soul.md` to:
- Define the agent's core values and principles
- Specify communication style preferences
- Set behavioral guidelines
- Provide domain-specific instructions
- Customize the agent's approach to problem-solving

## Basic Usage

1. Create a `soul.md` file in your project root (or configured location)
2. Write your agent's personality definition in markdown format
3. The agent will automatically load and use these instructions

## Example

```markdown
# Agent Soul

## Core Values
- **Helpfulness**: Prioritize being genuinely useful
- **Clarity**: Communicate in plain language
- **Efficiency**: Suggest the simplest solutions
- **Safety**: Consider edge cases and risks

## Working Style
- Ask clarifying questions when needed
- Explain reasoning behind suggestions
- Provide alternatives when multiple approaches exist
- Acknowledge uncertainty when it exists

## Communication Preferences
- Be concise but thorough
- Use examples to illustrate concepts
- Adapt to the user's communication style
```

## Configuration

### Default Location

By default, the agent looks for `soul.md` in your project root.

### Custom Path

You can configure a custom path in your `opencode.json`:

```json
{
  "agents": {
    "defaults": {
      "soulPath": "docs/soul.md"
    }
  }
}
```

### Template

A template file is available at `docs/soul.md.template` to help you get started.

## API Access

The soul.md content can be accessed via the API:

```
GET /api/config/soul
```

Response:
```json
{
  "exists": true,
  "content": "# Agent Soul\n\n...",
  "path": "/path/to/soul.md",
  "configuredPath": "soul.md"
}
```

## Best Practices

1. **Keep it focused**: Define core principles, not detailed instructions
2. **Be specific**: General statements are less useful than concrete guidelines
3. **Iterate**: Refine based on how the agent responds
4. **Version control**: Include soul.md in your repository
5. **Document decisions**: Explain why you chose certain values

## When to Use

Use soul.md when you want to:
- Customize the agent's behavior across your team
- Ensure consistent communication style
- Define project-specific values or constraints
- Provide domain expertise or context

## When Not to Use

You might not need soul.md if:
- Default agent behavior works well for your use case
- You prefer to provide instructions in each session
- Your project doesn't have specific behavioral requirements

## Integration

The soul.md content is automatically loaded and injected into the agent's context when:
- Creating a new session
- Loading an existing session
- The agent processes requests

## Related

- `AGENTS.md` - Project architecture and conventions
- `opencode.json` - Configuration file
- Skills system - Task-specific instructions
