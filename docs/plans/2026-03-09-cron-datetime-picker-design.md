# Cron Job Date/Time Picker with Global Timezone - Design

**Date:** 2026-03-09  
**Status:** Approved  
**Approach:** Hybrid preset + custom input with global timezone

## Overview

Enhance the CronSettings component with:
1. Global timezone selection dropdown
2. Preset schedule options (hourly, daily, weekly, monthly)
3. Native HTML date/time inputs for custom schedules
4. Retain ability to enter raw cron expressions

## User Requirements

- **Schedule Interface:** Hybrid approach with presets + custom input
- **Timezone:** Global timezone for all jobs (simpler configuration)
- **Presets:** Hourly intervals, daily at specific times, weekly schedules, monthly schedules

## Design Sections

### 1. Global Timezone Configuration

**Location:** Top of CronSettings component, above the job list.

**UI:**
- Select dropdown next to "Cron Jobs" header
- Options: Common timezones organized alphabetically
  - UTC
  - America/New_York
  - America/Los_Angeles
  - America/Chicago
  - Europe/London
  - Europe/Paris
  - Asia/Tokyo
  - Asia/Shanghai
  - Australia/Sydney
  - etc.

**Storage:**
- React state in CronSettings component
- Passed to all job creation/update operations
- Added to schedule object as `tz` field

**Behavior:**
- Changing global timezone does NOT affect existing jobs
- Only applies to newly created or edited jobs
- Existing jobs retain their original timezone

### 2. Schedule Input Mode Selector

**UI:**
- Radio button group or segmented control with options:
  - "Presets" (default)
  - "Custom Date/Time"
  - "Cron Expression" (for advanced users)

**Behavior:**
- Switching modes changes the input fields shown below
- Preset mode: Show preset dropdown
- Custom mode: Show date picker + time picker
- Cron mode: Show text input for raw cron expression (current behavior)

### 3. Preset Schedule Dropdown

**Location:** Shown when "Presets" mode is selected.

**Options:**

**Hourly:**
- Every hour
- Every 2 hours
- Every 6 hours
- Every 12 hours

**Daily:**
- Daily at 9:00 AM
- Daily at 12:00 PM
- Daily at 5:00 PM
- Daily at 9:00 PM

**Weekly:**
- Every Monday
- Every Tuesday
- Every Wednesday
- Every Thursday
- Every Friday
- Weekdays (Mon-Fri)
- Weekends (Sat-Sun)

**Monthly:**
- 1st of every month
- 15th of every month
- Last day of month

**Mapping:**
Each preset maps to a cron expression:
- "Every hour" → `0 0 * * * *`
- "Daily at 9:00 AM" → `0 0 9 * * *`
- "Every Monday" → `0 0 9 * * 1`
- "Weekdays (Mon-Fri)" → `0 0 9 * * 1-5`
- "1st of every month" → `0 0 9 1 * *`

### 4. Custom Date/Time Inputs

**Location:** Shown when "Custom Date/Time" mode is selected.

**UI:**
- Two inputs side by side:
  1. `<input type="date">` - Native HTML date picker
  2. `<input type="time">` - Native HTML time picker
- Uses existing Input component wrapper for consistent styling

**Conversion:**
- Combined datetime converted to ISO string
- Stored as schedule.kind = "at" with ISO date string

**Benefits:**
- No new dependencies
- Browser-native accessibility
- Automatic localization based on browser settings

### 5. Cron Expression Input (Advanced)

**Location:** Shown when "Cron Expression" mode is selected.

**UI:**
- Single text input (current behavior)
- Placeholder examples: "0 * * * *", "0 0 9 * * 1-5"
- Optional: Add helper text linking to cron documentation

**Behavior:**
- Direct input of 6-field cron expressions
- For advanced users who need precise control

### 6. Data Flow

**Creating/Editing a Job:**

1. User selects schedule mode (Preset/Custom/Cron)
2. Based on mode:
   - **Preset:** Selected preset maps to cron expression
   - **Custom:** Date + time inputs converted to ISO string (kind: "at")
   - **Cron:** Raw expression used as-is
3. Global timezone added to schedule object as `tz`
4. Job submitted to API with complete schedule configuration

**Form State:**

```typescript
interface FormData {
  name: string;
  description: string;
  scheduleMode: 'preset' | 'custom' | 'cron';
  presetSchedule?: string; // e.g., "hourly-1", "daily-9"
  customDate?: string; // YYYY-MM-DD
  customTime?: string; // HH:MM
  cronExpression?: string; // Raw cron
  sessionTarget: 'main' | 'isolated';
  payloadKind: 'systemEvent' | 'agentTurn';
  payloadText: string;
}

interface GlobalState {
  timezone: string; // e.g., "America/New_York"
}
```

### 7. Visual Design

**Theme Compliance:**
- Use existing Select, Input, Button components
- Follow OpenChamber theme system (no hardcoded colors)
- Use semantic color tokens from theme-system skill

**Layout:**
```
┌─────────────────────────────────────────────┐
│ Cron Jobs        [Timezone: UTC ▼] [Refresh] [Add Job]
├─────────────────────────────────────────────┤
│ [Job list...]                                │
│                                             │
│ [+ Add Job form]                            │
│ ┌───────────────────────────────────────┐  │
│ │ Name: [___________________________]    │  │
│ │ Description: [____________________]    │  │
│ │                                        │  │
│ │ Schedule Mode: ○ Presets ○ Custom ○ Cron│  │
│ │                                        │  │
│ │ [If Presets selected:]                 │  │
│ │ Preset: [Every hour ▼]                 │  │
│ │                                        │  │
│ │ [If Custom selected:]                  │  │
│ │ Date: [2026-03-09 📅] Time: [09:00 ⏰] │  │
│ │                                        │  │
│ │ [If Cron selected:]                    │  │
│ │ Cron Expression: [0 * * * * *]         │  │
│ │                                        │  │
│ │ Session Target: [Isolated] [Main]      │  │
│ │ Payload Type: [Agent Turn] [System]    │  │
│ │ Message: [________________________]     │  │
│ │                                        │  │
│ │ [Create Job] [Cancel]                  │  │
│ └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

## Implementation Notes

### No New Dependencies
- Use native HTML `<input type="date">` and `<input type="time">`
- Use existing Select component for timezone and preset dropdowns
- No date picker library required

### Backward Compatibility
- Existing jobs continue to work without changes
- Cron expression mode available for advanced users
- Jobs can be edited and will retain their original schedule type

### Timezone Handling
- Frontend sends timezone string to backend
- Backend stores timezone in job.schedule.tz
- Cron scheduler (per cron skill) uses the tz field for scheduling

## Files to Modify

1. `packages/ui/src/components/sections/openchamber/CronSettings.tsx` - Main component
2. Possibly `packages/ui/src/components/ui/input.tsx` - Ensure date/time types are supported

## Success Criteria

- Users can select from common preset schedules via dropdown
- Users can pick specific dates and times using native pickers
- Global timezone applies to all new/edited jobs
- Advanced users can still enter raw cron expressions
- No new npm dependencies added
- UI follows OpenChamber theme system
