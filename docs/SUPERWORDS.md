# Superwords

Superwords are trigger phrases that automatically activate skills when they appear at the start of a message. This feature enables quick skill activation without navigating through menus or remembering complex commands.

## Overview

Superwords work by detecting special trigger phrases at the beginning of a user message. When a trigger is detected, the associated skill is automatically activated, and the remaining message content is passed to the skill.

### How It Works

1. **Trigger Detection**: When you send a message, OpenChamber checks if it starts with a configured superword trigger
2. **Skill Activation**: If a match is found, the associated skill is activated
3. **Message Processing**: The trigger is removed from the message, and the remaining text is processed by the skill

## Configuration

### Accessing Superwords Settings

1. Open Settings (Ctrl/Cmd + ,)
2. Navigate to **Skills** → **Superwords**
3. Configure your trigger → skill mappings

### Adding a Superword

1. In the "Add New Superword" section:
   - **Trigger**: Enter the trigger phrase (must start with `/` or `@`)
   - **Skill ID**: Enter the skill ID to activate
2. Click the **+** button to add

Example:
- Trigger: `/plan`
- Skill ID: `brainstorming`

Now, any message starting with `/plan` will automatically activate the brainstorming skill.

### Editing a Superword

1. Find the superword in the list
2. Click **Edit**
3. Modify the trigger or skill ID
4. Click **Save**

### Deleting a Superword

1. Find the superword in the list
2. Click the **Delete** button (trash icon)
3. Confirm the deletion

## Trigger Rules

### Valid Triggers

Triggers must:
- Start with `/` (slash) or `@` (at sign)
- Be non-empty after trimming whitespace
- Be unique (no duplicate triggers)

### Trigger Matching

- **Case-sensitive**: `/Plan` and `/plan` are different triggers
- **Word boundary**: Triggers must be followed by whitespace or end of message
- **Longest match**: Longer triggers are matched first (e.g., `/plan-mode` matches before `/plan`)

### Examples

| Trigger | Message | Matches? | Remaining Message |
|---------|---------|----------|-------------------|
| `/plan` | `/plan create a feature` | ✓ | `create a feature` |
| `/plan` | `/planning session` | ✗ | (no match) |
| `@debug` | `@debug fix this issue` | ✓ | `fix this issue` |
| `/test` | `/test` | ✓ | (empty) |

## Use Cases

### Quick Skill Activation

Instead of:
1. Opening skills menu
2. Finding the right skill
3. Activating it
4. Typing your message

You can simply type:
```
/brainstorm how to improve user onboarding
```

### Workflow Shortcuts

Create shortcuts for common workflows:

| Trigger | Skill ID | Purpose |
|---------|----------|---------|
| `/plan` | `brainstorming` | Start planning session |
| `@debug` | `systematic-debugging` | Debug issues |
| `/review` | `requesting-code-review` | Request code review |
| `/test` | `test-driven-development` | Start TDD workflow |
| `/commit` | `finishing-a-development-branch` | Prepare for commit |

### Team Standards

Teams can standardize on common triggers:
- All team members use the same superwords
- Consistent workflow activation
- Easy to remember shortcuts

## Technical Details

### Storage

Superwords configuration is stored in:
```
~/.config/openchamber/projects/<project-id>.json
```

Under the `superwords` key:
```json
{
  "superwords": {
    "/plan": "brainstorming",
    "@debug": "systematic-debugging"
  }
}
```

### API Integration

Superwords are processed server-side before message handling:

```javascript
// Message: "/plan create a feature"
// Superwords: { "/plan": "brainstorming" }

// Result:
{
  skillId: "brainstorming",
  trigger: "/plan",
  remainingMessage: "create a feature"
}
```

### Implementation

The superwords parser (`packages/web/server/lib/skills/superwords.js`) provides:

- **parseSuperwords(message, config)**: Parse a message for superword triggers
- **getSkillForSuperword(trigger, config)**: Get skill ID for a trigger
- **injectSuperwordSkill(requestBody, skillId, remainingMessage)**: Inject skill context

## Best Practices

### Naming Conventions

- Use descriptive triggers: `/plan` is better than `/p`
- Be consistent: use either `/` or `@`, not both mixed
- Avoid conflicts: don't use triggers that could match normal text

### Skill Selection

- Choose appropriate skills: the skill should make sense with the trigger
- Test thoroughly: ensure the skill works well with various message formats
- Document for teams: maintain a list of standard superwords

### Security Considerations

- Superwords are project-specific (stored in project config)
- No special permissions required to configure
- Cannot override system behavior or bypass security

## Troubleshooting

### Superword Not Working

1. **Check trigger format**: Must start with `/` or `@`
2. **Verify skill ID**: Ensure the skill ID is correct
3. **Check message position**: Trigger must be at the start
4. **Verify whitespace**: Trigger must be followed by space or end of message

### Multiple Triggers Not Working

- Triggers are matched longest-first
- Ensure no overlapping triggers (e.g., `/plan` and `/plan-mode` work fine)

### Changes Not Saving

1. Check project permissions
2. Verify disk space
3. Check console for errors

## Examples

### Development Workflow

```
/plan implement user authentication
@debug login is failing on production
/test write tests for UserService
/review ready for code review
```

### Planning Session

```
/plan how to optimize database queries
```

This activates the brainstorming skill and starts a planning session about query optimization.

### Debugging

```
@debug TypeError in UserService.createUser
```

This activates systematic debugging skill with the error description.

## Future Enhancements

Potential improvements being considered:
- [ ] Trigger suggestions based on message content
- [ ] Import/export superword configurations
- [ ] Global superwords (across all projects)
- [ ] Superword templates for common workflows
- [ ] Conditional superwords (based on context)

## Related Features

- **Skills**: Superwords activate skills
- **Commands**: Similar shortcut feature for command execution
- **Agents**: Skills can modify agent behavior

## Feedback

Found a bug or have a suggestion? Please open an issue at:
https://github.com/btriapitsyn/openchamber/issues
