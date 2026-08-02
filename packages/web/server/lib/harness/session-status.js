import { listHarnessActiveStatuses } from './turn-snapshot.js';

export function mergeHarnessActiveIntoSessionStatuses(openCodeStatuses, directory) {
  const base = openCodeStatuses && typeof openCodeStatuses === 'object' && !Array.isArray(openCodeStatuses)
    ? { ...openCodeStatuses }
    : {};
  return Object.assign(base, listHarnessActiveStatuses(directory));
}
