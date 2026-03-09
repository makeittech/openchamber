# Cron Date/Time Picker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add global timezone selection and comfortable date/time dropdowns to cron job scheduling UI

**Architecture:** Enhance CronSettings component with preset schedule dropdowns, native HTML date/time inputs, and global timezone selector. No new dependencies - use existing Select and Input components.

**Tech Stack:** React, TypeScript, native HTML inputs, existing UI components (Select, Input, Button)

---

## Task 1: Add Global Timezone State and UI

**Files:**
- Modify: `packages/ui/src/components/sections/openchamber/CronSettings.tsx:37-52`

**Step 1: Add timezone state and common timezones constant**

Add at the top of the CronSettings function (after existing state declarations):

```typescript
const [globalTimezone, setGlobalTimezone] = useState('UTC');

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Pacific/Auckland',
];
```

**Step 2: Add Select component import**

Add to imports at the top of the file:

```typescript
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
```

**Step 3: Add timezone selector UI**

In the header section (around line 186-210), update the header to include timezone selector:

```typescript
<div className="flex items-center justify-between mb-4">
  <div className="flex items-center gap-3">
    <div className="flex items-center gap-2">
      <RiTimeLine className="w-5 h-5" />
      <h2 className="typography-ui-header font-semibold text-foreground">Cron Jobs</h2>
    </div>
    <Select value={globalTimezone} onValueChange={setGlobalTimezone}>
      <SelectTrigger size="sm" className="h-7">
        <SelectValue placeholder="Select timezone" />
      </SelectTrigger>
      <SelectContent>
        {COMMON_TIMEZONES.map((tz) => (
          <SelectItem key={tz} value={tz}>
            {tz}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
  <div className="flex gap-2">
    <Button
      variant="outline"
      size="sm"
      onClick={fetchJobs}
      className="h-7"
    >
      <RiRefreshLine className="w-4 h-4 mr-1" />
      Refresh
    </Button>
    <Button
      size="sm"
      onClick={() => setShowForm(!showForm)}
      className="h-7"
    >
      <RiAddLine className="w-4 h-4 mr-1" />
      Add Job
    </Button>
  </div>
</div>
```

**Step 4: Verify UI renders**

Run: `bun run dev` (or check that web app loads)
Expected: Cron settings page shows timezone dropdown next to "Cron Jobs" header

**Step 5: Commit**

```bash
git add packages/ui/src/components/sections/openchamber/CronSettings.tsx
git commit -m "feat(cron): add global timezone selector UI"
```

---

## Task 2: Add Schedule Mode State and UI

**Files:**
- Modify: `packages/ui/src/components/sections/openchamber/CronSettings.tsx:44-52`

**Step 1: Update formData state to include schedule mode**

Replace the formData state initialization (around line 44-52):

```typescript
const [formData, setFormData] = useState({
  name: '',
  description: '',
  scheduleMode: 'preset' as 'preset' | 'custom' | 'cron',
  presetSchedule: 'hourly-1',
  customDate: '',
  customTime: '09:00',
  sessionTarget: 'isolated' as 'main' | 'isolated',
  payloadKind: 'agentTurn' as 'systemEvent' | 'agentTurn',
  payloadText: '',
});
```

**Step 2: Update resetForm function**

Update the resetForm function (around line 148-160):

```typescript
const resetForm = () => {
  setFormData({
    name: '',
    description: '',
    scheduleMode: 'preset',
    presetSchedule: 'hourly-1',
    customDate: '',
    customTime: '09:00',
    sessionTarget: 'isolated',
    payloadKind: 'agentTurn',
    payloadText: '',
  });
  setShowForm(false);
  setEditingJob(null);
};
```

**Step 3: Add schedule mode selector UI in form**

Replace the schedule type section (around line 241-275) with:

