/* Two-way Google Calendar sync for scheduled visits and reminders */

import { $, $$, escapeHtml } from './utils.js';
import { state } from './state.js';
import { clerk, apiFetch, toast, persistState, todayISO, requestRerender } from './core.js';

// Local calendar date (not UTC) so "today" matches the caregiver's clock.
export function calendarSyncEnabled() {
  return Boolean(state.settings.googleCalendarSync)
    && Boolean(clerk?.user?.externalAccounts?.some((account) => account.provider === 'google' && String(account.approvedScopes || '').includes('calendar')));
}

export const syncedBadge = (record) => (record.googleEventId ? '<span class="badge synced-badge">Synced</span>' : '');

// Only a "weekly on these days
export const REPEAT_DAY_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const REPEAT_DAY_LABELS = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const defaultRepeat = () => ({ freq: 'none', days: [] });

export function repeatBadgeMarkup(repeat) {
  if (!repeat || repeat.freq !== 'weekly' || !repeat.days?.length) return '';
  const days = REPEAT_DAY_ORDER.filter((day) => repeat.days.includes(day)).map((day) => REPEAT_DAY_LABELS[day]);
  const summary = days.length === 7 ? 'Every day' : `Weekly · ${days.join(', ')}`;
  return `<small class="repeat-badge">↻ ${escapeHtml(summary)}</small>`;
}

// Reads the shared repeat UI
export function readRepeatFromModal(prefix) {
  const freq = $(`#${prefix}-repeat-freq`)?.value === 'weekly' ? 'weekly' : 'none';
  if (freq !== 'weekly') return defaultRepeat();
  const days = $$(`#${prefix}-repeat-days .repeat-day-chip.selected`).map((chip) => chip.dataset.day);
  return { freq: 'weekly', days };
}

export function populateRepeatModal(prefix, repeat, fallbackDate) {
  const value = repeat && repeat.freq === 'weekly' && repeat.days?.length ? repeat : defaultRepeat();
  $(`#${prefix}-repeat-freq`).value = value.freq;
  $(`#${prefix}-repeat-days`).hidden = value.freq !== 'weekly';
  $$(`#${prefix}-repeat-days .repeat-day-chip`).forEach((chip) => chip.classList.toggle('selected', value.days.includes(chip.dataset.day)));
  // Wired once per app load
  if (populateRepeatModal.wiredPrefixes?.has(prefix)) return;
  (populateRepeatModal.wiredPrefixes ??= new Set()).add(prefix);
  $(`#${prefix}-repeat-freq`).addEventListener('change', (event) => {
    const daysRow = $(`#${prefix}-repeat-days`);
    daysRow.hidden = event.target.value !== 'weekly';
    // A sensible default: the day of week already picked as the date
    if (event.target.value === 'weekly' && !$$(`#${prefix}-repeat-days .repeat-day-chip.selected`).length) {
      const dateValue = $(`#${prefix}-date`).value;
      if (dateValue) {
        const dayCode = REPEAT_DAY_ORDER[(new Date(`${dateValue}T00:00:00`).getDay() + 6) % 7];
        $(`#${prefix}-repeat-days .repeat-day-chip[data-day="${dayCode}"]`)?.classList.add('selected');
      }
    }
  });
  $$(`#${prefix}-repeat-days .repeat-day-chip`).forEach((chip) => chip.addEventListener('click', () => chip.classList.toggle('selected')));
}

// Google Calendar events have no native "completed" state
const DONE_PREFIX = /^✓\s*/;
export const reminderTitle = (reminder) => `${reminder.done ? '✓ ' : ''}${reminder.text}`;

