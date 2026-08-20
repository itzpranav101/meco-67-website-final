export const SOURCES = {
  who2025: {
    id: 'who2025',
    organisation: 'World Health Organization',
    title: 'Dementia, fact sheet',
    published: '2025-03-31',
    url: 'https://www.who.int/news-room/fact-sheets/detail/dementia',
  },
  mohWise2: {
    id: 'mohWise2',
    organisation: 'Singapore Ministry of Health',
    title: 'Prevalence of dementia in Singapore (based on the WiSE study)',
    published: '2023',
    url: 'https://www.moh.gov.sg/',
  },
  moh2025: {
    id: 'moh2025',
    organisation: 'Singapore Ministry of Health',
    title: 'Projected dementia prevalence in Singapore',
    published: '2025-11-04',
    url: 'https://www.moh.gov.sg/',
  },
  dementiaSg2025: {
    id: 'dementiaSg2025',
    organisation: 'Dementia Singapore / Pureprofile, reported by CNA',
    title: 'Survey of dementia caregivers in Singapore',
    published: '2025',
    url: 'https://www.channelnewsasia.com/',
  },
  cochrane2023: {
    id: 'cochrane2023',
    organisation: 'Cochrane Database of Systematic Reviews',
    title: 'Kudlicka A, et al. Cognitive rehabilitation for people with mild to moderate dementia',
    published: '2023-06-29',
    url: 'https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.CD013388.pub2/full',
    identifier: 'CD013388.pub2',
  },
};

export const STATISTICS = {
  sgToday: {
    id: 'sgToday',
    value: '74,000',
    label: 'people living with dementia in Singapore',
    asOf: '2023',
    category: 'singapore',
    source: SOURCES.mohWise2,
    note: 'Ministry of Health figure based on the WiSE study.',
  },
  sg2030: {
    id: 'sg2030',
    value: '152,000',
    label: 'projected to be living with dementia in Singapore by 2030',
    asOf: '2030 (projection)',
    category: 'singapore',
    source: SOURCES.moh2025,
    note: 'A projection, not a count, roughly a doubling from 2023.',
  },
  sgAtHome: {
    id: 'sgAtHome',
    value: '95%',
    label: 'of people with dementia in the survey were living at home',
    asOf: '2025',
    category: 'singapore',
    source: SOURCES.dementiaSg2025,
    note: 'Dementia care in Singapore happens overwhelmingly at home, not in institutions.',
  },
  sgCareHours: {
    id: 'sgCareHours',
    value: '217',
    unit: 'hours/month',
    label: 'average reported caregiving time',
    asOf: '2025',
    category: 'singapore',
    source: SOURCES.dementiaSg2025,
    note: 'Roughly seven hours every day, on top of paid work and everything else.',
    breakdown: [
      { label: 'Supervision and safety', value: 83, unit: 'hrs' },
      { label: 'Daily care, toileting, eating, washing', value: 70, unit: 'hrs' },
      { label: 'Housekeeping, transport, meals, errands', value: 63, unit: 'hrs' },
    ],
  },
  sgCost: {
    id: 'sgCost',
    value: 'S$2,020',
    unit: '/month',
    label: 'median reported care expenditure after subsidies',
    asOf: '2025',
    category: 'singapore',
    source: SOURCES.dementiaSg2025,
  },
  sgWorkDisruption: {
    id: 'sgWorkDisruption',
    value: '65%',
    label: 'of caregivers surveyed had their employment disrupted',
    asOf: '2025',
    category: 'singapore',
    source: SOURCES.dementiaSg2025,
  },
  sgWantSupport: {
    id: 'sgWantSupport',
    value: '89%',
    label: 'of caregivers surveyed said more support is needed',
    asOf: '2025',
    category: 'singapore',
    source: SOURCES.dementiaSg2025,
  },
  worldTotal: {
    id: 'worldTotal',
    value: '57 million',
    label: 'people were living with dementia worldwide',
    asOf: '2021',
    category: 'global',
    source: SOURCES.who2025,
    note: 'WHO figure for 2021. Over 60% live in low- and middle-income countries.',
  },
  worldNewCases: {
    id: 'worldNewCases',
    value: 'nearly 10 million',
    label: 'new cases of dementia each year',
    asOf: '2021',
    category: 'global',
    source: SOURCES.who2025,
  },
  crTrials: {
    id: 'crTrials',
    value: '6',
    label: 'trials in the 2023 Cochrane review of cognitive rehabilitation',
    asOf: '2023',
    category: 'evidence',
    source: SOURCES.cochrane2023,
  },
  crParticipants: {
    id: 'crParticipants',
    value: '1,702',
    label: 'participants across those six trials',
    asOf: '2023',
    category: 'evidence',
    source: SOURCES.cochrane2023,
    note: 'The review found cognitive rehabilitation helped people with mild-to-moderate dementia improve at the everyday activities the intervention targeted. It is evidence for the approach, not evidence about Meco.',
  },
};

