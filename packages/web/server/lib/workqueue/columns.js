// Board column <-> Linear workflow-state-type mapping. GitHub has no
// equivalent workflow-state concept, so only Linear items round-trip here.
const LINEAR_STATE_TYPE_BY_COLUMN = {
  backlog: 'backlog',
  todo: 'unstarted',
  in_progress: 'started',
  done: 'completed',
};

export function mapLinearStateTypeToColumn(stateType) {
  switch (stateType) {
    case 'triage':
    case 'backlog':
      return 'backlog';
    case 'unstarted':
      return 'todo';
    case 'started':
      return 'in_progress';
    case 'completed':
    case 'canceled':
      return 'done';
    default:
      return 'backlog';
  }
}

export function columnToLinearStateType(column) {
  return LINEAR_STATE_TYPE_BY_COLUMN[column] ?? null;
}
