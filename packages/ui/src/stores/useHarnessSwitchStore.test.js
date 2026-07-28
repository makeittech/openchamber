import { beforeEach, describe, expect, mock, test } from 'bun:test';

const getSyncMessagesMock = mock(() => []);
const updateDesktopSettingsMock = mock(() => Promise.resolve());
const performHarnessHandoffMock = mock(() => Promise.resolve());

mock.module('@/sync/sync-refs', () => ({
  getSyncMessages: (...args) => getSyncMessagesMock(...args),
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: (...args) => updateDesktopSettingsMock(...args),
}));

mock.module('@/lib/harness/perform-handoff', () => ({
  performHarnessHandoff: (...args) => performHarnessHandoffMock(...args),
}));

const { useSelectionStore } = await import('@/sync/selection-store');
const { useHarnessSwitchStore } = await import(`@/stores/useHarnessSwitchStore?cache-test=${Date.now()}`);
const { setCachedWarnOnHarnessSwitch } = await import('@/lib/harness/settings');

const OPENCODE_TARGET = { harnessId: 'opencode', providerId: 'openai', modelId: 'gpt-5' };
const CLAUDE_TARGET = { harnessId: 'claude-code', modelRef: 'sonnet' };

beforeEach(() => {
  getSyncMessagesMock.mockReset();
  getSyncMessagesMock.mockImplementation(() => []);
  updateDesktopSettingsMock.mockClear();
  performHarnessHandoffMock.mockClear();
  performHarnessHandoffMock.mockImplementation(() => Promise.resolve());
  useSelectionStore.setState({
    sessionTargets: new Map(),
    pendingHandoffTargets: new Map(),
    lastUsedTarget: null,
  });
  useHarnessSwitchStore.setState({ pending: null, switching: false, error: null });
  setCachedWarnOnHarnessSwitch(true);
});

describe('requestHarnessSwitch', () => {
  test('no session records last-used target', () => {
    const outcome = useHarnessSwitchStore.getState().requestHarnessSwitch(null, CLAUDE_TARGET);
    expect(outcome).toBe('last-used');
    expect(useSelectionStore.getState().lastUsedTarget).toEqual(CLAUDE_TARGET);
  });

  test('empty session persists in place without a dialog', () => {
    getSyncMessagesMock.mockImplementation(() => []);
    const outcome = useHarnessSwitchStore.getState().requestHarnessSwitch('ses_1', CLAUDE_TARGET);
    expect(outcome).toBe('persisted');
    expect(useSelectionStore.getState().getSessionTarget('ses_1')).toEqual(CLAUDE_TARGET);
    expect(useHarnessSwitchStore.getState().pending).toBeNull();
  });

  test('same harness on a used session persists in place', () => {
    getSyncMessagesMock.mockImplementation(() => [{ id: 'm1', role: 'user' }]);
    useSelectionStore.getState().saveSessionTarget('ses_1', OPENCODE_TARGET);
    const next = { harnessId: 'opencode', providerId: 'anthropic', modelId: 'claude-4' };
    const outcome = useHarnessSwitchStore.getState().requestHarnessSwitch('ses_1', next);
    expect(outcome).toBe('persisted');
    expect(useHarnessSwitchStore.getState().pending).toBeNull();
  });

  test('used session + different harness + warn on opens the dialog', () => {
    getSyncMessagesMock.mockImplementation(() => [{ id: 'm1', role: 'user' }]);
    useSelectionStore.getState().saveSessionTarget('ses_1', OPENCODE_TARGET);
    const outcome = useHarnessSwitchStore.getState().requestHarnessSwitch('ses_1', CLAUDE_TARGET, { directory: '/repo' });
    expect(outcome).toBe('dialog');
    const pending = useHarnessSwitchStore.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending.sessionId).toBe('ses_1');
    expect(pending.sourceHarnessId).toBe('opencode');
    expect(pending.target).toEqual(CLAUDE_TARGET);
    expect(pending.directory).toBe('/repo');
    // Picker target must not leak into the pending-handoff send path.
    expect(useSelectionStore.getState().getPendingHandoffTarget('ses_1')).toBeNull();
  });

  test('used session + different harness + warn off stays a silent pending handoff', () => {
    getSyncMessagesMock.mockImplementation(() => [{ id: 'm1', role: 'user' }]);
    useSelectionStore.getState().saveSessionTarget('ses_1', OPENCODE_TARGET);
    setCachedWarnOnHarnessSwitch(false);
    const outcome = useHarnessSwitchStore.getState().requestHarnessSwitch('ses_1', CLAUDE_TARGET);
    expect(outcome).toBe('pending-handoff');
    expect(useSelectionStore.getState().getPendingHandoffTarget('ses_1')).toEqual(CLAUDE_TARGET);
    expect(useHarnessSwitchStore.getState().pending).toBeNull();
  });
});

describe('confirmHarnessSwitch', () => {
  const openDialog = () => {
    getSyncMessagesMock.mockImplementation(() => [{ id: 'm1', role: 'user' }]);
    useSelectionStore.getState().saveSessionTarget('ses_1', OPENCODE_TARGET);
    useHarnessSwitchStore.getState().requestHarnessSwitch('ses_1', CLAUDE_TARGET, { directory: '/repo' });
  };

  test('performs the handoff and closes the dialog', async () => {
    openDialog();
    await useHarnessSwitchStore.getState().confirmHarnessSwitch('duplicate', false);
    expect(performHarnessHandoffMock).toHaveBeenCalledTimes(1);
    expect(performHarnessHandoffMock).toHaveBeenCalledWith({
      sourceSessionId: 'ses_1',
      directory: '/repo',
      sourceHarnessId: 'opencode',
      target: CLAUDE_TARGET,
      mode: 'duplicate',
    });
    expect(useHarnessSwitchStore.getState().pending).toBeNull();
    expect(useHarnessSwitchStore.getState().switching).toBe(false);
    expect(updateDesktopSettingsMock).not.toHaveBeenCalled();
  });

  test('dont-show-again persists only after a successful switch', async () => {
    openDialog();
    await useHarnessSwitchStore.getState().confirmHarnessSwitch('summarize', true);
    expect(updateDesktopSettingsMock).toHaveBeenCalledWith({ harnessWarnOnSwitch: false });
  });

  test('failure keeps the dialog open with the error and does not persist dismissal', async () => {
    performHarnessHandoffMock.mockImplementation(() => Promise.reject(new Error('compact failed')));
    openDialog();
    await useHarnessSwitchStore.getState().confirmHarnessSwitch('summarize', true);
    expect(useHarnessSwitchStore.getState().pending).not.toBeNull();
    expect(useHarnessSwitchStore.getState().switching).toBe(false);
    expect(useHarnessSwitchStore.getState().error).toBe('compact failed');
    expect(updateDesktopSettingsMock).not.toHaveBeenCalled();
  });

  test('cancel clears the pending request', () => {
    openDialog();
    useHarnessSwitchStore.getState().cancelHarnessSwitch();
    expect(useHarnessSwitchStore.getState().pending).toBeNull();
  });
});