```typescript
<div>
  <label className="typography-ui-label text-foreground block mb-1">Schedule Mode</label>
  <div className="flex gap-2">
    {(['preset', 'custom', 'cron'] as const).map((mode) => (
      <button
        key={mode}
        type="button"
        onClick={() => setFormData({ ...formData, scheduleMode: mode })}
        className={cn(
          'px-3 py-1 rounded text-sm',
          formData.scheduleMode === mode
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted hover:bg-muted/80'
        )}
      >
        {mode === 'preset' ? 'Presets' : mode === 'custom' ? 'Custom Date/Time' : 'Cron Expression'}
      </button>
    ))}
  </div>
</div>

{formData.scheduleMode === 'preset' && (
  <div>
    <label className="typography-ui-label text-foreground block mb-1">Preset Schedule</label>
    <Select
      value={formData.presetSchedule}
      onValueChange={(value) => setFormData({ ...formData, presetSchedule: value })}
    >
      <SelectTrigger size="sm" className="h-7 w-full">
        <SelectValue placeholder="Select a preset schedule" />
      </SelectTrigger>
      <SelectContent>
        <SelectLabel>Hourly</SelectLabel>
        <SelectItem value="hourly-1">Every hour</SelectItem>
        <SelectItem value="hourly-2">Every 2 hours</SelectItem>
        <SelectItem value="hourly-6">Every 6 hours</SelectItem>
        <SelectItem value="hourly-12">Every 12 hours</SelectItem>
        <SelectSeparator />
        <SelectLabel>Daily</SelectLabel>
        <SelectItem value="daily-9">Daily at 9:00 AM</SelectItem>
        <SelectItem value="daily-12">Daily at 12:00 PM</SelectItem>
        <SelectItem value="daily-17">Daily at 5:00 PM</SelectItem>
        <SelectItem value="daily-21">Daily at 9:00 PM</SelectItem>
        <SelectSeparator />
        <SelectLabel>Weekly</SelectLabel>
        <SelectItem value="weekly-mon">Every Monday</SelectItem>
        <SelectItem value="weekly-tue">Every Tuesday</SelectItem>
        <SelectItem value="weekly-wed">Every Wednesday</SelectItem>
        <SelectItem value="weekly-thu">Every Thursday</SelectItem>
        <SelectItem value="weekly-fri">Every Friday</SelectItem>
        <SelectItem value="weekly-weekdays">Weekdays (Mon-Fri)</SelectItem>
        <SelectItem value="weekly-weekends">Weekends (Sat-Sun)</SelectItem>
        <SelectSeparator />
        <SelectLabel>Monthly</SelectLabel>
        <SelectItem value="monthly-1">1st of every month</SelectItem>
        <SelectItem value="monthly-15">15th of every month</SelectItem>
        <SelectItem value="monthly-last">Last day of month</SelectItem>
      </SelectContent>
    </Select>
  </div>
)}

{formData.scheduleMode === 'custom' && (
  <div className="flex gap-2">
    <div className="flex-1">
      <label className="typography-ui-label text-foreground block mb-1">Date</label>
      <Input
        type="date"
        value={formData.customDate}
        onChange={(e) => setFormData({ ...formData, customDate: e.target.value })}
        required
        className="h-7"
      />
    </div>
    <div className="flex-1">
      <label className="typography-ui-label text-foreground block mb-1">Time</label>
      <Input
        type="time"
        value={formData.customTime}
        onChange={(e) => setFormData({ ...formData, customTime: e.target.value })}
        required
        className="h-7"
      />
    </div>
  </div>
)}

{formData.scheduleMode === 'cron' && (
  <div>
    <label className="typography-ui-label text-foreground block mb-1">Cron Expression</label>
    <Input
      value={formData.cronExpression}
      onChange={(e) => setFormData({ ...formData, cronExpression: e.target.value })}
      placeholder="0 * * * * *"
      required
      className="h-7"
    />
  </div>
)}
```

**Step 4: Add cronExpression to formData type**

Update formData state to include cronExpression:

```typescript
const [formData, setFormData] = useState({
  name: '',
  description: '',
  scheduleMode: 'preset' as 'preset' | 'custom' | 'cron',
  presetSchedule: 'hourly-1',
  customDate: '',
  customTime: '09:00',
  cronExpression: '',
  sessionTarget: 'isolated' as 'main' | 'isolated',
  payloadKind: 'agentTurn' as 'systemEvent' | 'agentTurn',
  payloadText: '',
});
```

And update resetForm:

```typescript
const resetForm = () => {
  setFormData({
    name: '',
    description: '',
    scheduleMode: 'preset',
    presetSchedule: 'hourly-1',
    customDate: '',
    customTime: '09:00',
    cronExpression: '',
    sessionTarget: 'isolated',
    payloadKind: 'agentTurn',
    payloadText: '',
  });
  setShowForm(false);
  setEditingJob(null);
};
```

