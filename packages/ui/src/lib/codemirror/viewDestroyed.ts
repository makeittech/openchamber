import type { EditorView } from '@codemirror/view';

// `EditorView.destroyed` is a plain class field CodeMirror flips on `destroy()`,
// but its type declaration marks it `private`, so TypeScript blocks direct
// access even though it's set and readable at runtime. This is the narrowest
// way to read it without a blind `any` cast.
export function isViewDestroyed(view: EditorView): boolean {
    return (view as unknown as { destroyed: boolean }).destroyed === true;
}
