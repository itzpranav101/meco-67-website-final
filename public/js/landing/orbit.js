/* The interactive orbit on /product */

import { $, $$, escapeHtml } from '../utils.js';

export const ORBIT_STEPS = [
  { icon: '◎', title: 'Understand the person', body: 'Who visits, what mornings look like, which stories land, what helps when something goes wrong. The part no system has ever held.' },
  { icon: '⌁', title: 'Notice what actually happens', body: 'Steps started and finished, questions asked, visits transcribed, behaviour logged. Transcription is an input here, not the product.' },
  { icon: '≋', title: 'Spot where it got hard', body: 'A step that stalled, an intention lost between rooms, the same question three times in an hour. Difficulty is the trigger, not a schedule.' },
  { icon: '✦', title: 'Give the smallest useful cue', body: 'Meco starts as low on the ladder as the history supports, then climbs only if that is not enough. Never past the limit the caregiver set.' },
  { icon: '⏱', title: 'Learn, then help less', body: 'Three successes in a row and the next cue drops a rung. Struggle twice and it steps back up. The aim is to be needed less.' },
];

export function initOrbit() {
  const orbit = $('[data-orbit]');
  if (!orbit) return;
  const ring = $('[data-orbit-ring]', orbit);
  const nodes = $$('[data-orbit-node]', orbit);
  const panel = $('[data-orbit-panel]');
  const resumeBtn = $('[data-orbit-resume]');
  const mobileList = $('[data-orbit-mobile-list]');
  if (!ring || !nodes.length || !panel) return;

  // Mobile fallback is plain
  if (mobileList) {
    mobileList.innerHTML = ORBIT_STEPS.map((step, i) => `
      <li class="orbit-mobile-step">
        <span class="orbit-mobile-step-icon" aria-hidden="true">${step.icon}</span>
        <div><span class="orbit-mobile-step-num">STEP 0${i + 1} / 05</span><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.body)}</p></div>
      </li>`).join('');
  }

  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotionState = () => orbit.classList.toggle('is-static', reduceMotionQuery.matches);
  applyMotionState();
  reduceMotionQuery.addEventListener('change', applyMotionState);

  let active = 0;

  function setActiveStep(index, { lock = false } = {}) {
    active = index;
    const step = ORBIT_STEPS[index];
    nodes.forEach((node, i) => {
      const isActive = i === index;
      node.classList.toggle('is-active', isActive);
      node.setAttribute('aria-selected', String(isActive));
      node.tabIndex = isActive ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `orbit-tab-${index + 1}`);
    $('[data-orbit-panel-step]', panel).textContent = `Step 0${index + 1} / 05`;
    $('[data-orbit-panel-title]', panel).textContent = step.title;
    $('[data-orbit-panel-body]', panel).textContent = step.body;
    // Restart the CSS entrance transition
    panel.classList.remove('is-swapping');
    void panel.offsetWidth;
    panel.classList.add('is-swapping');
    if (lock) {
      orbit.classList.add('is-locked');
      if (resumeBtn) resumeBtn.hidden = false;
    }
  }

  nodes.forEach((node, i) => {
    node.addEventListener('click', () => setActiveStep(i, { lock: true }));
  });

  resumeBtn?.addEventListener('click', () => {
    orbit.classList.remove('is-locked');
    resumeBtn.hidden = true;
  });

  // WAI-ARIA APG "Tabs" pattern
  ring.addEventListener('keydown', (event) => {
    const count = nodes.length;
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (active + 1) % count;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (active - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveStep(active, { lock: true }); return; }
    if (next === null) return;
    event.preventDefault();
    setActiveStep(next, { lock: true });
    nodes[next].focus();
  });

  // Below the ~620px container-query breakpoint
  const section = $('#how-it-works');
  const heading = $('#orbit-heading');
  if (section && heading) {
    let lastFocusedNode = null;
    nodes.forEach((node) => node.addEventListener('focusin', () => { lastFocusedNode = node; }));
    const recoverFocusIfNeeded = () => {
      const isCompact = section.getBoundingClientRect().width <= 620;
      const focusWentMissing = document.activeElement === document.body || document.activeElement == null;
      if (lastFocusedNode && isCompact && focusWentMissing) {
        heading.focus();
        lastFocusedNode = null;
      }
    };
    orbit.addEventListener('focusout', recoverFocusIfNeeded);
    if ('ResizeObserver' in window) new ResizeObserver(recoverFocusIfNeeded).observe(section);
  }

  setActiveStep(0);
}

// The "try it yourself" sandbox on the home page
const PLAYGROUND_PEOPLE = {
  sarah: { name: 'Sarah', relationship: 'Daughter', note: 'Sunday garden walks and looking through the blue photo album. Recognized warmly on 3 recent visits.' },
  james: { name: 'James', relationship: 'Brother', note: 'Old school stories and Saturday football. Always brings a laugh into the room.' },
  mei: { name: 'Mei', relationship: 'Friend', note: 'Tea at 4pm, most Wednesdays. Mei often brings a new photo to share.' },
  amir: { name: 'Amir', relationship: 'Caregiver', note: 'Handles the morning routine and afternoon check-ins.' },
};

export function initPlayground() {
  const root = $('[data-playground]');
  if (!root) return;

  $$('.playground-nav', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.playground-nav', root).forEach((b) => b.classList.toggle('active', b === btn));
      $$('.playground-panel', root).forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.panelContent === btn.dataset.panel);
      });
    });
  });

  const detail = $('[data-person-detail]', root);
  const detailInner = detail?.querySelector('.pg-accordion-inner');
  $$('.pg-person', root).forEach((card) => {
    card.addEventListener('click', () => {
      const wasSelected = card.classList.contains('selected');
      $$('.pg-person', root).forEach((c) => c.classList.remove('selected'));
      if (wasSelected) {
        detail.classList.remove('open');
        return;
      }
      card.classList.add('selected');
      const person = PLAYGROUND_PEOPLE[card.dataset.person];
      if (person && detailInner) {
        detailInner.innerHTML = `<div class="pg-detail-card"><b>${escapeHtml(person.name)}</b><small>${escapeHtml(person.relationship)}</small><p>${escapeHtml(person.note)}</p></div>`;
      }
      detail.classList.add('open');
    });
  });

  $$('.pg-row[data-reveal]', root).forEach((row) => {
    row.setAttribute('aria-expanded', 'false');
    row.addEventListener('click', () => {
      const key = row.dataset.reveal;
      const panel = root.querySelector(`.pg-accordion[data-reveal-panel="${key}"]`);
      const alreadyOpen = panel.classList.contains('open');
      const list = row.closest('.pg-list');
      $$('.pg-accordion[data-reveal-panel]', list).forEach((p) => p.classList.remove('open'));
      $$('.pg-row[data-reveal]', list).forEach((r) => r.setAttribute('aria-expanded', 'false'));
      if (!alreadyOpen) {
        panel.classList.add('open');
        row.setAttribute('aria-expanded', 'true');
      }
    });
  });
}

/* Fills the /science and /impact pages from the evidence registry. */
/* The Assistance Ladder */
