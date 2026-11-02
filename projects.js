// Project names are also the existing annotation namespaces. Preserve their case.
export const PROJECT_MAPS = Object.freeze({
  Aleppo_2026_Q2: Object.freeze(['aleppo']),
  Dezful_2026_Q2: Object.freeze(['dezful']),
  EPAS_2026_Q2: Object.freeze(['erbil']),
  Test: Object.freeze(['erbil']),
});
export const PROJECTS = Object.freeze(Object.keys(PROJECT_MAPS).sort());

export function mapsForProject(project) {
  if (!Object.hasOwn(PROJECT_MAPS, project)) throw new Error('Select a valid project');
  return PROJECT_MAPS[project];
}

export function projectAllowsMap(project, id) {
  return Object.hasOwn(PROJECT_MAPS, project) && PROJECT_MAPS[project].includes(id);
}
