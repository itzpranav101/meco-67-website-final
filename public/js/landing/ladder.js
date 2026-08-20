/* The Assistance Ladder shown on the homepage. */

import { $, escapeHtml } from '../utils.js';

export const LADDER_RUNGS = [
  { level: 0, name: 'Independent', short: 'Nothing', example: 'Meco stays quiet. No prompt, no notification, no interruption.', why: 'The best intervention is often none at all. If someone can do it, doing it for them takes something away.' },
  { level: 1, name: 'Environmental cue', short: 'A nudge', example: 'The kettle is gently highlighted on screen. Today\'s routine appears.', why: 'Draws attention without saying anything. Often that is all that was missing.' },
  { level: 2, name: 'Contextual cue', short: 'Context', example: '"Think about what you normally do after breakfast."', why: 'Points at the context and lets the person make the connection themselves.' },
  { level: 3, name: 'Specific hint', short: 'A hint', example: '"It has something to do with your morning medicine."', why: 'Narrows the search without handing over the answer.' },
  { level: 4, name: 'Next-step prompt', short: 'Next step', example: '"Open your pill organiser."', why: 'Names only the next action, not the whole sequence.' },
  { level: 5, name: 'Full guidance', short: 'Step by step', example: 'Step 1 of 4: Fill the kettle. Meco waits, then shows step 2.', why: 'Complete instructions, one step at a time, at the person\'s pace.' },
  { level: 6, name: 'Human assistance', short: 'A person', example: 'Meco offers to call Meena, or alerts the caregiver on duty.', why: 'Sometimes the right answer is a person. Meco says so rather than looping.' },
];

/* The homepage simulation. */

export function initAssistanceLadder() {
  const root = $('[data-ladder]');
  if (!root) return;
  const rungsEl = root.querySelector('.ladder-rungs');
  const detailEl = root.querySelector('[data-ladder-detail]');
  if (!rungsEl || !detailEl) return;

  rungsEl.innerHTML = LADDER_RUNGS.map((rung, i) => `
    <button class="ladder-rung${i === 2 ? ' is-active' : ''}" type="button" role="tab"
            aria-selected="${i === 2}" data-rung="${rung.level}" style="--i:${i}">
      <span class="rung-level">${rung.level}</span>
      <span class="rung-name">${escapeHtml(rung.name)}</span>
      <span class="rung-short">${escapeHtml(rung.short)}</span>
    </button>`).join('');

  const show = (level) => {
    const rung = LADDER_RUNGS[level];
    detailEl.innerHTML = `
      <div class="ladder-detail-inner">
        <p class="ladder-detail-level">LEVEL ${rung.level}</p>
        <h3>${escapeHtml(rung.name)}</h3>
        <blockquote>${escapeHtml(rung.example)}</blockquote>
        <p class="ladder-why">${escapeHtml(rung.why)}</p>
      </div>`;
    rungsEl.querySelectorAll('.ladder-rung').forEach((btn) => {
      const active = Number(btn.dataset.rung) === level;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
  };

  rungsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.ladder-rung');
    if (btn) show(Number(btn.dataset.rung));
  });
  // Arrow-key support so the ladder is operable without a mouse.
  rungsEl.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const current = Number(rungsEl.querySelector('.is-active')?.dataset.rung ?? 2);
    const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
    const next = Math.max(0, Math.min(LADDER_RUNGS.length - 1, current + delta));
    show(next);
    rungsEl.querySelector(`[data-rung="${next}"]`)?.focus();
  });

  show(2);
}