**Step 5: Verify schedule mode UI works**

Run: `bun run dev`
Expected: Form shows schedule mode buttons and appropriate inputs when toggling between modes

**Step 6: Commit**

```bash
git add packages/ui/src/components/sections/openchamber/CronSettings.tsx
git commit -m "feat(cron): add schedule mode selector with preset/custom/cron options"
```

---

## Task 3: Create Preset to Cron Expression Mapper

**Files:**
- Modify: `packages/ui/src/components/sections/openchamber/CronSettings.tsx`

**Step 1: Add preset mapping function**

Add before the CronSettings component definition:

```typescript
function presetToCronExpression(preset: string): string {
  const presetMap: Record<string, string> = {
    'hourly-1': '0 0 * * * *',
    'hourly-2': '0 0 */2 * * *',
    'hourly-6': '0 0 */6 * * *',
    'hourly-12': '0 0 */12 * * *',
    'daily-9': '0 0 9 * * *',
    'daily-12': '0 0 12 * * *',
    'daily-17': '0 0 17 * * *',
    'daily-21': '0 0 21 * * *',
    'weekly-mon': '0 0 9 * * 1',
    'weekly-tue': '0 0 9 * * 2',
    'weekly-wed': '0 0 9 * * 3',
    'weekly-thu': '0 0 9 * * 4',
    'weekly-fri': '0 0 9 * * 5',
    'weekly-weekdays': '0 0 9 * * 1-5',
    'weekly-weekends': '0 0 9 * * 0,6',
    'monthly-1': '0 0 9 1 * *',
    'monthly-15': '0 0 9 15 * *',
    'monthly-last': '0 0 9 L * *',
  };
  return presetMap[preset] || '0 0 * * * *';
}
```

**Step 2: Verify function with console log**

Temporarily add to CronSettings function to test:

```typescript
console.log('Preset hourly-1 maps to:', presetToCronExpression('hourly-1'));
console.log('Preset daily-9 maps to:', presetToCronExpression('daily-9'));
console.log('Preset weekly-weekdays maps to:', presetToCronExpression('weekly-weekdays'));
```

Run: `bun run dev`
Expected: Console logs show correct cron expressions

Remove the console logs after verification.

**Step 3: Commit**

```bash
git add packages/ui/src/components/sections/openchamber/CronSettings.tsx
git commit -m "feat(cron): add preset to cron expression mapper"
```

---

## Task 4: Update Form Submission Logic

**Files:**
- Modify: `packages/ui/src/components/sections/openchamber/CronSettings.tsx:73-110`

**Step 1: Update handleSubmit function**

Replace the handleSubmit function (around line 73-110):

```typescript
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();

  let schedule: CronJob['schedule'];

  if (formData.scheduleMode === 'preset') {
    schedule = {
      kind: 'cron',
      expr: presetToCronExpression(formData.presetSchedule),
      tz: globalTimezone,
    };
  } else if (formData.scheduleMode === 'custom') {
    const dateTime = new Date(`${formData.customDate}T${formData.customTime}`);
    schedule = {
      kind: 'at',
      at: dateTime.toISOString(),
      tz: globalTimezone,
    };
  } else {
    schedule = {
      kind: 'cron',
      expr: formData.cronExpression,
      tz: globalTimezone,
    };
  }

  const job: Partial<CronJob> = {
    name: formData.name,
    description: formData.description,
    sessionTarget: formData.sessionTarget,
    schedule,
    payload: {
      kind: formData.payloadKind,
      ...(formData.payloadKind === 'systemEvent' && { text: formData.payloadText }),
      ...(formData.payloadKind === 'agentTurn' && { message: formData.payloadText }),
    },
  };

  try {
    const url = editingJob ? `/api/cron/${editingJob.jobId}` : '/api/cron';
    const method = editingJob ? 'PUT' : 'POST';

    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });

    if (!response.ok) throw new Error('Failed to save job');

    await fetchJobs();
    resetForm();
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to save job');
  }
};
```

**Step 2: Test preset schedule submission**