// Best-effort mirroring to Google Calendar. Never blocks the Meco save/delete
// itself: a failed calendar call only surfaces as a toast.
export async function syncToCalendar(record, title, description) {
  if (!calendarSyncEnabled()) return;
  try {
    const result = await apiFetch('/api/calendar/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        googleEventId: record.googleEventId || null,
        title,
        description,
        date: record.date,
        time: record.time,
        endTime: record.endTime || '',
        repeat: record.repeat || defaultRepeat(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    record.googleEventId = result.googleEventId;
  } catch (error) {
    toast(`Saved, but Google Calendar sync failed: ${error.message}`, 'error');
  }
}

export async function unsyncFromCalendar(record) {
  if (!calendarSyncEnabled() || !record?.googleEventId) return;
  try {
    await apiFetch('/api/calendar/unsync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleEventId: record.googleEventId }),
    });
  } catch {}
}

// Converts a Google event's start/end back into Meco's date/time/end-time
// fields. All-day Google events have no time component.
function parseGoogleEventTiming(start, end) {
  const pad = (value) => String(value).padStart(2, '0');
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (start?.dateTime) {
    const startDate = new Date(start.dateTime);
    const endDate = end?.dateTime ? new Date(end.dateTime) : null;
    return {
      date: `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`,
      time: hm(startDate),
      endTime: endDate && endDate.toDateString() === startDate.toDateString() ? hm(endDate) : '',
    };
  }
  return { date: start?.date || todayISO(), time: '', endTime: '' };
}

// The inverse of the RRULE Meco's own sync builds server-side
function parseRecurrenceRule(recurrence) {
  const rule = (recurrence || []).find((entry) => entry.startsWith('RRULE:'));
  if (!rule) return defaultRepeat();
  const params = Object.fromEntries(rule.slice(6).split(';').map((pair) => pair.split('=')));
  if (params.FREQ === 'WEEKLY' && params.BYDAY) {
    const days = params.BYDAY.split(',').filter((day) => REPEAT_DAY_ORDER.includes(day));
    if (days.length) return { freq: 'weekly', days };
  }
  return defaultRepeat();
}

// One-way-back reconciliation
export async function pullFromCalendar() {
  if (!calendarSyncEnabled()) return;
  const tracked = [...state.visits, ...state.reminders].filter((record) => record.googleEventId);
  if (!tracked.length) return;
  let result;
  try {
    result = await apiFetch('/api/calendar/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventIds: tracked.map((record) => record.googleEventId) }),
    });
  } catch {
    return;
  }
  let changed = false;
  for (const update of result.events || []) {
    if (update.unchanged) continue;
    const visitIndex = state.visits.findIndex((item) => item.googleEventId === update.googleEventId);
    const reminderIndex = visitIndex === -1 ? state.reminders.findIndex((item) => item.googleEventId === update.googleEventId) : -1;
    if (update.deleted) {
      if (visitIndex !== -1) { state.visits.splice(visitIndex, 1); changed = true; }
      else if (reminderIndex !== -1) { state.reminders.splice(reminderIndex, 1); changed = true; }
      continue;
    }
    const timing = parseGoogleEventTiming(update.start, update.end);
    const repeat = parseRecurrenceRule(update.recurrence);
    if (visitIndex !== -1) {
      const visit = state.visits[visitIndex];
      const next = { ...visit, visitorName: (update.summary || '').replace(/^Visit:\s*/, '').trim() || visit.visitorName, note: update.description ?? visit.note, ...timing, repeat };
      if (JSON.stringify(next) !== JSON.stringify(visit)) { state.visits[visitIndex] = next; changed = true; }
    } else if (reminderIndex !== -1) {
      const reminder = state.reminders[reminderIndex];
      const rawTitle = update.summary || reminderTitle(reminder);
      const done = DONE_PREFIX.test(rawTitle);
      const text = rawTitle.replace(DONE_PREFIX, '') || reminder.text;
      const next = { ...reminder, text, done, ...timing, repeat };
      if (JSON.stringify(next) !== JSON.stringify(reminder)) { state.reminders[reminderIndex] = next; changed = true; }
    }
  }
  if (changed) {
    try { await persistState(false); } catch { return; }
    // The pull may have rewritten visits/reminders underneath whatever is on
    // screen; app.js re-renders the current page if it is one that shows them.
    requestRerender();
    toast('Updated from Google Calendar.', 'success');
  }
}

let calendarPollTimer = null;
export function startCalendarPolling() {
  if (calendarPollTimer) clearInterval(calendarPollTimer);
  calendarPollTimer = setInterval(pullFromCalendar, 90000);
}
