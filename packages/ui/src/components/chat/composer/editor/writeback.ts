export function shouldDeferComposerWriteback(
    compositionStarted: boolean,
    value: string,
    reportedValue: string | null,
): boolean {
    return compositionStarted && value === reportedValue;
}