Run: `bun run dev`
Manual test:
1. Create a new job with preset schedule "Every hour"
2. Check browser network tab to verify schedule object includes cron expression and timezone
3. Verify job appears in list with correct schedule

**Step 3: Test custom date/time submission**

Manual test:
1. Create a new job with custom date/time
2. Check browser network tab to verify schedule object includes ISO date and timezone
3. Verify job appears in list with correct schedule

**Step 4: Test cron expression submission**

Manual test:
1. Create a new job with cron expression "0 0 13 * * *"
2. Check browser network tab to verify schedule object includes cron expression and timezone
3. Verify job appears in list with correct schedule

**Step 5: Commit**

```bash
git add packages/ui/src/components/sections/openchamber/CronSettings.tsx
git commit -m "feat(cron): update form submission to support preset/custom/cron modes"
```

---

## Task 5: Update Edit Job Function

**Files:**
- Modify: `packages/ui/src/components/sections/openchamber/CronSettings.tsx:162-174`

**Step 1: Create reverse mapper function (cron to preset)**

Add before CronSettings component:

```typescript
function cronExpressionToPreset(expr: string): string | null {
  const cronToPresetMap: Record<string, string> = {
    '0 0 * * * *': 'hourly-1',
    '0 0 */2 * * *': 'hourly-2',
    '0 0 */6 * * *': 'hourly-6',
    '0 0 */12 * * *': 'hourly-12',
    '0 0 9 * * *': 'daily-9',
    '0 0 12 * * *': 'daily-12',
    '0 0 17 * * *': 'daily-17',
    '0 0 21 * * *': 'daily-21',
    '0 0 9 * * 1': 'weekly-mon',
    '0 0 9 * * 2': 'weekly-tue',
    '0 0 9 * * 3': 'weekly-wed',
    '0 0 9 * * 4': 'weekly-thu',
    '0 0 9 * * 5': 'weekly-fri',
    '0 0 9 * * 1-5': 'weekly-weekdays',
    '0 0 9 * * 0,6': 'weekly-weekends',
    '0 0 9 1 * *': 'monthly-1',
    '0 0 9 15 * *': 'monthly-15',
    '0 0 9 L * *': 'monthly-last',
  };
  return cronToPresetMap[expr] || null;
}
```

**Step 2: Update editJob function**

Replace the editJob function (around line 162-174):

```typescript
const editJob = (job: CronJob) => {
  let scheduleMode: 'preset' | 'custom' | 'cron' = 'cron';
  let presetSchedule = 'hourly-1';
  let customDate = '';
  let customTime = '09:00';
  let cronExpression = '';

  if (job.schedule.kind === 'at' && job.schedule.at) {
    scheduleMode = 'custom';
    const date = new Date(job.schedule.at);
    customDate = date.toISOString().split('T')[0];
    customTime = date.toTimeString().slice(0, 5);
  } else if (job.schedule.kind === 'cron' && job.schedule.expr) {
    const preset = cronExpressionToPreset(job.schedule.expr);
    if (preset) {
      scheduleMode = 'preset';
      presetSchedule = preset;
    } else {
      scheduleMode = 'cron';
      cronExpression = job.schedule.expr;
    }
  } else if (job.schedule.kind === 'every') {
    scheduleMode = 'cron';
    cronExpression = `every ${job.schedule.everyMs}ms`;
  }

  setFormData({
    name: job.name,
    description: job.description || '',
    scheduleMode,
    presetSchedule,
    customDate,
    customTime,
    cronExpression,
    sessionTarget: job.sessionTarget,
    payloadKind: job.payload.kind,
    payloadText: job.payload.text || job.payload.message || '',
  });
  setEditingJob(job);
  setShowForm(true);
};
```

**Step 3: Test editing preset jobs**

Manual test:
1. Create a job with preset "Every hour"
2. Click edit button
3. Verify form shows "Preset" mode with "Every hour" selected

**Step 4: Test editing custom date/time jobs**

Manual test:
1. Create a job with custom date/time
2. Click edit button
3. Verify form shows "Custom Date/Time" mode with correct date and time

**Step 5: Test editing cron expression jobs**

Manual test:
1. Create a job with cron expression "0 0 13 * * *"
2. Click edit button
3. Verify form shows "Cron Expression" mode with expression filled in

**Step 6: Commit**

