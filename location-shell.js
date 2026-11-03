import {LOCATIONS} from './locations.js';
import {PROJECTS, mapsForProject, projectAllowsMap} from './projects.js';

const projectSelector = document.querySelector('#project-select');
const selector = document.querySelector('#location-select');
const status = document.querySelector('#location-status');
const host = document.querySelector('#location-host');
const prompt = document.querySelector('#project-prompt');
const sessions = new Map();
// Identity is shared in memory. Each viewer owns an immutable project and map.
let project = null, auth = null, current = null, busy = false;
// Page lifetime only, shared across project viewers; a reload resets the choice.
let finishReminderSuppressed = false;
const scopeKey = (name, id) => `${name}:${id}`;

for (const name of PROJECTS) projectSelector.add(new Option(name, name));

function requireScope(name, id) {
  if (!projectAllowsMap(name, id)) throw new Error('Map is unavailable in the selected project');
  const session = sessions.get(scopeKey(name, id));
  if (!session) throw new Error('Unknown project session');
  return session;
}

function updateControls() {
  projectSelector.disabled = busy;
  selector.disabled = busy || !auth || !project || mapsForProject(project).length < 2;
}

function showContext() {
  projectSelector.value = project;
  selector.replaceChildren(...mapsForProject(project).map(id => new Option(LOCATIONS[id].name, id)));
  selector.value = current;
  document.title = `Qanat label tool · ${project} · ${LOCATIONS[current].name}`;
  status.textContent = `${project} · ${LOCATIONS[current].name} · ${LOCATIONS[current].crs}${auth ? '' : ' · Unlock to label'}`;
  const url = new URL(location.href);
  url.searchParams.set('project', project);
  url.searchParams.set('location', current);
  history.replaceState(null, '', url);
}

window.labelLocations = {
  shouldConfirmFinish() { return !finishReminderSuppressed; },
  suppressFinishReminder() { finishReminderSuppressed = true; },
  projectFor(id, name) { requireScope(name, id); return name; },
  getSession(id, name) {
    requireScope(name, id);
    return auth ? {...auth, project: name} : null;
  },
  beginLogin(id, name) {
    requireScope(name, id);
    if (busy || name !== project || id !== current || auth) return false;
    busy = true;
    updateControls();
    return true;
  },
  endLogin() { busy = false; updateControls(); },
  authenticated(id, bundle) {
    const {project: name, ...identity} = bundle;
    requireScope(name, id);
    if (auth && (identity.me !== auth.me || identity.su !== auth.su || identity.writeToken !== auth.writeToken)) {
      throw new Error('Login identity mismatch');
    }
    auth ||= identity;
    updateControls();
  },
  ready(id, name) {
    const s = requireScope(name, id);
    s.ready = true;
    s.resolve();
    if (name === project && id === current) showContext();
    updateControls();
  },
  failed(id, name, message) {
    sessions.get(scopeKey(name, id))?.reject(new Error(message));
  },
};

function frame(name, id) {
  if (!projectAllowsMap(name, id)) throw new Error('Map is unavailable in the selected project');
  const key = scopeKey(name, id);
  if (sessions.has(key)) return sessions.get(key);
  const el = document.createElement('iframe');
  el.className = 'location-panel loading';
  el.title = `${LOCATIONS[id].name} labeling`;
  el.dataset.project = name;
  el.dataset.location = id;
  const params = new URLSearchParams({location: id, project: name});
  if (new URLSearchParams(location.search).get('gtreview') === '1') params.set('gtreview', '1');
  el.src = `viewer.html?${params}`;
  let resolve, reject;
  const loaded = new Promise((a, b) => { resolve = a; reject = b; });
  // The initial gate has no awaiting switch yet.
  loaded.catch(() => {});
  const s = {el, loaded, resolve, reject, ready: false};
  sessions.set(key, s);
  host.append(el);
  return s;
}

function chooseProject() {
  const chosen = projectSelector.value;
  if (busy || chosen === project) { projectSelector.value = project || ''; return; }
  const maps = mapsForProject(chosen);
  if (auth) {
    void selectScope(chosen, maps.includes(current) ? current : maps[0]);
    return;
  }
  for (const s of sessions.values()) s.el.remove();
  sessions.clear();
  project = chosen;
  const requested = new URLSearchParams(location.search).get('location');
  current = maps.includes(requested) ? requested : maps[0];
  prompt.hidden = true;
  frame(project, current).el.classList.remove('loading');
  showContext();
  updateControls();
}

async function selectScope(name, id) {
  if (busy || !auth || (name === project && id === current)) {
    projectSelector.value = project || '';
    selector.value = current || '';
    return;
  }
  const prior = sessions.get(scopeKey(project, current));
  const key = scopeKey(name, id);
  busy = true;
  projectSelector.value = project;
  selector.value = current;
  updateControls();
  try {
    if (!projectAllowsMap(name, id)) throw new Error('Map is unavailable in the selected project');
    if (prior && !await prior.el.contentWindow.labelLocationSession.canLeave()) return;
    if (prior) prior.el.inert = true;
    status.textContent = `Loading ${name} · ${LOCATIONS[id].name}…`;
    const next = frame(name, id);
    let timer;
    try {
      await Promise.race([next.loaded, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Project load timed out; current work is retained.')), 120000);
      })]);
    } finally { clearTimeout(timer); }
    for (const [sessionKey, s] of sessions) s.el.classList.toggle('loading', sessionKey !== key);
    project = name;
    current = id;
    showContext();
    next.el.contentWindow.focus();
  } catch (e) {
    status.textContent = `Could not open ${name}: ${e.message}`;
    const failed = sessions.get(key);
    if (failed && !failed.ready && failed !== prior) { failed.el.remove(); sessions.delete(key); }
  } finally {
    if (prior) prior.el.inert = false;
    projectSelector.value = project;
    selector.value = current;
    busy = false;
    updateControls();
  }
}

projectSelector.addEventListener('change', chooseProject);
selector.addEventListener('change', () => void selectScope(project, selector.value));
window.addEventListener('beforeunload', e => {
  if ([...sessions.values()].some(s => s.el.contentWindow.labelLocationSession?.hasUnsaved())) {
    e.preventDefault(); e.returnValue = '';
  }
});
