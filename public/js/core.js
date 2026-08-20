import { $, escapeHtml } from './utils.js';
import { state, defaultState, setState, resetState } from './state.js';

export let config = { features: {} };
export let clerk = null;
export let backendName = 'Connecting';

export function setConfig(next) { config = next; }
export function setClerk(next) { clerk = next; }

export function toast(message, type = '') {
  const region = $('#toast-region');
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  region.appendChild(item);
  setTimeout(() => {
    item.classList.add('leaving');
    setTimeout(() => item.remove(), 260);
  }, 4200);
}

export function setChip(id, text, status = '') {
  const chip = $(`#${id}`);
  if (!chip) return;
  chip.className = `status-chip ${status}`;
  chip.innerHTML = `<i></i>${escapeHtml(text)}`;
}

export async function getToken() {
  if (clerk?.session) return clerk.session.getToken();
  if (config.features.localDemo) return 'local-demo-token';
  throw new Error('Please sign in again.');
}

export async function apiFetch(url, options = {}) {
  const token = await getToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function describeBackend(name) {
  if (name === 'appwrite') return ['Appwrite synced', 'ready'];
  if (name === 'local-fallback') return ['Local fallback', ''];
  return ['Local data', ''];
}

export async function loadState() {
  try {
    const result = await apiFetch('/api/state');

    setState({
      ...defaultState(),
      ...(result.state || {}),
      settings: { ...defaultState().settings, ...(result.state?.settings || {}) },
    });
    backendName = result.backend || 'unknown';
    setChip('backend-chip', ...describeBackend(backendName));
  } catch (error) {
    console.error(error);

    resetState();
    backendName = 'unavailable';
    setChip('backend-chip', 'Data unavailable', 'error');
    toast(error.message, 'error');
  }
  $('#sidebar-care-note').textContent = state.settings.caregiverNote;
}

let saveTimer = null;

export async function persistState(showToast = false) {
  clearTimeout(saveTimer);
  try {
    const result = await apiFetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    backendName = result.backend || backendName;
    state.updatedAt = result.state?.updatedAt || new Date().toISOString();
    setChip('backend-chip', backendName === 'appwrite' ? 'Appwrite synced' : 'Saved locally', backendName === 'appwrite' ? 'ready' : '');
    if (showToast) toast('Meco saved your changes.', 'success');
  } catch (error) {
    setChip('backend-chip', 'Save failed', 'error');
    toast(error.message, 'error');
    throw error;
  }
}

export function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistState().catch(() => {}), 500);
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function dateParts(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  const diffDays = Math.round((date - new Date(`${todayISO()}T00:00:00`)) / 86400000);
  return {
    day: date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
    tag: diffDays === 0 ? 'Today' : diffDays === 1 ? 'Tomorrow' : date.toLocaleDateString(undefined, { weekday: 'long' }),
    isToday: diffDays === 0,
    isPast: diffDays < 0,
  };
}

export const RERENDER_EVENT = 'meco:rerender';
export function requestRerender() {
  window.dispatchEvent(new CustomEvent(RERENDER_EVENT));
}