```bash
git add packages/ui/src/components/sections/openchamber/CronSettings.tsx
git commit -m "feat(cron): update editJob to properly load schedule mode"
```

---

## Task 6: Add Form Validation

**Files:**
- Modify: `packages/ui/src/components/sections/openchamber/CronSettings.tsx:73-110`

**Step 1: Add validation before form submission**

Update handleSubmit function to add validation:

```typescript
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();

  // Validation
  if (formData.scheduleMode === 'custom') {
    if (!formData.customDate) {
      setError('Please select a date');
      return;
    }
    if (!formData.customTime) {
      setError('Please select a time');
      return;
    }
  } else if (formData.scheduleMode === 'cron') {
    if (!formData.cronExpression.trim()) {
      setError('Please enter a cron expression');
      return;
    }
  }

  let schedule: CronJob['schedule'];

  if (formData.scheduleMode === 'preset') {
    schedule = {
      kind: 'cron',
      expr: presetToCronExpression(formData.presetSchedule),
      tz: globalTimezone,
    };
  } else if (formData.scheduleMode === 'custom') {
    const dateTime = new Date(`${formData.customDate}T${formData.customTime}`);
    if (dateTime <= new Date()) {
      setError('Please select a future date and time');
      return;
    }
    schedule = {
      kind: 'at',
      at: dateTime.toISOString(),
      tz: globalTimezone,
    };
  } else {
    schedule = {
      kind: 'cron',
      expr: formData.cronExpression,
      tz: globalTimezone,
    };
  }

  const job: Partial<CronJob> = {
    name: formData.name,
    description: formData.description,
    sessionTarget: formData.sessionTarget,
    schedule,
    payload: {
      kind: formData.payloadKind,
      ...(formData.payloadKind === 'systemEvent' && { text: formData.payloadText }),
      ...(formData.payloadKind === 'agentTurn' && { message: formData.payloadText }),
    },
  };

  try {
    const url = editingJob ? `/api/cron/${editingJob.jobId}` : '/api/cron';
    const method = editingJob ? 'PUT' : 'POST';

    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });

    if (!response.ok) throw new Error('Failed to save job');

    await fetchJobs();
    resetForm();
    setError(null);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to save job');
  }
};
```

**Step 2: Test validation - empty custom date**

Manual test:
1. Select "Custom Date/Time" mode
2. Leave date empty
3. Try to submit
Expected: Error message "Please select a date"

**Step 3: Test validation - past date**

Manual test:
1. Select "Custom Date/Time" mode
2. Enter a past date
3. Try to submit
Expected: Error message "Please select a future date and time"

**Step 4: Test validation - empty cron expression**

Manual test:
1. Select "Cron Expression" mode
2. Leave expression empty
3. Try to submit
Expected: Error message "Please enter a cron expression"

**Step 5: Commit**

```bash
git add packages/ui/src/components/sections/openchamber/CronSettings.tsx
git commit -m "feat(cron): add form validation for schedule inputs"
```

---

## Task 7: Add Helper Text and Tooltips

**Files:**
- Modify: `packages/ui/src/components/sections/openchamber/CronSettings.tsx`

**Step 1: Add helper text for cron expression mode**

Update the cron expression input section to include helper text:

```typescript
{formData.scheduleMode === 'cron' && (
  <div>
    <label className="typography-ui-label text-foreground block mb-1">Cron Expression</label>
    <Input
      value={formData.cronExpression}
      onChange={(e) => setFormData({ ...formData, cronExpression: e.target.value })}
      placeholder="0 0 9 * * 1-5"
      required
      className="h-7"
    />
    <p className="typography-meta text-muted-foreground text-xs mt-1">
      Format: seconds minutes hours day month weekday. Example: "0 0 9 * * 1-5" = 9 AM on weekdays
    </p>
  </div>
)}
```

**Step 2: Add helper text for global timezone**

Add a small info text below the timezone selector:

```typescript
<Select value={globalTimezone} onValueChange={setGlobalTimezone}>
  <SelectTrigger size="sm" className="h-7">
    <SelectValue placeholder="Select timezone" />
  </SelectTrigger>
  <SelectContent>
    {COMMON_TIMEZONES.map((tz) => (
      <SelectItem key={tz} value={tz}>
        {tz}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
<span className="typography-meta text-muted-foreground text-xs">
  Applied to new/edited jobs
</span>
```

