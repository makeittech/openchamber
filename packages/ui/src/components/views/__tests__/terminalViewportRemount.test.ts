/**
 * Regression guard for slow terminal opening on Linux.
 *
 * `TerminalViewport` is keyed by `terminalViewportKey`. That key used to include
 * the PTY session id, which is null until `createSession` resolves. Because the
 * viewport must mount first to report its size before a session can be created,
 * every terminal open built a Ghostty terminal (WASM VT + 2D canvas renderer +
 * font atlas), threw it away when the session id arrived, and built a second one.
 * The same churn repeated on reconnect and on every incidental session-id change,
 * and the repeated WASM terminal allocate/free cycles are the suspected source of
 * the reported crashes.
 *
 * Viewport identity must therefore be directory + tab only. Session changes are
 * handled by the chunk replay path, which resets the existing terminal in place.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const terminalViewSource = readFileSync(join(__dirname, '..', 'TerminalView.tsx'), 'utf-8');
const terminalViewportSource = readFileSync(
    join(__dirname, '..', '..', 'terminal', 'TerminalViewport.tsx'),
    'utf-8',
);

const viewportKeyDeclaration = terminalViewSource
    .split('\n')
    .find((line) => line.includes('const terminalViewportKey =')) ?? '';

describe('terminal viewport remount guard', () => {
    test('viewport identity excludes the PTY session id', () => {
        expect(viewportKeyDeclaration).toContain('effectiveDirectory');
        expect(viewportKeyDeclaration).toContain('activeTabId');
        expect(viewportKeyDeclaration).not.toContain('terminalSessionId');
    });

    test('replay discontinuities reset the terminal in place instead of remounting it', () => {
        const start = terminalViewportSource.indexOf('const recreateRenderer = React.useCallback(');
        expect(start).toBeGreaterThan(-1);
        const body = terminalViewportSource.slice(start, terminalViewportSource.indexOf('}, []);', start));
        expect(body).toContain('terminal.reset()');
        // The generation bump stays only as the fallback when no terminal exists yet.
        expect(body.indexOf('if (!terminal)')).toBeLessThan(body.indexOf('terminal.reset()'));
    });

    test('scrollback is read from the buffer slice, not from the tab', () => {
        expect(terminalViewSource).toContain('getBuffer(');
        expect(terminalViewSource).not.toContain('activeTab?.bufferChunks');
    });
});