export const MECO_WILL_MEASURE = [
  { metric: 'Independent task completion', detail: 'Share of routine steps finished at assistance level 0 or 1.' },
  { metric: 'Assistance level required', detail: 'Median level on the ladder per task, tracked over weeks.' },
  { metric: 'Cue effectiveness', detail: 'Which cue type precedes success most often, per person.' },
  { metric: 'Caregiver intervention frequency', detail: 'How often a task escalates to level 6: a person stepping in.' },
  { metric: 'Repeated-question patterns', detail: 'Whether a persistent orientation card reduces repeats versus answering again.' },
  { metric: 'Routine completion', detail: 'Steps started versus finished.' },
  { metric: 'Time to complete tasks', detail: 'Duration per attempt, as a functional observation only.' },
  { metric: 'Caregiver coordination time', detail: 'Time spent handing over between caregivers, before and after a shared handoff.' },
];

const esc = (value = '') =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sourceLabel = (source, asOf) =>
  `${esc(source.organisation)}${asOf ? `, ${esc(asOf)}` : ''}`;

export function Statistic(id, { size = 'large' } = {}) {
  const stat = STATISTICS[id];
  if (!stat) return '';
  const tooltip = [stat.note, `${stat.source.organisation}, published ${stat.source.published}`]
    .filter(Boolean).join(', ');
  return `
    <figure class="stat stat-${esc(size)}" data-stat="${esc(stat.id)}">
      <div class="stat-value">${esc(stat.value)}${stat.unit ? `<span class="stat-unit">${esc(stat.unit)}</span>` : ''}</div>
      <figcaption class="stat-label">${esc(stat.label)}</figcaption>
      <a class="stat-source" href="${esc(stat.source.url)}" target="_blank" rel="noopener noreferrer"
         title="${esc(tooltip)}">${sourceLabel(stat.source, stat.asOf)}</a>
    </figure>`;
}

export function StatisticBreakdown(id) {
  const stat = STATISTICS[id];
  if (!stat?.breakdown) return '';
  const max = Math.max(...stat.breakdown.map((row) => row.value));
  return `
    <div class="stat-breakdown">
      ${stat.breakdown.map((row) => `
        <div class="stat-breakdown-row">
          <span class="stat-breakdown-label">${esc(row.label)}</span>
          <span class="stat-breakdown-bar"><i style="width:${Math.round((row.value / max) * 100)}%"></i></span>
          <span class="stat-breakdown-value">${esc(row.value)}${esc(row.unit || '')}</span>
        </div>`).join('')}
      <a class="stat-source" href="${esc(stat.source.url)}" target="_blank" rel="noopener noreferrer">
        ${sourceLabel(stat.source, stat.asOf)}</a>
    </div>`;
}

export function EvidenceCard({ statId, heading, body }) {
  const stat = STATISTICS[statId];
  if (!stat) return '';
  return `
    <article class="evidence-card">
      <div class="evidence-figure">
        <strong>${esc(stat.value)}${stat.unit ? esc(stat.unit) : ''}</strong>
        <span>${esc(stat.label)}</span>
        <a class="stat-source" href="${esc(stat.source.url)}" target="_blank" rel="noopener noreferrer">
          ${sourceLabel(stat.source, stat.asOf)}</a>
      </div>
      <div class="evidence-response">
        <h4>${esc(heading)}</h4>
        <p>${esc(body)}</p>
      </div>
    </article>`;
}

export function Citation(sourceId) {
  const source = SOURCES[sourceId];
  if (!source) return '';
  return `
    <li class="citation">
      <span class="citation-title">${esc(source.title)}</span>
      <span class="citation-meta">${esc(source.organisation)}${source.identifier ? ` · ${esc(source.identifier)}` : ''} · ${esc(source.published)}</span>
      <a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.url)}</a>
    </li>`;
}

export function AllCitations() {
  return `<ul class="citation-list">${Object.keys(SOURCES).map(Citation).join('')}</ul>`;
}

export function statsByCategory(category) {
  return Object.values(STATISTICS).filter((stat) => stat.category === category);
}
