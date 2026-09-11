// Shared crop workflow rules. Server RPCs enforce these independently.
export function workflowPermissions(state = {}, actor, superuser) {
  const finished = !!state.finished_by, approved = !!state.approved_by;
  return {edit:!finished, finish:!finished,
    reopen: finished && (superuser || (!approved && state.finished_by === actor)),
    approve: !!superuser && finished && !approved,
    unapprove: !!superuser && approved};
}
export function statusPasses(state = {}, field, filter = {}) {
  const who = state[field];
  if (filter.mode === 'none') return !who;
  if (filter.mode === 'any') return !!who;
  if (filter.mode === 'people') return !!who && filter.people.has(who);
  return true;
}
export function workflowSummary(state = {}) {
  if (!state.finished_by) return 'Unfinished';
  const finished = `Finished by ${state.finished_by}${state.finished_at ? ' · ' + new Date(state.finished_at).toLocaleString() : ''}`;
  return state.approved_by
    ? `${finished}; Approved by ${state.approved_by}${state.approved_at ? ' · ' + new Date(state.approved_at).toLocaleString() : ''}`
    : finished;
}
// One badge per state; shape and accessible text distinguish approval.
export function workflowBadge(state = {}) {
  if (state.approved_by) return '<svg viewBox="0 0 20 22" class="approved-badge" role="img" aria-label="Approved"><path d="M10 1 L18 4 V11 Q18 17 10 21 Q2 17 2 11 V4 Z" fill="currentColor"/><path d="M5 10 L9 14 L15 7" fill="none" stroke="white" stroke-width="2"/></svg>';
  return state.finished_by ? '<span role="img" aria-label="Finished">✓</span>' : '';
}