**Step 3: Verify helper text displays**

Run: `bun run dev`
Expected: Helper text appears below cron expression input and timezone selector

**Step 4: Commit**

```bash
git add packages/ui/src/components/sections/openchamber/CronSettings.tsx
git commit -m "feat(cron): add helper text for cron expressions and timezone"
```

---

## Task 8: Run Type Check and Lint

**Files:**
- N/A (validation only)

**Step 1: Run TypeScript type check**

Run: `bun run type-check`
Expected: No TypeScript errors

If errors occur, fix them before proceeding.

**Step 2: Run ESLint**

Run: `bun run lint`
Expected: No linting errors

If errors occur, fix them before proceeding.

**Step 3: Run build**

Run: `bun run build`
Expected: Build completes successfully

**Step 4: Commit (if fixes were needed)**

```bash
git add packages/ui/src/components/sections/openchamber/CronSettings.tsx
git commit -m "fix(cron): resolve type and lint errors"
```

---

## Task 9: Manual End-to-End Testing

**Files:**
- N/A (testing only)

**Step 1: Test preset schedule creation**

1. Open cron settings page
2. Click "Add Job"
3. Fill in name: "Test Preset"
4. Select preset schedule: "Every hour"
5. Set timezone: "America/New_York"
6. Fill in message: "Test message"
7. Submit
8. Verify job appears in list with schedule showing "(cron)"
9. Click edit and verify preset is pre-selected correctly

**Step 2: Test custom date/time creation**

1. Click "Add Job"
2. Fill in name: "Test Custom"
3. Select "Custom Date/Time" mode
4. Pick a future date and time
5. Set timezone: "UTC"
6. Fill in message: "Test message"
7. Submit
8. Verify job appears in list with schedule showing "(at)"
9. Click edit and verify date/time is pre-filled correctly

**Step 3: Test cron expression creation**

1. Click "Add Job"
2. Fill in name: "Test Cron"
3. Select "Cron Expression" mode
4. Enter: "0 0 13 * * *"
5. Set timezone: "Europe/London"
6. Fill in message: "Test message"
7. Submit
8. Verify job appears in list with schedule showing "(cron)"
9. Click edit and verify expression is pre-filled correctly

**Step 4: Test validation**

1. Try to submit with empty required fields
2. Try to submit custom date/time with past date
3. Verify appropriate error messages appear

**Step 5: Test job execution**

1. Create a job with "Every hour" preset
2. Click the "Run Now" button
3. Verify success message appears
4. Check cron history (if available in UI) to verify job ran

**Step 6: Document any issues found**

Create a list of any bugs or issues discovered during testing and fix them in a separate commit.

---

## Task 10: Final Commit and Documentation

**Files:**
- N/A (finalization)

**Step 1: Review all changes**

Run: `git status`
Review: All modified files should be committed

**Step 2: Create final commit if needed**

```bash
git add -A
git commit -m "feat(cron): complete date/time picker with timezone selection"
```

**Step 3: Update CHANGELOG.md (if it exists)**

Add entry to CHANGELOG.md:

```markdown
## [Unreleased]

### Added
- Global timezone selector for cron jobs
- Preset schedule dropdown with common options (hourly, daily, weekly, monthly)
- Native date/time pickers for custom scheduling
- Schedule mode selector (Presets / Custom Date/Time / Cron Expression)
- Form validation for schedule inputs
- Helper text for cron expressions and timezone

### Changed
- Enhanced CronSettings component with more intuitive scheduling UI
- Improved job editing to properly load schedule mode
```

**Step 4: Commit changelog**

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG with cron datetime picker feature"
```

---

## Summary

This implementation adds:
- Global timezone selection dropdown
- Three schedule input modes: Presets, Custom Date/Time, Cron Expression
- 17 preset schedule options covering hourly, daily, weekly, and monthly patterns
- Native HTML date/time inputs for custom scheduling
- Form validation with user-friendly error messages
- Proper editing support that loads the correct schedule mode
- Helper text and documentation

**No new dependencies required** - all features use existing UI components and native HTML inputs.

**Total estimated time:** 2-3 hours for careful implementation and testing
