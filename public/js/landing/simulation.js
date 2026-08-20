/* The "Watch Meco learn" homepage simulation. */

import { $, escapeHtml } from '../utils.js';
import { ASSISTANCE_LADDER, recommendAssistanceLevel, functionalSummary } from '/assistance-engine.mjs';

export function initAssistanceSimulation() {
  const root = $('[data-sim]');
  if (!root) return;

  const TASK = 'make-tea';
  let attempts = [];

  const levelNameEl = root.querySelector('[data-sim-level-name]');
  const meterEl = root.querySelector('[data-sim-meter]');
  const reasonEl = root.querySelector('[data-sim-reason]');
  const attemptsEl = root.querySelector('[data-sim-attempts]');
  const logEl = root.querySelector('[data-sim-log]');
  const logEmptyEl = root.querySelector('[data-sim-log-empty]');

  const render = () => {
    const rec = recommendAssistanceLevel(TASK, attempts);
    const summary = functionalSummary(TASK, attempts);

    levelNameEl.textContent = `Level ${rec.level}, ${rec.ladder.name}`;

    // Seven segments, filled up to the current level: a glance shows how
    // much help is being given without reading anything.
    meterEl.innerHTML = ASSISTANCE_LADDER.map((rung) => `
      <span class="sim-seg${rung.level <= rec.level ? ' is-on' : ''}${rung.level === rec.level ? ' is-current' : ''}"
            title="Level ${rung.level}, ${escapeHtml(rung.name)}"></span>`).join('');
    meterEl.setAttribute('aria-label', `Assistance level ${rec.level} of 6: ${rec.ladder.name}`);

    reasonEl.textContent = rec.reason;
    reasonEl.className = `sim-reason${rec.changed ? ` is-${rec.changed}` : ''}`;

    attemptsEl.textContent = summary.observed
      ? `${summary.observed} attempt${summary.observed === 1 ? '' : 's'} recorded · ${summary.summary}`
      : 'No attempts recorded yet';

    logEmptyEl.hidden = attempts.length > 0;
    logEl.innerHTML = attempts.slice(0, 8).map((a) => `
      <li class="sim-log-row ${a.outcome === 'success' ? 'ok' : 'no'}">
        <span class="sim-log-dot" aria-hidden="true"></span>
        <span class="sim-log-text">
          <strong>${a.outcome === 'success' ? 'Managed it' : 'Got stuck'}</strong>
          at level ${a.assistanceLevel}, ${escapeHtml(ASSISTANCE_LADDER[a.assistanceLevel].name.toLowerCase())}
        </span>
      </li>`).join('');
  };

  root.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-sim-outcome]');
    if (btn) {
      // Record the attempt at the level Meco is CURRENTLY offering
      const current = recommendAssistanceLevel(TASK, attempts);
      attempts = [{
        taskId: TASK,
        at: new Date().toISOString(),
        assistanceLevel: current.level,
        cueType: 'visual',
        outcome: btn.dataset.simOutcome,
      }, ...attempts];
      render();
      return;
    }
    if (event.target.closest('[data-sim-reset]')) {
      attempts = [];
      render();
    }
  });

  render();
}
