import { describe, expect, test } from 'bun:test';

import { shouldDeferComposerWriteback } from '../writeback';

describe('composer value writeback composition guard (issue #2527)', () => {
    test('defers the controlled echo while composition is active', () => {
        expect(shouldDeferComposerWriteback(true, 'ni', 'ni')).toBe(true);
    });

    test('keeps an external value authoritative during composition', () => {
        expect(shouldDeferComposerWriteback(true, 'ni @src/app.ts', 'ni')).toBe(false);
    });

    test('does not defer writeback after composition ends', () => {
        expect(shouldDeferComposerWriteback(false, 'ni', 'ni')).toBe(false);
    });
});
