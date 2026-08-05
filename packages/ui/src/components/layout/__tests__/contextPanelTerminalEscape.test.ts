import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for issue #2644: pressing Escape inside the terminal pane
// must reach the terminal (Vim's Normal mode, menu cancels, shell line
// editing) instead of closing the context panel.
//
// The context panel's <aside> intercepts Escape in the capture phase
// (`onKeyDownCapture={handlePanelKeyDownCapture}`) and closes the panel. The
// terminal lives inside that aside, so without a guard every Escape was
// swallowed by the capture handler before the terminal's own listeners saw
// it, and the pane closed — making it impossible to exit Vim.
//
// The guard must run before `preventDefault`/`handleClose` and must match on
// the terminal viewport's `data-terminal-owner` marker.

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(
    join(__dirname, '..', 'ContextPanel.tsx'),
    'utf-8',
);
const terminalViewportSource = readFileSync(
    join(__dirname, '..', '..', 'terminal', 'TerminalViewport.tsx'),
    'utf-8',
);

const extractCallback = (name: string): string => {
    const start = contextPanelSource.indexOf(`const ${name} = React.useCallback(`);
    expect(start).toBeGreaterThan(-1);
    // The callback ends at the dependency-array close `}, [...])`; find the
    // first `}, [` after the handler opens.
    const tail = contextPanelSource.slice(start);
    const close = tail.indexOf('}, [');
    expect(close).toBeGreaterThan(-1);
    return tail.slice(0, close + 3);
};

describe('context panel Escape handling (issue #2644 regression guard)', () => {
    test('the panel still closes on Escape outside the terminal', () => {
        const handler = extractCallback('handlePanelKeyDownCapture');

        expect(handler).toContain(`event.key !== 'Escape'`);
        expect(handler).toContain('event.preventDefault()');
        expect(handler).toContain('event.stopPropagation()');
        expect(handler).toContain('handleClose()');
    });

    test('Escape inside the terminal returns before the panel closes', () => {
        const handler = extractCallback('handlePanelKeyDownCapture');

        const guardIndex = handler.indexOf('isTerminalEventTarget(event.target)');
        const preventDefaultIndex = handler.indexOf('event.preventDefault()');

        // The terminal guard is present...
        expect(guardIndex).toBeGreaterThan(-1);
        // ...and runs before the close path, so the key is not swallowed.
        expect(preventDefaultIndex).toBeGreaterThan(guardIndex);
    });

    test('the guard matches on the terminal viewport marker', () => {
        // The guard relies on `data-terminal-owner` (see lib/terminalFocus.ts);
        // if the terminal viewport ever stops carrying it, the guard silently
        // stops matching and Escape closes the pane again.
        expect(terminalViewportSource).toContain('data-terminal-owner="main"');
        expect(contextPanelSource).toContain(
            "import { isTerminalEventTarget } from '@/lib/terminalFocus';",
        );
    });
});
