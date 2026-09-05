import { $, escapeHtml } from '../utils.js';
import {
  Statistic, StatisticBreakdown, EvidenceCard, AllCitations, MECO_WILL_MEASURE,
} from '../../evidence.js';

export function renderEvidencePages() {
  const impact = $('[data-evidence="impact-singapore"]');
  if (impact) {
    impact.innerHTML = `
      <div class="stat-row">
        ${Statistic('sgToday')}
        ${Statistic('sg2030')}
        ${Statistic('sgAtHome')}
      </div>`;
  }

  const impactGlobal = $('[data-evidence="impact-global"]');
  if (impactGlobal) {
    impactGlobal.innerHTML = `
      <div class="stat-row">
        ${Statistic('worldTotal')}
        ${Statistic('worldNewCases')}
      </div>`;
  }

  const load = $('[data-evidence="care-load"]');
  if (load) {
    load.innerHTML = `
      ${Statistic('sgCareHours')}
      ${StatisticBreakdown('sgCareHours')}
      <div class="stat-row">
        ${Statistic('sgCost', { size: 'small' })}
        ${Statistic('sgWorkDisruption', { size: 'small' })}
        ${Statistic('sgWantSupport', { size: 'small' })}
      </div>`;
  }

  const pairs = $('[data-evidence="problem-response"]');
  if (pairs) {
    pairs.innerHTML = [
      EvidenceCard({
        statId: 'sgCareHours',
        heading: 'Shared handoff instead of scattered messages',
        body: 'Meco keeps one shared record of what happened today, so the next caregiver on shift does not have to reconstruct it from memory or a group chat.',
      }),
      EvidenceCard({
        statId: 'sgAtHome',
        heading: 'Built for the kitchen, not the clinic',
        body: 'Care happens at breakfast, during showers, on walks. Meco assists in those ordinary moments rather than assuming a clinical setting.',
      }),
      EvidenceCard({
        statId: 'sgWorkDisruption',
        heading: 'Reduce unnecessary interventions',
        body: 'The assistance ladder offers the smallest useful cue first, so a caregiver is called in when they are genuinely needed, not by default.',
      }),
    ].join('');
  }

  const science = $('[data-evidence="cochrane"]');
  if (science) {
    science.innerHTML = `
      <div class="stat-row">
        ${Statistic('crTrials')}
        ${Statistic('crParticipants')}
      </div>`;
  }

  const measure = $('[data-evidence="will-measure"]');
  if (measure) {
    measure.innerHTML = MECO_WILL_MEASURE.map((row) => `
      <div class="measure-row">
        <strong>${escapeHtml(row.metric)}</strong>
        <span>${escapeHtml(row.detail)}</span>
      </div>`).join('');
  }

  const refs = $('[data-evidence="citations"]');
  if (refs) refs.innerHTML = AllCitations();

  const homeStrip = $('[data-evidence="home-strip"]');
  if (homeStrip) {
    homeStrip.innerHTML = `
      <div class="stat-row">
        ${Statistic('sgAtHome')}
        ${Statistic('sgCareHours')}
        ${Statistic('sg2030')}
      </div>`;
  }
}
