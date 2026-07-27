import { describe, expect, test } from 'bun:test';

import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';
import { tryParseJsonOutput } from '../toolRenderers';
import { formatToolDurationMs } from './formatToolDuration';
describe('readTaskTagSessionIdFromOutput', () => {
    test('parses task tags without state attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_abc123">')).toBe('ses_abc123');
    });

    test('parses task tags with additional attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_def456" state="completed">')).toBe('ses_def456');
    });
});

describe('OpenChamber tool output', () => {
    test('keeps the result envelope in the generic JSON rendering pipeline', () => {
        const result = {
            schemaVersion: 1,
            ok: true,
            action: 'projects.list',
            data: { projects: [] },
        };
        expect(tryParseJsonOutput(JSON.stringify(result))).toEqual({ data: result, isJson: true });
    });
});

describe('formatToolDurationMs', () => {
    test('formats sub-minute durations with one decimal second', () => {
        expect(formatToolDurationMs(1_500)).toBe('1.5s');
        expect(formatToolDurationMs(0)).toBe('0.1s');
    });

    test('keeps counting past five minutes instead of capping at 300.0s', () => {
        expect(formatToolDurationMs(5 * 60 * 1000)).toBe('5m');
        expect(formatToolDurationMs(5 * 60 * 1000 + 12_000)).toBe('5m 12s');
        expect(formatToolDurationMs(65 * 60 * 1000)).toBe('1h 5m');
        expect(formatToolDurationMs(2 * 60 * 60 * 1000)).toBe('2h');
    });
});
