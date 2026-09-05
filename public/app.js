import { $, $$, sleep, escapeHtml, formatDate, formatDuration, turnsLabel } from './js/utils.js';
import { state, defaultState, setState, resetState } from './js/state.js';
import {
  config, clerk, backendName, setConfig, setClerk,
  toast, setChip, getToken, apiFetch,
  loadState, persistState, queueSave,
  todayISO, dateParts, RERENDER_EVENT,
} from './js/core.js';
import {
  calendarSyncEnabled, REPEAT_DAY_ORDER, repeatBadgeMarkup,
  syncedBadge, reminderTitle,
  readRepeatFromModal, populateRepeatModal,
  syncToCalendar, unsyncFromCalendar,
  pullFromCalendar, startCalendarPolling,
} from './js/calendar.js';
import { initHeroGap, initMagneticButtons } from './js/landing/hero.js';
import { initOrbit, initPlayground } from './js/landing/orbit.js';
import { initAssistanceLadder } from './js/landing/ladder.js';
import { initAssistanceSimulation } from './js/landing/simulation.js';
import { renderEvidencePages } from './js/landing/evidence-pages.js';

function animateCountUp(el, target, duration = 700) {
  if (!el) return;
  const goal = Number(target) || 0;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { el.textContent = goal; return; }
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    el.textContent = Math.round(goal * eased);
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = goal;
  };
  requestAnimationFrame(step);
}

const conversationLanguages = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: 'Mandarin' },
  { code: 'ta', label: 'Tamil' },
  { code: 'hi', label: 'Hindi' },
];

const journalMoods = [
  { key: 'happy', glyph: '◉', label: 'Happy' },
  { key: 'calm', glyph: '◎', label: 'Calm' },
  { key: 'okay', glyph: '◐', label: 'Okay' },
  { key: 'tired', glyph: '◔', label: 'Tired' },
  { key: 'anxious', glyph: '◍', label: 'Anxious' },
  { key: 'sad', glyph: '○', label: 'Sad' },
];

let activeClerkUserId = null;
let currentPage = 'overview';
let faceModelsReady = false;
let faceModelsLoading = false;
let appLoaded = false;
let activeStreams = [];
let activeIntervals = [];
let patientContext = null;
let companionSession = null;
let journalDraft = null;
let journalView = { mode: 'list', id: null };
let enrollContext = { stream: null, descriptors: {}, thumbnail: '', poseIndex: 0, detection: null, voiceSample: null };
let voiceprints = [];
let voiceprintsLoaded = false;
let liveContext = null;
let sessionsView = { mode: 'list', id: null };
const poses = ['front', 'left', 'right'];

function observeReveals() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  $$('.reveal, .reveal-left, .reveal-right, .reveal-up, .reveal-scale, .stagger-group, .draw-in').forEach((element) => observer.observe(element));
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let scrollChromeTicking = false;
function updateScrollChrome() {
  const scrollY = window.scrollY;
  $('.floating-nav')?.classList.toggle('scrolled', scrollY > 12);
  $('.app-topbar')?.classList.toggle('scrolled', scrollY > 4);
  const progress = $('#scroll-progress');
  if (progress) {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = max > 0 ? `${Math.min(100, (scrollY / max) * 100)}%` : '0%';
  }
  if (!prefersReducedMotion) applyHeroParallax(scrollY);
  scrollChromeTicking = false;
}

function applyHeroParallax(scrollY) {
  const heroShell = $('.hero-shell');
  if (!heroShell || scrollY > heroShell.offsetHeight + 200) return;
  [
    ['.cloud-one', -0.05], ['.cloud-two', -0.08],
    ['.mountain-one', 0.07], ['.mountain-two', 0.045], ['.mountain-three', 0.025],
    ['.yellow-slope', 0.06],
  ].forEach(([selector, rate]) => {
    const el = $(selector);
    if (el) el.style.translate = `0 ${(scrollY * rate).toFixed(1)}px`;
  });
}

let chapterTabsObserver = null;
function initChapterTabs(root = document) {
  chapterTabsObserver?.disconnect();
  const visiblePage = root.querySelector('.landing-page:not(.hidden)') || root;
  const tabsRow = visiblePage.querySelector('.chapter-tabs');
  const tabs = $$('.chapter-tabs a[href^="#"]', visiblePage);
  if (!tabsRow || !tabs.length) return;
  let indicator = tabsRow.querySelector('.chapter-tab-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'chapter-tab-indicator';
    tabsRow.insertBefore(indicator, tabsRow.firstChild);
  }
  const moveIndicator = (tab) => {
    if (!tab) return;
    indicator.style.width = `${tab.offsetWidth}px`;
    indicator.style.transform = `translateX(${tab.offsetLeft - 6}px)`;
    requestAnimationFrame(() => indicator.classList.add('ready'));
  };
  const sections = tabs
    .map((tab) => ({ tab, section: document.getElementById(tab.getAttribute('href').slice(1)) }))
    .filter((entry) => entry.section);
  const setActive = (id) => {
    tabs.forEach((tab) => tab.classList.toggle('active', tab.getAttribute('href') === `#${id}`));
    moveIndicator(tabs.find((tab) => tab.getAttribute('href') === `#${id}`));
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => setActive(tab.getAttribute('href').slice(1))));
  chapterTabsObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (visible) setActive(visible.target.id);
  }, { rootMargin: '-45% 0px -50% 0px' });
  sections.forEach(({ section }) => chapterTabsObserver.observe(section));

  requestAnimationFrame(() => setActive(sections[0]?.section.id));
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'classic';
}

function applyTheme(name) {
  if (name === 'classic') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  try { localStorage.setItem('meco-theme', name); } catch {}
  $$('.theme-swatch').forEach((swatch) => swatch.classList.toggle('active', swatch.dataset.themePick === name));
}

function wireThemeSystem() {
  applyTheme(currentTheme());
  const popover = $('#theme-popover');
  const openers = [$('#theme-toggle-nav'), $('#theme-toggle-app'), $('#theme-toggle-footer')].filter(Boolean);
  const openPopover = (anchor) => {
    popover.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 10}px`;
    popover.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
  };
  openers.forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (popover.classList.contains('hidden')) openPopover(button);
    else popover.classList.add('hidden');
  }));
  document.addEventListener('click', (event) => {
    if (!popover.classList.contains('hidden') && !popover.contains(event.target) && !openers.includes(event.target)) {
      popover.classList.add('hidden');
    }
  });
  $$('.theme-swatch').forEach((swatch) => swatch.addEventListener('click', () => applyTheme(swatch.dataset.themePick)));
}

async function loadScript(src, attributes = {}) {
  if ($(`script[src="${src}"]`)) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value));
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function decodeClerkDomain(publishableKey) {
  const encoded = publishableKey.split('_')[2] || '';
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return decoded.slice(0, -1);
}

async function initClerk() {
  if (config.features.localDemo) return;
  const key = config.clerkPublishableKey;
  if (!key) {
    toast('Clerk is not configured. Add CLERK_PUBLISHABLE_KEY to .env.', 'error');
    return;
  }
  try {
    const domain = decodeClerkDomain(key);
    await loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { 'data-clerk-publishable-key': key });
    setClerk(window.Clerk);
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    activeClerkUserId = clerk.user?.id || null;
    clerk.addListener(async ({ user }) => {
      const nextUserId = user?.id || null;
      const userChanged = nextUserId !== activeClerkUserId;
      if (userChanged) {
        cleanupMedia();
        activeClerkUserId = nextUserId;
        appLoaded = false;
        voiceprints = [];
        voiceprintsLoaded = false;
        resetState();
        currentPage = 'overview';
      }

      if (user && !$('#auth-modal').classList.contains('hidden')) {
        closeAuthModal();
        if (routePath() !== '/app') history.pushState({}, '', routeUrl('/app'));
      }

      const alreadyShowingApp = appLoaded && routePath() === '/app' && !$('#app-view').classList.contains('hidden');
      if (!userChanged && alreadyShowingApp) return;
      await renderRoute();
    });
  } catch (error) {
    console.error(error);
    toast(`Clerk could not start: ${error.message}`, 'error');
  }
}

function openAuthModal(mode = 'sign-in') {
  const modal = $('#auth-modal');
  const mount = $('#clerk-auth-mount');
  modal.classList.remove('hidden');
  $('#auth-loading').classList.remove('hidden');

  try { clerk?.unmountSignIn?.(mount); } catch {}
  try { clerk?.unmountSignUp?.(mount); } catch {}
  if (mount.childElementCount) mount.innerHTML = '';
  if (!clerk) {
    $('#auth-loading').textContent = 'Secure sign-in is still loading…';
    return;
  }
  $('#auth-loading').classList.add('hidden');
  const options = {
    forceRedirectUrl: `${location.origin}/app`,
    signUpForceRedirectUrl: `${location.origin}/app`,
    signInForceRedirectUrl: `${location.origin}/app`,
    appearance: {
      variables: { colorPrimary: '#11100f', borderRadius: '14px', fontFamily: 'Inter, sans-serif' },
      elements: { cardBox: { boxShadow: 'none' }, card: { boxShadow: 'none', background: 'transparent' } },
    },
  };
  if (mode === 'sign-up') clerk.mountSignUp(mount, options);
  else clerk.mountSignIn(mount, options);
}

function closeAuthModal() {
  $('#auth-modal').classList.add('hidden');
  const mount = $('#clerk-auth-mount');

  try { clerk?.unmountSignIn?.(mount); } catch {}
  try { clerk?.unmountSignUp?.(mount); } catch {}
}

function cleanupMedia() {
  stopLiveConversation();
  activeIntervals.forEach(clearInterval);
  activeIntervals = [];
  activeStreams.forEach((stream) => stream?.getTracks?.().forEach((track) => track.stop()));
  activeStreams = [];
  try { patientContext?.recorder?.state !== 'inactive' && patientContext.recorder.stop(); } catch {}
  patientContext = null;
}

async function loadFaceModels() {
  if (faceModelsReady || faceModelsLoading) return faceModelsReady;
  faceModelsLoading = true;
  setChip('face-chip', 'Loading face models');
  try {
    for (let i = 0; i < 50 && !window.faceapi; i += 1) await sleep(200);
    if (!window.faceapi) throw new Error('Face API library did not load.');
    const base = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(base),
      faceapi.nets.faceLandmark68Net.loadFromUri(base),
      faceapi.nets.faceRecognitionNet.loadFromUri(base),
    ]);
    faceModelsReady = true;
    setChip('face-chip', 'Face models ready', 'ready');
    return true;
  } catch (error) {
    console.error(error);
    setChip('face-chip', 'Face models failed', 'error');
    toast(`Face recognition setup failed: ${error.message}`, 'error');
    return false;
  } finally {
    faceModelsLoading = false;
  }
}

const LANDING_PAGES = ['home', 'recognize', 'product', 'companion', 'caregiver', 'privacy', 'pricing', 'clinicians', 'science', 'impact', 'privacy-policy', 'terms', 'cookies'];
const landingPageTitles = {
  home: 'Meco | Adaptive Cognitive Support for Dementia',
  recognize: 'Recognize | Meco',
  product: 'Product | Meco',
  companion: 'Companion | Meco',
  caregiver: 'Caregiver | Meco',
  privacy: 'Privacy | Meco',
  pricing: 'Pricing | Meco',
  clinicians: 'For Clinicians | Meco',
  science: 'The Evidence | Meco',
  impact: 'The Problem | Meco',
  'privacy-policy': 'Privacy Policy | Meco',
  terms: 'Terms of Service | Meco',
  cookies: 'Cookie Policy | Meco',
};
const BASE = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const routePath = () => {
  const path = location.pathname;
  if (BASE && path.startsWith(BASE)) return path.slice(BASE.length) || '/';
  return path;
};
const routeUrl = (path) => `${BASE}${path}`;

function applyRouteBase() {
  if (!BASE) return;
  $$('a[href^="/"]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href.startsWith('//') || href.startsWith(BASE + '/')) return;
    link.setAttribute('href', routeUrl(href));
  });
}

const landingPathToPage = (pathname) => {
  const clean = pathname.replace(/^\//, '') || 'home';
  return LANDING_PAGES.includes(clean) ? clean : 'home';
};

async function renderRoute() {
  const signedIn = Boolean(clerk?.user && clerk?.session) || config.features.localDemo;
  if (routePath() === '/app') {
    if (!signedIn) {
      showLanding('home');
      openAuthModal('sign-in');
      return;
    }
    await showApp();
  } else {
    showLanding(landingPathToPage(routePath()));
  }
}

function showLanding(page = 'home') {
  cleanupMedia();
  $('#landing-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  $$('.landing-page').forEach((section) => section.classList.toggle('hidden', section.dataset.landingPage !== page));
  $$('[data-landing-nav]').forEach((link) => link.classList.toggle('active', link.dataset.landingNav === page));
  document.title = landingPageTitles[page] || landingPageTitles.home;
  window.scrollTo(0, 0);

  updateScrollChrome();
  observeReveals();
  initChapterTabs();
}

async function showApp() {
  $('#landing-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  if (!appLoaded) {
    await loadState();
    appLoaded = true;
    loadFaceModels();
    loadVoiceprints();
    if (clerk?.user && clerk?.session) {
      const mount = $('#clerk-user-button');
      mount.innerHTML = '';
      clerk.mountUserButton(mount, { afterSignOutUrl: '/' });
    }

    $('.sidebar-nav-scroll')?.classList.add('sidebar-ready');
  }
  updatePatientEntryButton();
  renderAppPage(currentPage);
}

function openPatientCameraMode() {
  companionSession = null;
  journalDraft = null;
  memoriesBrowseActive = false;
  navigateApp('patient');
}

function navigateApp(page) {
  cleanupMedia();
  if (page === 'sessions') sessionsView = { mode: 'list', id: null };
  currentPage = page;
  updatePatientEntryButton();
  $$('.side-nav').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  renderAppPage(page);
  if (page === 'visits' || page === 'reminders') pullFromCalendar();
}

function openSessionDetail(id) {
  cleanupMedia();
  sessionsView = { mode: 'detail', id };
  currentPage = 'sessions';
  updatePatientEntryButton();
  $$('.side-nav').forEach((button) => button.classList.toggle('active', button.dataset.page === 'sessions'));
  renderAppPage('sessions');
}

function updatePatientEntryButton() {
  const button = $('.patient-entry');
  if (!button) return;
  const inPatientMode = currentPage === 'patient';
  button.dataset.page = inPatientMode ? 'overview' : 'patient';
  const label = button.querySelector('.patient-entry-label');
  if (label) label.textContent = inPatientMode ? 'Open caregiver mode' : 'Open patient mode';
}

function renderAppPage(page) {
  const content = $('#app-content');
  if (!content) return;

  content.classList.remove('app-content-fixed');
  if (page === 'people') renderPeople(content);
  else if (page === 'memory') renderMemory(content);
  else if (page === 'sessions') renderSessions(content);
  else if (page === 'visits') renderVisits(content);
  else if (page === 'reminders') renderReminders(content);
  else if (page === 'companion') renderCompanion(content);
  else if (page === 'journal') renderJournal(content);
  else if (page === 'insights') renderInsights(content);
  else if (page === 'notes') renderCareNotes(content);
  else if (page === 'graph') renderMemoryGraphPage(content);
  else if (page === 'activities') renderActivitiesPage(content);
  else if (page === 'settings') renderSettings(content);
  else if (page === 'patient') renderPatient(content);
  else renderOverview(content);
  content.classList.remove('page-enter');
  void content.offsetWidth;
  content.classList.add('page-enter');
}

function pageHead(title, subtitle, action = '') {
  return `<div class="page-head"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${action}</div>`;
}

function visitRowMarkup(visit) {
  const { day, tag, isToday, isPast } = dateParts(visit.date);
  const visitor = visit.visitorId && state.visitors.find((item) => item.id === visit.visitorId);
  return `<div class="visit-date-row${isToday ? ' today' : ''}${isPast ? ' past' : ''}">
    <div class="visit-date-box"><span class="visit-day">${escapeHtml(day)}</span><strong>${escapeHtml(tag)}</strong>${visit.time ? `<small>${escapeHtml(visit.time)}</small>` : ''}</div>
    <div class="row-copy"><b>${escapeHtml(visit.visitorName || 'Visitor')} ${syncedBadge(visit)}</b><small>${[visitor?.relationship, visit.note].filter(Boolean).map(escapeHtml).join(' · ')}</small>${repeatBadgeMarkup(visit.repeat)}</div>
    <div class="row-icon-actions">
      <button class="icon-button" data-edit-visit="${escapeHtml(visit.id)}" aria-label="Edit visit" title="Edit visit">✎</button>
      <button class="icon-button danger" data-delete-visit="${escapeHtml(visit.id)}" aria-label="Remove visit" title="Remove visit">✕</button>
    </div>
  </div>`;
}

function sortedVisits() {
  return state.visits.slice().sort((a, b) => `${a.date}T${a.time || '00:00'}`.localeCompare(`${b.date}T${b.time || '00:00'}`));
}

function visitsCardMarkup(limit = 4) {
  const upcoming = sortedVisits().filter((visit) => !dateParts(visit.date).isPast).slice(0, limit);
  return `<article class="app-card visits-card yellow">
    <div class="card-head"><h2>Visits</h2><div class="action-row"><button class="action-button" id="add-visit">+ Schedule</button><button class="action-button" id="see-visits">See all</button></div></div>
    <div class="visit-list">${upcoming.length ? upcoming.map(visitRowMarkup).join('') : `<div class="empty-state"><div><h3>No visits scheduled</h3><p>Schedule a visit to see it here.</p></div></div>`}</div>
  </article>`;
}

function reminderRowMarkup(reminder) {

  const linkedVisit = state.visits.find((visit) => visit.date === reminder.date);
  const linkedMarkup = linkedVisit
    ? `<div class="reminder-linked-visit"><small>Same day as ${escapeHtml(linkedVisit.visitorName ? `${linkedVisit.visitorName}'s` : 'a')} visit</small></div>`
    : '';
  const conditionBadge = reminder.conditions ? contextConditionBadgeMarkup(reminder.conditions) : '';
  return `<div class="reminder-row${reminder.done ? ' done' : ''}">
    <label class="reminder-check"><input type="checkbox" data-toggle-reminder="${escapeHtml(reminder.id)}" ${reminder.done ? 'checked' : ''}><span></span></label>
    ${reminder.time ? `<span class="reminder-time">${escapeHtml(reminder.time)}</span>` : ''}
    <span class="reminder-text">${escapeHtml(reminder.text)} ${syncedBadge(reminder)}${repeatBadgeMarkup(reminder.repeat)}${conditionBadge}</span>
    <div class="row-icon-actions">
      <button class="icon-button" data-edit-reminder="${escapeHtml(reminder.id)}" aria-label="Edit reminder" title="Edit reminder">✎</button>
      <button class="icon-button danger" data-delete-reminder="${escapeHtml(reminder.id)}" aria-label="Delete reminder" title="Delete reminder">✕</button>
    </div>
    ${linkedMarkup}
  </div>`;
}

function contextConditionBadgeMarkup(conditions) {
  const place = conditions.nearPlaceId ? (state.places || []).find((p) => p.id === conditions.nearPlaceId) : null;
  const parts = [];
  if (place) parts.push(`${place.name}`);
  if (conditions.afterActivity) parts.push(`↳ after ${conditions.afterActivity}`);
  if (!parts.length) return '';
  return `<span class="badge context-badge" title="Best timed ${parts.join(', ')}">${escapeHtml(parts.join(' · '))}</span>`;
}

function sortedReminders() {
  return state.reminders.slice().sort((a, b) => Number(a.done) - Number(b.done) || `${a.date}T${a.time || '00:00'}`.localeCompare(`${b.date}T${b.time || '00:00'}`));
}

function remindersCardMarkup(limit = 4) {
  const sorted = sortedReminders().slice(0, limit);
  return `<article class="app-card reminders-card peach">
    <div class="card-head"><h2>Reminders</h2><div class="action-row"><button class="action-button" id="add-reminder">+ Add reminder</button><button class="action-button" id="see-reminders">See all</button></div></div>
    <div class="reminder-list">${sorted.length ? sorted.map(reminderRowMarkup).join('') : `<div class="empty-state"><div><h3>No reminders yet</h3><p>Add a reminder to see it here.</p></div></div>`}</div>
  </article>`;
}

function wireVisitsAndReminders() {
  $('#add-visit')?.addEventListener('click', () => openVisitModal());
  $('#see-visits')?.addEventListener('click', () => navigateApp('visits'));
  $('#add-reminder')?.addEventListener('click', () => openReminderModal());
  $('#see-reminders')?.addEventListener('click', () => navigateApp('reminders'));
  $$('[data-edit-visit]').forEach((button) => button.addEventListener('click', () => openVisitModal(button.dataset.editVisit)));
  $$('[data-delete-visit]').forEach((button) => button.addEventListener('click', () => deleteScheduledVisit(button.dataset.deleteVisit)));
  $$('[data-edit-reminder]').forEach((button) => button.addEventListener('click', () => openReminderModal(button.dataset.editReminder)));
  $$('[data-delete-reminder]').forEach((button) => button.addEventListener('click', () => deleteReminder(button.dataset.deleteReminder)));
  $$('[data-toggle-reminder]').forEach((input) => input.addEventListener('change', () => toggleReminder(input.dataset.toggleReminder)));
}

let editingVisitId = null;
let editingReminderId = null;

function openVisitModal(id = null) {
  editingVisitId = id;
  const visit = id ? state.visits.find((item) => item.id === id) : null;
  $('#visit-visitor-options').innerHTML = state.visitors.map((visitor) => `<option value="${escapeHtml(visitor.name)}">`).join('');
  $('#visit-modal-title').textContent = visit ? 'Edit visit' : 'Schedule a visit';
  $('#visit-name').value = visit?.visitorName || '';
  $('#visit-date').value = visit?.date || todayISO();
  $('#visit-time').value = visit?.time || '';
  $('#visit-end-time').value = visit?.endTime || '';
  $('#visit-note').value = visit?.note || '';
  populateRepeatModal('visit', visit?.repeat);
  $('#delete-visit-modal').classList.toggle('hidden', !visit);
  $('#visit-modal').classList.remove('hidden');
  $('#visit-name').focus();
}

function closeVisitModal() {
  editingVisitId = null;
  $('#visit-modal').classList.add('hidden');
}

async function saveVisitModal() {
  const visitorName = $('#visit-name').value.trim();
  const date = $('#visit-date').value;
  const time = $('#visit-time').value;
  const endTime = $('#visit-end-time').value;
  const note = $('#visit-note').value.trim();
  if (!visitorName) return toast('Add who is visiting.', 'error');
  if (!date) return toast('Pick a date for the visit.', 'error');
  const repeat = readRepeatFromModal('visit');
  if (repeat.freq === 'weekly' && !repeat.days.length) return toast('Pick at least one day for the weekly repeat.', 'error');
  const matched = state.visitors.find((visitor) => visitor.name.toLowerCase() === visitorName.toLowerCase());
  const existing = editingVisitId && state.visits.find((item) => item.id === editingVisitId);
  const record = {
    id: editingVisitId || crypto.randomUUID(),
    visitorId: matched?.id || null,
    visitorName: visitorName.slice(0, 80),
    date,
    time: time || '',
    endTime: time ? (endTime || '') : '',
    note: note.slice(0, 140),
    repeat,
    googleEventId: existing?.googleEventId || null,
  };
  await syncToCalendar(record, `Visit: ${record.visitorName}`, record.note);
  const index = editingVisitId ? state.visits.findIndex((item) => item.id === editingVisitId) : -1;
  const previous = index !== -1 ? state.visits[index] : null;
  if (index !== -1) state.visits[index] = record;
  else state.visits.push(record);
  $('#save-visit').disabled = true;
  try {
    await persistState(true);
    closeVisitModal();
    renderAppPage(currentPage);
  } catch {
    if (index !== -1) state.visits[index] = previous;
    else state.visits.pop();
  } finally {
    $('#save-visit').disabled = false;
  }
}

async function deleteScheduledVisit(id) {
  if (!confirm('Remove this scheduled visit?')) return;
  await unsyncFromCalendar(state.visits.find((visit) => visit.id === id));
  state.visits = state.visits.filter((visit) => visit.id !== id);
  closeVisitModal();
  await persistState(true);
  renderAppPage(currentPage);
}

function openReminderModal(id = null) {
  editingReminderId = id;
  const reminder = id ? state.reminders.find((item) => item.id === id) : null;
  $('#reminder-modal-title').textContent = reminder ? 'Edit reminder' : 'Add a reminder';
  $('#reminder-text').value = reminder?.text || '';
  $('#reminder-date').value = reminder?.date || todayISO();
  $('#reminder-time').value = reminder?.time || '';
  $('#reminder-end-time').value = reminder?.endTime || '';
  populateRepeatModal('reminder', reminder?.repeat);
  const placeSelect = $('#reminder-near-place');
  placeSelect.innerHTML = '<option value="">Any place</option>' + (state.places || []).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  placeSelect.value = reminder?.conditions?.nearPlaceId || '';
  $('#reminder-after-activity').value = reminder?.conditions?.afterActivity || '';
  $('#delete-reminder-modal').classList.toggle('hidden', !reminder);
  $('#reminder-modal').classList.remove('hidden');
  $('#reminder-text').focus();
}

function closeReminderModal() {
  editingReminderId = null;
  $('#reminder-modal').classList.add('hidden');
}

async function saveReminderModal() {
  const text = $('#reminder-text').value.trim();
  const date = $('#reminder-date').value;
  const time = $('#reminder-time').value;
  const endTime = $('#reminder-end-time').value;
  if (!text) return toast('Add a reminder note.', 'error');
  if (!date) return toast('Pick a date for the reminder.', 'error');
  const repeat = readRepeatFromModal('reminder');
  if (repeat.freq === 'weekly' && !repeat.days.length) return toast('Pick at least one day for the weekly repeat.', 'error');
  const existing = editingReminderId && state.reminders.find((item) => item.id === editingReminderId);
  const nearPlaceId = $('#reminder-near-place').value || null;
  const afterActivity = $('#reminder-after-activity').value.trim().slice(0, 60) || null;
  const conditions = (nearPlaceId || afterActivity) ? { nearPlaceId, afterActivity } : null;
  const record = { id: editingReminderId || crypto.randomUUID(), text: text.slice(0, 140), date, time: time || '', endTime: time ? (endTime || '') : '', done: existing?.done || false, repeat, conditions, googleEventId: existing?.googleEventId || null };
  await syncToCalendar(record, reminderTitle(record), '');
  const index = editingReminderId ? state.reminders.findIndex((item) => item.id === editingReminderId) : -1;
  if (index !== -1) state.reminders[index] = record;
  else state.reminders.push(record);
  $('#save-reminder').disabled = true;
  try {
    await persistState(true);
    closeReminderModal();
    renderAppPage(currentPage);
  } catch {
    if (index !== -1) state.reminders[index] = existing;
    else state.reminders.pop();
  } finally {
    $('#save-reminder').disabled = false;
  }
}

async function deleteReminder(id) {
  if (!confirm('Delete this reminder?')) return;
  await unsyncFromCalendar(state.reminders.find((item) => item.id === id));
  state.reminders = state.reminders.filter((item) => item.id !== id);
  closeReminderModal();
  await persistState(true);
  renderAppPage(currentPage);
}

async function toggleReminder(id) {
  const reminder = state.reminders.find((item) => item.id === id);
  if (!reminder) return;
  reminder.done = !reminder.done;
  if (reminder.googleEventId) await syncToCalendar(reminder, reminderTitle(reminder), '');
  await persistState();
  renderAppPage(currentPage);
}

function renderVisits(content) {
  const upcoming = sortedVisits().filter((visit) => !dateParts(visit.date).isPast);
  const past = sortedVisits().filter((visit) => dateParts(visit.date).isPast).reverse();
  content.innerHTML = `${pageHead('Visits', 'Plan upcoming visits and keep a record of the ones that already happened.', '<button class="pill-button dark" id="add-visit">+ Schedule visit</button>')}
    <div class="app-grid">
      <article class="app-card section-card">
        <div class="card-head"><h2>Upcoming</h2></div>
        <div class="visit-list">${upcoming.length ? upcoming.map(visitRowMarkup).join('') : `<div class="empty-state"><div><h3>Nothing scheduled</h3><p>Schedule a visit to see it here.</p></div></div>`}</div>
      </article>
      ${past.length ? `<article class="app-card section-card">
        <div class="card-head"><h2>Past</h2></div>
        <div class="visit-list">${past.map(visitRowMarkup).join('')}</div>
      </article>` : ''}
    </div>`;
  wireVisitsAndReminders();
}

function renderReminders(content) {
  const sorted = sortedReminders();
  content.innerHTML = `${pageHead('Reminders', 'Caregiver to-dos, in one calm list.', '<button class="pill-button dark" id="add-reminder">+ Add reminder</button>')}
    <div class="app-grid">
      <article class="app-card section-card">
        <div class="reminder-list">${sorted.length ? sorted.map(reminderRowMarkup).join('') : `<div class="empty-state"><div><h3>No reminders yet</h3><p>Add a reminder to see it here.</p></div></div>`}</div>
      </article>
    </div>`;
  wireVisitsAndReminders();
}

function unacknowledgedFlaggedChats() {
  return (state.companionChats || []).filter((chat) => chat.analysis?.flagged && !chat.analysis?.acknowledged);
}

function flaggedChatBannerMarkup() {
  const flagged = unacknowledgedFlaggedChats();
  if (!flagged.length) return '';
  const latest = flagged[0];
  return `<div class="flagged-alert-banner" role="alert">
    <span class="flagged-alert-icon">✳</span>
    <div class="flagged-alert-copy"><b>${flagged.length} conversation${flagged.length === 1 ? '' : 's'} may need your attention</b><p>${escapeHtml(latest.analysis.flagReason || 'A recent chat with the companion showed signs worth a closer look.')}</p></div>
    <button class="action-button" data-review-flagged="${escapeHtml(latest.id)}">Review now</button>
  </div>`;
}

function wireFlaggedChatBanner(content) {
  content.querySelector('[data-review-flagged]')?.addEventListener('click', (event) => {
    companionView = { mode: 'detail', id: event.currentTarget.dataset.reviewFlagged };
    navigateApp('companion');
  });
}

function todaysBriefings() {
  const graph = buildMemoryGraph();
  return sortedVisits()
    .filter((visit) => dateParts(visit.date).isToday && visit.visitorId)
    .map((visit) => {
      const visitor = graph.visitorsById.get(visit.visitorId);
      if (!visitor) return null;
      const lastSession = graph.sessionsForPerson(visit.visitorId).find((s) => s.summary);
      const lastMemory = graph.memoriesForPerson(visit.visitorId)[0];
      const lines = [];
      if (lastSession) lines.push(`Last visit (${formatDate(lastSession.startedAt)}): ${lastSession.summary.summary}`);
      if (lastMemory) lines.push(`Remembered: "${lastMemory.title}", ${lastMemory.summary}`);
      return { visit, visitor, lines };
    })
    .filter(Boolean);
}

function briefingBannerMarkup() {
  const briefings = todaysBriefings();
  if (!briefings.length) return '';
  const first = briefings[0];
  const allMarkup = briefings.map((b) => `<div class="briefing-entry">
    <b>${escapeHtml(b.visitor.name)}</b>${b.visit.time ? ` <small>${escapeHtml(b.visit.time)}</small>` : ''}
    ${b.lines.length ? b.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') : '<p class="briefing-empty">No prior visit notes yet.</p>'}
  </div>`).join('');
  return `<div class="flagged-alert-banner briefing" role="status">
    <span class="flagged-alert-icon">☀</span>
    <div class="flagged-alert-copy">
      <b>${briefings.length === 1 ? `${escapeHtml(first.visitor.name)} visits today` : `${briefings.length} visits today`}${briefings.length === 1 && first.visit.time ? ` · ${escapeHtml(first.visit.time)}` : ''}</b>
      <p>${first.lines[0] ? escapeHtml(first.lines[0]) : `No prior visit notes yet for ${escapeHtml(first.visitor.name)}.`}</p>
      <div class="briefing-full hidden">${allMarkup}</div>
    </div>
    <button type="button" class="action-button" data-toggle-briefing>Full briefing</button>
  </div>`;
}

function wireBriefingBanner(content) {
  const button = content.querySelector('[data-toggle-briefing]');
  const panel = content.querySelector('.briefing-full');
  if (!button || !panel) return;
  button.onclick = () => {
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    button.textContent = opening ? 'Hide' : 'Full briefing';
  };
}

function triggerFlaggedChatAlert(chat) {
  if (!('Notification' in window)) return;
  const fire = () => {
    try {
      new Notification('Meco: a conversation may need your attention', {
        body: chat.analysis.flagReason || 'A recent chat with the companion showed signs worth a closer look.',
        icon: '/meco-icon.svg',
      });
    } catch {}
  };
  if (Notification.permission === 'granted') fire();
  else if (Notification.permission !== 'denied') Notification.requestPermission().then((permission) => { if (permission === 'granted') fire(); });
}

function buildSampleData() {
  const now = Date.now();
  const day = 86400000;
  const iso = (offsetDays, hour = 15) => { const d = new Date(now - offsetDays * day); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const safetyNote = 'This report supports caregiver review and is not medical advice.';

  const visitors = [
    { id: 'sample_visitor_sarah', name: 'Sarah Chen', relationship: 'Daughter', memory: 'Sunday garden walks and the blue photo album, always asks about the roses first.', descriptors: {}, thumbnail: '', registeredAt: iso(30) },
    { id: 'sample_visitor_james', name: 'James Chen', relationship: 'Son', memory: 'Old school stories and Saturday football on the radio. Brings a laugh into the room.', descriptors: {}, thumbnail: '', registeredAt: iso(28) },
    { id: 'sample_visitor_mei', name: 'Mei Lin', relationship: 'Friend', memory: 'Tea at 4pm most Wednesdays, always brings a new photo to share.', descriptors: {}, thumbnail: '', registeredAt: iso(24) },
    { id: 'sample_visitor_amir', name: 'Amir Osei', relationship: 'Caregiver', memory: 'Handles the morning routine and afternoon check-ins. Very gentle with reminders.', descriptors: {}, thumbnail: '', registeredAt: iso(20) },
  ];

  const sessionSeed = [
    { visitorId: 'sample_visitor_sarah', name: 'Sarah Chen', rel: 'Daughter', daysAgo: 1, transcript: [
        { speaker: 'A', displaySpeaker: 'Sarah Chen', text: "Hi Mum, it's Sarah. I brought the photos from the garden last weekend.", start: 0 },
        { speaker: 'B', displaySpeaker: state.settings.patientName, text: 'Oh, how lovely to see you. Did the roses come up alright this year?', start: 6000 },
        { speaker: 'A', displaySpeaker: 'Sarah Chen', text: "They did, they're doing really well. I'll bring you a cutting next time.", start: 12000 },
        { speaker: 'B', displaySpeaker: state.settings.patientName, text: "I'd like that. Sit down, tell me about the children.", start: 19000 },
      ], summary: { engagementScore: 88, emotionalTone: 'Warm and content', provider: 'Sample data', summary: 'A calm, affectionate visit centred on the garden and family photos. Strong recognition and sustained conversation throughout.', memoryCues: ['Garden roses', 'Blue photo album', 'Grandchildren'], caregiverInsights: ['Responded well to garden prompts', 'No signs of agitation'], followUpPrompt: 'Ask about the roses again next visit, it lit her up.', safetyNote } },
    { visitorId: 'sample_visitor_james', name: 'James Chen', rel: 'Son', daysAgo: 4, transcript: [
        { speaker: 'A', displaySpeaker: 'James Chen', text: 'Hey Mum, it’s James. City won again on Saturday, did you catch it?', start: 0 },
        { speaker: 'B', displaySpeaker: state.settings.patientName, text: 'James! I did hear something about it. Your father used to shout at that radio.', start: 5000 },
        { speaker: 'A', displaySpeaker: 'James Chen', text: "He really did. I still can't watch a match quietly because of him.", start: 11000 },
      ], summary: { engagementScore: 79, emotionalTone: 'Cheerful', provider: 'Sample data', summary: 'A light, humour-led visit. Recalled a specific memory of her late husband unprompted.', memoryCues: ['Saturday football', "Husband's radio habit"], caregiverInsights: ['Spontaneous long-term memory recall: a good sign'], followUpPrompt: 'Bring up football scores early; it opens the conversation quickly.', safetyNote } },
    { visitorId: 'sample_visitor_mei', name: 'Mei Lin', rel: 'Friend', daysAgo: 8, transcript: [
        { speaker: 'A', displaySpeaker: 'Mei Lin', text: "I brought a new photo: this one's from the community garden opening.", start: 0 },
        { speaker: 'B', displaySpeaker: state.settings.patientName, text: 'Let me see... oh, I remember that day. It was so warm.', start: 7000 },
        { speaker: 'A', displaySpeaker: 'Mei Lin', text: 'It really was. Shall I put the kettle on?', start: 13000 },
      ], summary: { engagementScore: 74, emotionalTone: 'Calm and reflective', provider: 'Sample data', summary: 'A gentle, unhurried visit over tea. Recognized the photo and placed it correctly in time.', memoryCues: ['Community garden opening', 'Wednesday tea'], caregiverInsights: ['Photo prompts continue to work well'], followUpPrompt: 'Keep bringing a fresh photo each visit, it consistently anchors the conversation.', safetyNote } },
    { visitorId: 'sample_visitor_sarah', name: 'Sarah Chen', rel: 'Daughter', daysAgo: 11, transcript: [
        { speaker: 'A', displaySpeaker: 'Sarah Chen', text: 'Morning Mum. How did you sleep?', start: 0 },
        { speaker: 'B', displaySpeaker: state.settings.patientName, text: 'Better than usual, thank you dear. Is it Sunday already?', start: 5000 },
        { speaker: 'A', displaySpeaker: 'Sarah Chen', text: 'It is, shall we go out to the garden for a bit?', start: 10000 },
      ], summary: { engagementScore: 85, emotionalTone: 'Warm and content', provider: 'Sample data', summary: 'Oriented to day of week without prompting. Suggested the garden walk herself.', memoryCues: ['Sunday routine', 'Garden walk'], caregiverInsights: ['Good day-orientation'], followUpPrompt: 'Offer the garden walk early in the visit, she asked for it unprompted.', safetyNote } },
    { visitorId: 'sample_visitor_james', name: 'James Chen', rel: 'Son', daysAgo: 15, transcript: [
        { speaker: 'A', displaySpeaker: 'James Chen', text: 'Hi Mum, just me popping by after work.', start: 0 },
        { speaker: 'B', displaySpeaker: state.settings.patientName, text: 'James, is it late? You look tired.', start: 6000 },
        { speaker: 'A', displaySpeaker: 'James Chen', text: 'Long day, but I wanted to see you. How are you feeling?', start: 12000 },
        { speaker: 'B', displaySpeaker: state.settings.patientName, text: 'A bit sleepy myself, but happy you’re here.', start: 18000 },
      ], summary: { engagementScore: 63, emotionalTone: 'A little tired, but engaged', provider: 'Sample data', summary: 'A shorter visit later in the day. Some tiredness on both sides but conversation stayed warm.', memoryCues: [], caregiverInsights: ['Consider scheduling evening visits a little earlier'], followUpPrompt: 'A shorter, earlier visit might suit better next time.', safetyNote } },
    { visitorId: 'sample_visitor_mei', name: 'Mei Lin', rel: 'Friend', daysAgo: 21, transcript: [
        { speaker: 'A', displaySpeaker: 'Mei Lin', text: 'Guess who brought scones today.', start: 0 },
        { speaker: 'B', displaySpeaker: state.settings.patientName, text: 'Mei! You spoil me. Sit, sit.', start: 5000 },
        { speaker: 'A', displaySpeaker: 'Mei Lin', text: 'Only the best for Wednesdays.', start: 9000 },
      ], summary: { engagementScore: 81, emotionalTone: 'Cheerful', provider: 'Sample data', summary: 'Immediate, warm recognition and a playful tone throughout.', memoryCues: ['Wednesday tea tradition'], caregiverInsights: ['Consistently strong recognition of Mei'], followUpPrompt: 'The Wednesday tea ritual is working, keep it exactly as is.', safetyNote } },
  ];

  const sessions = sessionSeed.map((seed, index) => ({
    id: `sample_session_${index}`,
    visitorId: seed.visitorId,
    visitorName: seed.name,
    relationship: seed.rel,
    participants: [seed.name],
    startedAt: iso(seed.daysAgo, 10 + index),
    endedAt: iso(seed.daysAgo, 10 + index),
    transcript: seed.transcript,
    summary: seed.summary,
  }));

  const visits = [
    { id: 'sample_visit_1', visitorId: 'sample_visitor_sarah', visitorName: 'Sarah Chen', date: new Date(now + 2 * day).toISOString().slice(0, 10), time: '15:00', endTime: '16:00', note: 'Bring the garden photos.', repeat: { freq: 'none', days: [] }, googleEventId: null },
    { id: 'sample_visit_2', visitorId: 'sample_visitor_james', visitorName: 'James Chen', date: new Date(now + 5 * day).toISOString().slice(0, 10), time: '18:00', endTime: '', note: 'After work, keep it short.', repeat: { freq: 'none', days: [] }, googleEventId: null },
  ];

  const journalEntries = [
    { id: 'sample_journal_1', title: '', mood: 'happy', html: '<p>Had tea with Mei today. She brought scones and we talked about the community garden.</p>', text: 'Had tea with Mei today. She brought scones and we talked about the community garden.', createdAt: iso(8, 16) },
    { id: 'sample_journal_2', title: '', mood: 'calm', html: '<p>Quiet morning. Sarah visited and we looked through the blue photo album together.</p>', text: 'Quiet morning. Sarah visited and we looked through the blue photo album together.', createdAt: iso(1, 12) },
  ];

  const careNotes = [
    { id: 'sample_note_1', text: 'Responds really well to garden photos, worth bringing one to most visits.', createdAt: iso(11, 17), pinned: true },
    { id: 'sample_note_2', text: 'Evening visits after 6pm tend to be shorter, she tires more easily by then.', createdAt: iso(15, 19), pinned: false },
    { id: 'sample_note_3', text: 'Loved the scones Mei brought on Wednesday, ask her to bring more next time.', createdAt: iso(21, 17), pinned: false },
  ];

  const moodCheckIns = [
    { id: 'sample_mood_1', mood: 'calm', createdAt: iso(0, 9) },
    { id: 'sample_mood_2', mood: 'happy', createdAt: iso(1, 15) },
    { id: 'sample_mood_3', mood: 'tired', createdAt: iso(2, 19) },
    { id: 'sample_mood_4', mood: 'okay', createdAt: iso(4, 11) },
    { id: 'sample_mood_5', mood: 'happy', createdAt: iso(8, 16) },
  ];

  return { visitors, sessions, visits, journalEntries, careNotes, moodCheckIns };
}

async function injectSampleData() {
  if (state.sampleDataActive) { toast('Sample data is already loaded.', ''); return; }
  const sample = buildSampleData();
  state.visitors = [...state.visitors, ...sample.visitors];
  state.sessions = [...sample.sessions, ...state.sessions];
  state.visits = [...state.visits, ...sample.visits];
  state.journalEntries = [...sample.journalEntries, ...state.journalEntries];
  state.careNotes = [...sample.careNotes, ...state.careNotes];
  state.moodCheckIns = [...sample.moodCheckIns, ...(state.moodCheckIns || [])];
  state.sampleDataActive = true;
  try {
    await persistState(false);
  } catch {

  }
  toast('Sample data loaded. Meco now shows a full care circle to demo. Recording a real visit adds right on top of it.', 'success');
  renderAppPage(currentPage);
}

async function clearSampleData() {
  if (!state.sampleDataActive) { toast('There is no sample data to remove.', ''); return; }
  const isSample = (id) => typeof id === 'string' && id.startsWith('sample_');
  state.visitors = state.visitors.filter((item) => !isSample(item.id));
  state.sessions = state.sessions.filter((item) => !isSample(item.id));
  state.visits = state.visits.filter((item) => !isSample(item.id));
  state.journalEntries = state.journalEntries.filter((item) => !isSample(item.id));
  state.careNotes = state.careNotes.filter((item) => !isSample(item.id));
  state.moodCheckIns = (state.moodCheckIns || []).filter((item) => !isSample(item.id));
  state.sampleDataActive = false;
  try {
    await persistState(false);
  } catch {

  }
  toast('Sample data cleared. Meco is back to a clean state.', 'success');
  renderAppPage(currentPage);
}

function demoCodeStripMarkup() {
  return `<div class="demo-code-strip">
    <label for="demo-code-input">Enter code</label>
    <input type="text" id="demo-code-input" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="••">
    <button type="button" id="demo-code-go" class="action-button">Go</button>
  </div>`;
}

function wireDemoCodeStrip(content) {
  const input = content.querySelector('#demo-code-input');
  const button = content.querySelector('#demo-code-go');
  if (!input || !button) return;
  const run = () => {
    const value = input.value.trim();
    input.value = '';
    if (value === '67') injectSampleData();
    else if (value === '76') clearSampleData();
    else if (value) toast("That code doesn't do anything.", '');
  };
  button.onclick = run;
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); run(); } };
}

function renderOverview(content) {
  const recent = state.sessions.slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 5);
  const reports = state.sessions.filter((session) => session.summary).length;
  const lastTone = recent.find((session) => session.summary)?.summary?.emotionalTone || 'No report yet';
  const pinnedNotes = (state.careNotes || []).filter((note) => note.pinned).slice(0, 2);
  const latestNote = pinnedNotes[0] || (state.careNotes || [])[0];
  const weekCount = weeklyVisitCounts(1)[0]?.count ?? 0;
  content.innerHTML = `${pageHead(`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}`, `Welcome to ${state.settings.patientName}'s memory space.`, '<button class="pill-button dark" id="overview-patient">Open patient mode</button>')}
    ${sosAlertBannerMarkup()}
    ${flaggedChatBannerMarkup()}
    ${briefingBannerMarkup()}
    ${onThisDayMarkup()}
    <div class="app-grid">
      <article class="app-card metric-card blue"><span>Trusted people</span><strong data-count-target="${state.visitors.length}">0</strong></article>
      <article class="app-card metric-card green"><span>Recorded visits</span><strong data-count-target="${state.sessions.length}">0</strong></article>
      <article class="app-card metric-card yellow"><span>AI reports</span><strong data-count-target="${reports}">0</strong></article>
      <article class="app-card metric-card peach"><span>Latest tone</span><strong style="font-size:28px">${escapeHtml(lastTone)}</strong></article>
      ${visitsCardMarkup()}
      ${remindersCardMarkup()}
      <article class="app-card activity-card"><div class="card-head"><h2>Recent visits</h2><button class="action-button" id="see-reports">View reports</button></div>
        ${recent.length ? `<div class="session-list">${recent.map(sessionRow).join('')}</div>` : `<div class="empty-state"><div><h3>No visits recorded yet</h3><p>Enroll a familiar person, then open patient mode to begin.</p></div></div>`}
      </article>
      <article class="app-card quick-card yellow"><div class="card-head"><h2>Quick start</h2></div><p>Set up Meco in three calm steps.</p><ol><li>Add a trusted person and capture three face angles.</li><li>Open patient mode and recognize the visitor.</li><li>Record the visit, transcribe speakers, and generate the report.</li></ol><div class="action-row"><button class="action-button primary" id="overview-add-person">Add person</button><button class="action-button" id="overview-settings">Settings</button></div></article>
      <article class="app-card teaser-tile" id="overview-insights-tile" role="button" tabindex="0" style="grid-column:span 6">
        <div class="teaser-tile-icon">◈</div>
        <div><h3>Insights</h3><p>${weekCount} visit${weekCount === 1 ? '' : 's'} this week. See the pattern across all of them.</p></div>
        <span class="teaser-tile-go">→</span>
      </article>
      <article class="app-card teaser-tile" id="overview-notes-tile" role="button" tabindex="0" style="grid-column:span 6">
        <div class="teaser-tile-icon">✒</div>
        <div><h3>Care Notes</h3><p>${latestNote ? `“${escapeHtml(latestNote.text.slice(0, 70))}${latestNote.text.length > 70 ? '…' : ''}”` : 'Nothing noted yet, leave something for next time.'}</p></div>
        <span class="teaser-tile-go">→</span>
      </article>
      ${objectMemoryOverviewCardMarkup()}
    </div>
    ${demoCodeStripMarkup()}`;
  content.querySelectorAll('[data-count-target]').forEach((el) => animateCountUp(el, el.dataset.countTarget));
  wireFlaggedChatBanner(content);
  wireSosAlertBanner(content);
  wireBriefingBanner(content);
  wireDemoCodeStrip(content);
  wireOnThisDay(content);
  const goInsights = () => navigateApp('insights');
  const goNotes = () => navigateApp('notes');
  $('#overview-insights-tile').onclick = goInsights;
  $('#overview-insights-tile').onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); goInsights(); } };
  $('#overview-notes-tile').onclick = goNotes;
  $('#overview-notes-tile').onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); goNotes(); } };
  const goObjects = () => navigateApp('settings');
  $('#overview-objects-tile')?.addEventListener('click', goObjects);
  $('#overview-objects-tile')?.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); goObjects(); } });
  $('#overview-patient').onclick = openPatientCameraMode;
  $('#see-reports').onclick = () => navigateApp('sessions');
  $('#overview-add-person').onclick = openFaceModal;
  $('#overview-settings').onclick = () => navigateApp('settings');
  wireVisitsAndReminders();
}

const genericSpeaker = (name) => /^(visitor|unrecognized visitor|other speaker|caregiver|speaker\s*\w*|listening…?)$/i.test(String(name || '').trim());

function sessionSpeakers(session) {
  const counts = new Map();
  (session.transcript || []).forEach((line) => {
    const name = String(line.displaySpeaker || line.speaker || '').trim();
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  const patientName = String(state.settings.patientName || '').toLowerCase();
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .filter((name) => name.toLowerCase() !== patientName);
}

function inferSessionVisitor() {
  if (patientContext?.visitor) {
    const visitor = patientContext.visitor;
    return { id: visitor.id, name: visitor.name, relationship: visitor.relationship || '' };
  }
  const named = sessionSpeakers({ transcript: patientContext?.transcript }).find((name) => !genericSpeaker(name));
  if (!named) return { id: null, name: 'Unrecognized visitor', relationship: '' };
  const known = state.visitors.find((item) => item.name.toLowerCase() === named.toLowerCase());
  return { id: known?.id || null, name: known?.name || named, relationship: known?.relationship || '' };
}

function sessionSubtitle(session) {
  const speakers = sessionSpeakers(session).filter((name) => !genericSpeaker(name));
  const parts = [];
  if (session.relationship) parts.push(session.relationship);
  if (speakers.length) parts.push(`With ${speakers.join(', ')}`);
  const turnCount = session.transcript?.length || 0;
  parts.push(`${turnCount} speaker turn${turnCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function sessionRow(session) {
  const tone = session.summary?.emotionalTone || (session.transcript?.length ? 'Transcript ready' : 'No transcript');
  const preview = session.summary?.summary
    || (session.transcript || []).map((line) => line.text).filter(Boolean).join(' ')
    || 'No conversation was captured for this visit.';
  return `<div class="session-row"><div class="person-avatar">${escapeHtml(sessionTitle(session)[0] || '?')}</div><div class="row-copy"><b>${escapeHtml(sessionTitle(session))}</b><small>${escapeHtml(sessionSubtitle(session))}</small><div class="session-row-preview"><p>${escapeHtml(preview.slice(0, 120))}${preview.length > 120 ? '…' : ''}</p></div></div><div class="row-meta"><span class="badge">${escapeHtml(tone)}</span><br>${escapeHtml(formatDate(session.startedAt))}</div></div>`;
}

function personRow(visitor) {
  const voice = voiceprintFor(visitor);
  const voiceButton = voiceIdAvailable() ? `<button class="action-button" data-voice-person="${escapeHtml(visitor.id)}">${voice ? 'Re-record voice' : 'Add voice'}</button>` : '';
  return `<div class="person-row" data-person-id="${escapeHtml(visitor.id)}"><div class="person-avatar">${visitor.thumbnail ? `<img src="${visitor.thumbnail}" alt="">` : escapeHtml(visitor.name[0] || '?')}</div><div class="row-copy"><b>${escapeHtml(visitor.name)}</b><small>${escapeHtml(visitor.relationship)} · ${escapeHtml(visitor.memory || 'No memory cue yet')}${voice ? ' · Voice enrolled' : ''}</small><button type="button" class="link-button person-why-toggle" data-why-person="${escapeHtml(visitor.id)}">Why do I know them?</button><div class="person-why hidden"></div></div><div class="action-row">${voiceButton}<button class="action-button" data-edit-person="${escapeHtml(visitor.id)}">Edit details</button><button class="action-button danger" data-delete-person="${escapeHtml(visitor.id)}">Delete</button></div></div>`;
}

async function recordVisitorVoice(id) {
  const visitor = state.visitors.find((item) => item.id === id);
  const button = $(`[data-voice-person="${CSS.escape(id)}"]`);
  if (!visitor || !button || button.disabled) return;
  const sentence = voicePromptSentence();
  if (!confirm(`${visitor.name} will be recorded for 12 seconds. Ask them to read this sentence aloud:\n\n"${sentence}"\n\nStart the voice sample now?`)) return;
  button.disabled = true;

  const rowCopy = button.closest('.person-row')?.querySelector('.row-copy small');
  try {
    const result = await enrollVoiceSample({ name: visitor.name, personId: visitor.id }, (secondsLeft) => {
      button.textContent = `Listening… ${secondsLeft}s`;
      if (rowCopy) rowCopy.textContent = `Read aloud: “${sentence}” · ${secondsLeft}s left`;
    });
    visitor.voiceId = result.id;
    await persistState(true);
    toast(`${visitor.name}'s voiceprint is saved.`, 'success');
  } catch (error) {
    toast(`Voice sample failed: ${error.message}`, 'error');
  } finally {
    renderPeople($('#app-content'));
  }
}

function renderPeople(content) {
  content.innerHTML = `${pageHead('Trusted people', 'Enroll familiar visitors using real face descriptors.', '<button class="pill-button dark" id="add-person">Add trusted person</button>')}
    <article class="app-card section-card"><div class="card-head"><h2>${state.visitors.length} people</h2><span class="badge">On-device matching</span></div>
      ${state.visitors.length ? `<div class="people-list">${state.visitors.map(personRow).join('')}</div>` : `<div class="empty-state"><div><h3>No one is enrolled</h3><p>Start with a family member or regular caregiver.</p><button class="action-button primary" id="empty-add-person">Add the first person</button></div></div>`}
    </article>`;
  $('#add-person').onclick = openFaceModal;
  $('#empty-add-person')?.addEventListener('click', openFaceModal);
  if (!voiceprintsLoaded) loadVoiceprints().then(() => { if (currentPage === 'people') renderPeople($('#app-content')); });
  $$('[data-voice-person]').forEach((button) => button.onclick = () => recordVisitorVoice(button.dataset.voicePerson));
  $$('[data-edit-person]').forEach((button) => button.onclick = () => openPersonEditor(button.dataset.editPerson));
  $$('[data-delete-person]').forEach((button) => button.onclick = () => deleteVisitor(button.dataset.deletePerson));
  $$('[data-why-person]').forEach((button) => button.onclick = () => {
    const visitor = state.visitors.find((item) => item.id === button.dataset.whyPerson);
    const panel = button.nextElementSibling;
    if (!visitor || !panel) return;
    const opening = panel.classList.contains('hidden');
    if (opening) panel.innerHTML = whyKnowThisPerson(visitor);
    panel.classList.toggle('hidden', !opening);
    button.textContent = opening ? 'Hide' : 'Why do I know them?';
  });
}

let editingPersonId = null;

function youtubeIdFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.slice(1) || null;
    if (parsed.hostname.includes('youtube.com')) {
      if (parsed.searchParams.get('v')) return parsed.searchParams.get('v');
      const embedMatch = parsed.pathname.match(/\/embed\/([\w-]+)/);
      if (embedMatch) return embedMatch[1];
    }
  } catch {  }
  return null;
}

function openPersonEditor(id) {
  const visitor = state.visitors.find((item) => item.id === id);
  if (!visitor) return;
  editingPersonId = id;
  $('#edit-person-name').value = visitor.name || '';
  $('#edit-person-relationship').value = visitor.relationship || '';
  $('#edit-person-memory').value = visitor.memory || '';
  $('#edit-person-song-title').value = visitor.songTitle || '';
  $('#edit-person-song-url').value = visitor.songUrl || '';
  $('#person-modal').classList.remove('hidden');
  $('#edit-person-name').focus();
}

function closePersonEditor() {
  editingPersonId = null;
  $('#person-modal').classList.add('hidden');
}

async function savePersonDetails() {
  const visitor = state.visitors.find((item) => item.id === editingPersonId);
  if (!visitor) return closePersonEditor();
  const name = $('#edit-person-name').value.trim();
  const relationship = $('#edit-person-relationship').value.trim();
  const memory = $('#edit-person-memory').value.trim();
  const songTitle = $('#edit-person-song-title').value.trim();
  const songUrl = $('#edit-person-song-url').value.trim();
  if (!name || !relationship) return toast('A name and relationship are both needed.', 'error');
  if (songUrl && !youtubeIdFromUrl(songUrl)) return toast("That doesn't look like a YouTube link Meco can play, try the full youtube.com or youtu.be URL.", 'error');
  const previous = { name: visitor.name, relationship: visitor.relationship, memory: visitor.memory, songTitle: visitor.songTitle, songUrl: visitor.songUrl };
  visitor.name = name.slice(0, 80);
  visitor.relationship = relationship.slice(0, 80);
  visitor.memory = memory.slice(0, 500);
  visitor.songTitle = songTitle.slice(0, 120);
  visitor.songUrl = songUrl.slice(0, 300);
  $('#save-person-details').disabled = true;
  try {
    await persistState(true);
    closePersonEditor();
    renderAppPage(currentPage);
  } catch {
    Object.assign(visitor, previous);
  } finally {
    $('#save-person-details').disabled = false;
  }
}

async function deleteVisitor(id) {
  const visitor = state.visitors.find((item) => item.id === id);
  if (!visitor || !confirm(`Remove ${visitor.name} from trusted people? Existing visit reports will remain.`)) return;
  state.visitors = state.visitors.filter((item) => item.id !== id);
  await persistState(true);
  renderPeople($('#app-content'));
}

function renderMemory(content) {
  content.innerHTML = `${pageHead('Memory Book', 'Caregiver-approved stories, routines and reassuring prompts.', '<button class="pill-button dark" id="memory-add-person">Add person</button>')}
    <div class="app-grid">
      ${state.visitors.length ? state.visitors.map((visitor, index) => `<article class="app-card memory-book-card ${['blue','green','yellow','peach'][index % 4]}"><div class="card-head"><div style="display:flex;align-items:center;gap:12px"><div class="person-avatar">${visitor.thumbnail ? `<img src="${visitor.thumbnail}" alt="">` : escapeHtml(visitor.name[0])}</div><div><h2 style="margin:0">${escapeHtml(visitor.name)}</h2><small>${escapeHtml(visitor.relationship)}</small></div></div><button class="action-button" data-edit-memory="${escapeHtml(visitor.id)}">Edit</button></div><p style="font-family:var(--serif);font-size:28px;line-height:1.18">“${escapeHtml(visitor.memory || 'Add a familiar story, place, routine or reassuring detail.')}”</p></article>`).join('') : `<article class="app-card section-card"><div class="empty-state"><div><h3>Your Memory Book is empty</h3><p>Memory cues are added when you enroll trusted people.</p></div></div></article>`}
    </div>`;
  $('#memory-add-person').onclick = openFaceModal;
  $$('[data-edit-memory]').forEach((button) => button.onclick = () => openPersonEditor(button.dataset.editMemory));
}

const asList = (value) => Array.isArray(value) ? value : (value == null || value === '') ? [] : [String(value)];

const REMINDER_TIME_SIGNAL = /\b(today|tomorrow|tonight|this (morning|afternoon|evening|weekend)|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{1,2}(:\d{2})?\s?(am|pm)\b|\d{1,2}(st|nd|rd|th)?\s(of\s)?(january|february|march|april|may|june|july|august|september|october|november|december))/i;
const REMINDER_ACTION_SIGNAL = /\b(remember to|don'?t forget|remind (me|her|him|them)|appointment|check[- ]?up|call|bring|pick up|drop off|birthday|come (over|by)|see the (doctor|dentist|gp)|visit(ing)?)\b/i;

function extractReminderSuggestions(transcript) {
  const seen = new Set();
  const candidates = [];
  (transcript || []).forEach((line) => {
    const text = (line.text || '').trim();
    if (text.length < 8 || !REMINDER_TIME_SIGNAL.test(text) || !REMINDER_ACTION_SIGNAL.test(text)) return;
    const key = text.toLowerCase().slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ id: `sugg_${candidates.length}`, text: text.length > 140 ? `${text.slice(0, 140).trim()}…` : text, speaker: line.displaySpeaker || line.speaker || '' });
  });
  return candidates.slice(0, 5);
}

function reminderSuggestionsMarkup(transcript) {
  const candidates = extractReminderSuggestions(transcript);
  if (!candidates.length) return '';
  return `<div class="reminder-suggestions">
    <div class="reminder-suggestions-head"><b>Suggested reminders from this visit</b><small>Picked out from the transcript. Nothing is added until you accept one.</small></div>
    ${candidates.map((c) => `<div class="reminder-suggestion-row" data-suggestion-id="${escapeHtml(c.id)}">
      <p>“${escapeHtml(c.text)}”${c.speaker ? `<span class="reminder-suggestion-speaker">, ${escapeHtml(c.speaker)}</span>` : ''}</p>
      <div class="reminder-suggestion-actions">
        <button type="button" class="action-button primary" data-accept-suggestion="${escapeHtml(c.text)}">+ Add reminder</button>
        <button type="button" class="icon-button" data-dismiss-suggestion="${escapeHtml(c.id)}" title="Dismiss">✕</button>
      </div>
    </div>`).join('')}
  </div>`;
}

function wireReminderSuggestions(container) {
  container?.querySelectorAll('[data-accept-suggestion]').forEach((button) => {
    button.onclick = () => {
      openReminderModal(null);
      $('#reminder-text').value = button.dataset.acceptSuggestion;
      button.closest('.reminder-suggestion-row')?.remove();
    };
  });
  container?.querySelectorAll('[data-dismiss-suggestion]').forEach((button) => {
    button.onclick = () => button.closest('.reminder-suggestion-row')?.remove();
  });
}

function summaryMarkup(summary) {
  if (!summary) return '<p>No AI report was generated for this visit.</p>';
  return `<div class="summary-panel"><div style="display:flex;align-items:center;gap:18px"><div class="score-ring" style="--score:${Number(summary.engagementScore || 0)}"><strong>${Number(summary.engagementScore || 0)}</strong></div><div><h3 style="margin:0">${escapeHtml(summary.emotionalTone || 'Visit report')}</h3><small>Observational engagement score · ${escapeHtml(summary.provider || 'AI')}</small></div></div><div class="summary-box"><h4>Summary</h4><p>${escapeHtml(summary.summary || '')}</p></div><div class="summary-box"><h4>Useful memory cues</h4><p>${escapeHtml(asList(summary.memoryCues).join(' · ') || 'None highlighted')}</p></div><div class="summary-box"><h4>Caregiver insights</h4><p>${escapeHtml(asList(summary.caregiverInsights).join(' · ') || '')}</p></div><div class="summary-box"><h4>Next prompt</h4><p>${escapeHtml(summary.followUpPrompt || '')}</p></div><small>${escapeHtml(summary.safetyNote || 'This report supports caregiver review and is not medical advice.')}</small></div>`;
}

const sessionTitle = (session) => session?.title?.trim() || session?.visitorName || 'Unrecognized visitor';

function renameSession(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  const next = window.prompt('Name this visit', sessionTitle(session));
  if (next === null) return;
  const title = next.trim().slice(0, 90);
  session.title = title === session.visitorName ? '' : title;
  queueSave();
  renderSessions($('#app-content'));
}

function sessionCard(session) {
  const tone = session.summary?.emotionalTone || (session.transcript?.length ? 'Transcript ready' : 'No transcript');
  const preview = session.summary?.summary
    || (session.transcript || []).map((line) => line.text).filter(Boolean).join(' ')
    || 'No conversation was captured for this visit.';
  return `<article class="app-card visit-card" tabindex="0" role="button" data-open-session="${escapeHtml(session.id)}">
    <div class="visit-card-top"><div class="person-avatar">${escapeHtml(sessionTitle(session)[0] || '?')}</div><div><h3>${escapeHtml(sessionTitle(session))}</h3><div class="visit-card-date">${escapeHtml(formatDate(session.startedAt))}</div></div></div>
    <p>${escapeHtml(preview.slice(0, 150))}${preview.length > 150 ? '…' : ''}</p>
    <div class="visit-card-foot"><span class="badge">${escapeHtml(tone)}</span><small>${turnsLabel(session.transcript?.length || 0)}</small></div>
  </article>`;
}

function renderSessionDetail(content, session) {
  content.innerHTML = `${pageHead('Visit Reports', 'Speaker-labelled transcripts and caregiver-reviewed summaries.', '<button class="action-button" id="back-to-visits">← All visits</button>')}
    <article class="app-card section-card">
      <div class="detail-head">
        <div style="display:flex;gap:14px;align-items:center"><div class="person-avatar">${escapeHtml(sessionTitle(session)[0] || '?')}</div><div><h2>${escapeHtml(sessionTitle(session))}</h2><small>${escapeHtml(sessionSubtitle(session))} · ${escapeHtml(formatDate(session.startedAt))}</small></div></div>
        <div class="action-row">
          <button class="action-button" data-rename-session="${escapeHtml(session.id)}">Rename</button>
          <button class="action-button" data-report-session="${escapeHtml(session.id)}" ${session.transcript?.length ? '' : 'disabled'}>${session.summary ? 'Regenerate report' : 'Generate AI report'}</button>
          <button class="action-button" data-save-memory-session="${escapeHtml(session.id)}" ${session.transcript?.length ? '' : 'disabled'}>Save as memory</button>
          <button class="action-button" data-download-session="${escapeHtml(session.id)}" ${session.transcript?.length ? '' : 'disabled'}>Download .txt</button>
          <button class="action-button" data-print-session="${escapeHtml(session.id)}">Print report</button>
          <button class="action-button danger" data-delete-session="${escapeHtml(session.id)}">Delete</button>
        </div>
      </div>
      ${summaryMarkup(session.summary)}
      <div id="related-memories-slot"></div>
      ${reminderSuggestionsMarkup(session.transcript)}
      <div id="memory-candidates-slot"></div>
      <div class="card-head" style="margin-top:26px"><h2>Conversation</h2><span class="badge">${turnsLabel(session.transcript?.length || 0)}</span></div>
      <div class="transcript-scroll">${(session.transcript || []).map(utteranceMarkupReadOnly).join('') || '<div class="empty-state"><p>No transcript was captured for this visit.</p></div>'}</div>
    </article>`;
  $('#back-to-visits').onclick = () => { sessionsView = { mode: 'list', id: null }; renderSessions(content); };
  wireSessionActions(content);
  wireReminderSuggestions(content);
  $('[data-print-session]')?.addEventListener('click', () => printSessionReport(session.id));
  $('[data-save-memory-session]')?.addEventListener('click', () => extractMemoriesFromSession(session, content.querySelector('#memory-candidates-slot')));
  if (session.summary?.summary) renderRelatedMemoriesForSession(session, content.querySelector('#related-memories-slot'));
}

async function renderRelatedMemoriesForSession(session, slot) {
  if (!slot || !(state.memories || []).length) return;
  try {
    const memories = recallMemoryDigest();
    const result = await apiFetch('/api/memories/related', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: session.summary.summary, memories }),
    });
    if (!result.related?.length) return;
    const memoriesById = new Map((state.memories || []).map((m) => [m.id, m]));
    const cards = result.related.map((r) => {
      const memory = memoriesById.get(r.memoryId);
      if (!memory) return '';
      return `<button type="button" class="related-memory-card" data-open-related-memory="${escapeHtml(memory.id)}">
        <b>${escapeHtml(memory.title)}</b>
        <small>${escapeHtml(r.why)}</small>
      </button>`;
    }).join('');
    if (!cards) return;
    slot.innerHTML = `<div class="related-memories">
      <div class="related-memories-head"><b>Related to earlier memories</b><small>Might be useful context for this visit.</small><button type="button" class="icon-button" data-dismiss-related title="Dismiss">✕</button></div>
      ${cards}
    </div>`;
    slot.querySelectorAll('[data-open-related-memory]').forEach((card) => {
      card.onclick = () => openMemoryDetail(card.dataset.openRelatedMemory);
    });
    slot.querySelector('[data-dismiss-related]').onclick = () => { slot.innerHTML = ''; };
  } catch {

  }
}

async function extractMemoriesFromSession(session, slot) {
  slot.innerHTML = `<div class="empty-state"><p>Looking for memories worth keeping from this visit…</p></div>`;
  try {
    const result = await apiFetch('/api/memories/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitorName: session.visitorName,
        relationship: session.relationship,
        summary: session.summary?.summary,
        transcript: session.transcript,
      }),
    });
    if (!result.candidates?.length) {
      slot.innerHTML = `<div class="empty-state"><p>Nothing distinct enough to save as its own memory was found in this visit.</p></div>`;
      return;
    }
    memoryCandidatesCache = result.candidates;
    slot.innerHTML = memoryCandidatesMarkup(result.candidates);
    wireMemoryCandidates(slot, session);
  } catch (error) {
    slot.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function memoryCandidatesMarkup(candidates) {
  return `<div class="reminder-suggestions">
    <div class="reminder-suggestions-head"><b>Memories worth keeping from this visit</b><small>Nothing is saved until you accept one.</small></div>
    ${candidates.map((c, i) => `<div class="reminder-suggestion-row" data-candidate-index="${i}">
      <p><b>${escapeHtml(c.title)}</b> ${confidenceBadgeMarkup(c.confidence)}<br>${escapeHtml(c.summary)}</p>
      <div class="reminder-suggestion-actions">
        <button type="button" class="action-button primary" data-accept-memory="${i}">+ Save memory</button>
        <button type="button" class="icon-button" data-dismiss-memory="${i}" title="Dismiss">✕</button>
      </div>
    </div>`).join('')}
  </div>`;
}

function wireMemoryCandidates(slot, session) {
  const candidates = [];
  slot.querySelectorAll('[data-accept-memory]').forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('[data-candidate-index]');
      const index = Number(row.dataset.candidateIndex);
      const c = memoryCandidatesCache[index];
      if (!c) return;
      const memory = {
        id: `mem_${Date.now()}_${index}`,
        title: c.title, date: session.startedAt, peopleIds: session.visitorId ? [session.visitorId] : [],
        placeId: null, sessionId: session.id, journalEntryId: null, photoDataUrls: [],
        summary: c.summary, details: c.details, tags: c.tags,
        source: 'session', confidence: c.confidence,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      state.memories = [memory, ...(state.memories || [])].slice(0, 500);
      await persistState(true);
      row.remove();
    };
  });
  slot.querySelectorAll('[data-dismiss-memory]').forEach((btn) => {
    btn.onclick = () => btn.closest('[data-candidate-index]')?.remove();
  });
}

function printSessionReport(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  const win = window.open('', '_blank', 'width=800,height=900');
  if (!win) return toast('Your browser blocked the print window, allow pop-ups for Meco to print a report.', 'error');
  const summary = session.summary;
  const turns = (session.transcript || []).map((line) => `<div class="turn"><b>${escapeHtml(line.displaySpeaker || line.speaker || 'Speaker')} · ${escapeHtml(formatDuration(line.start || 0))}</b>${escapeHtml(line.text || '')}${line.translation ? `<i>${escapeHtml(line.translation)}</i>` : ''}</div>`).join('') || '<p><em>No transcript was captured for this visit.</em></p>';
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sessionTitle(session))} | Meco visit report</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;color:#161513;max-width:720px;margin:44px auto;padding:0 24px;line-height:1.6}
  h1{font-size:30px;margin:0 0 6px;font-weight:400}
  .meta{color:#666;font-size:13px;margin-bottom:6px;font-family:Arial,sans-serif}
  .brand{font-family:Arial,sans-serif;font-weight:700;letter-spacing:-.03em;font-size:13px;color:#999;margin-bottom:22px}
  h2{font-size:16px;font-family:Arial,sans-serif;border-bottom:1px solid #ddd;padding-bottom:6px;margin-top:30px}
  .turn{margin:12px 0;font-size:14px}
  .turn b{display:block;font-size:11px;color:#777;font-family:Arial,sans-serif;font-weight:700;margin-bottom:2px}
  .turn i{display:block;color:#888;font-style:italic;font-size:13px;margin-top:2px}
  .note{color:#888;font-size:11px;margin-top:44px;font-family:Arial,sans-serif;border-top:1px solid #eee;padding-top:14px}
  @media print{ body{margin:0;padding:26px} }
</style></head><body>
  <div class="brand">MECO, VISIT REPORT</div>
  <h1>${escapeHtml(sessionTitle(session))}</h1>
  <div class="meta">${escapeHtml(sessionSubtitle(session))} · ${escapeHtml(formatDate(session.startedAt))}</div>
  ${summary ? `<h2>Summary</h2><p>${escapeHtml(summary.summary || '')}</p>
    <h2>Memory cues</h2><p>${escapeHtml(asList(summary.memoryCues).join(' · ') || 'None highlighted')}</p>
    <h2>Caregiver insights</h2><p>${escapeHtml(asList(summary.caregiverInsights).join(' · ') || '')}</p>
    <h2>Follow-up prompt</h2><p>${escapeHtml(summary.followUpPrompt || '')}</p>` : '<h2>Summary</h2><p><em>No AI report was generated for this visit.</em></p>'}
  <h2>Conversation</h2>
  ${turns}
  <p class="note">${escapeHtml(summary?.safetyNote || 'This report supports caregiver review and is not medical advice.')}<br>Printed from Meco on ${escapeHtml(new Date().toLocaleDateString())}.</p>
</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

function weeklyVisitCounts(weeks = 8) {
  const now = new Date();
  const startOfWeek = (d) => { const x = new Date(d); const day = x.getDay(); x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; };
  const thisWeekStart = startOfWeek(now);
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const start = new Date(thisWeekStart); start.setDate(start.getDate() - (weeks - 1 - i) * 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    return { start, end, count: 0, label: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
  });
  state.sessions.forEach((session) => {
    if (!session.startedAt) return;
    const at = new Date(session.startedAt);
    const bucket = buckets.find((b) => at >= b.start && at < b.end);
    if (bucket) bucket.count += 1;
  });
  return buckets;
}

function toneDistribution() {
  const counts = new Map();
  state.sessions.forEach((session) => {
    const tone = session.summary?.emotionalTone;
    if (!tone) return;
    counts.set(tone, (counts.get(tone) || 0) + 1);
  });
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0) || 1;
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tone, count]) => ({ tone, count, pct: Math.round((count / total) * 100) }));
}

function topVisitedPeople(limit = 5) {
  const counts = new Map();
  state.sessions.forEach((session) => {
    const name = session.visitorName || 'Unrecognized visitor';
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  const max = Math.max(1, ...counts.values());
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, count, pct: Math.round((count / max) * 100) }));
}

function weeklyAverageBuckets(records, weeks, valueFn) {
  const now = new Date();
  const startOfWeek = (d) => { const x = new Date(d); const day = x.getDay(); x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; };
  const thisWeekStart = startOfWeek(now);
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const start = new Date(thisWeekStart); start.setDate(start.getDate() - (weeks - 1 - i) * 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    return { start, end, values: [], label: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
  });
  records.forEach((record) => {
    if (!record.at) return;
    const at = new Date(record.at);
    const bucket = buckets.find((b) => at >= b.start && at < b.end);
    const value = valueFn(record);
    if (bucket && value != null) bucket.values.push(value);
  });
  return buckets.map((b) => ({ label: b.label, count: b.values.length ? Math.round((b.values.reduce((a, v) => a + v, 0) / b.values.length) * 10) / 10 : 0 }));
}

function cognitiveActivityAccuracy() {
  const byType = new Map();
  (state.cognitiveAttempts || []).forEach((a) => {
    const bucket = byType.get(a.activityType) || { total: 0, correct: 0 };
    bucket.total += 1;
    if (a.correct) bucket.correct += 1;
    byType.set(a.activityType, bucket);
  });
  return [...byType.entries()].map(([activityType, b]) => ({
    label: STIMULATION_ACTIVITY_LABEL[activityType] || activityType,
    count: b.total, pct: Math.round((b.correct / b.total) * 100),
  })).sort((a, b) => b.count - a.count);
}

const CUE_LEVEL_LABEL = { 5: 'Full answer shown', 4: 'Context sentence', 3: 'Person photo/name', 2: 'Partial word', 1: 'Category hint', 0: 'Independent recall' };
function cueEffectivenessTally() {
  const byLevel = new Map();
  (state.retrievalAttempts || []).forEach((a) => {
    const bucket = byLevel.get(a.cueLevelUsed) || { total: 0, success: 0 };
    bucket.total += 1;
    if (a.success) bucket.success += 1;
    byLevel.set(a.cueLevelUsed, bucket);
  });
  return [...byLevel.entries()].sort((a, b) => b[0] - a[0]).map(([level, b]) => ({
    label: CUE_LEVEL_LABEL[level] || `Level ${level}`,
    count: b.total, pct: Math.round((b.success / b.total) * 100),
  }));
}

function cognitiveInsightsSummary() {
  const stim = state.cognitiveAttempts || [];
  const ret = state.retrievalAttempts || [];
  const stimAccuracy = stim.length ? Math.round((stim.filter((a) => a.correct).length / stim.length) * 100) : null;
  const avgCue = ret.length ? Math.round((ret.reduce((sum, a) => sum + (Number(a.cueLevelUsed) || 0), 0) / ret.length) * 10) / 10 : null;
  const hintRate = stim.length ? Math.round((stim.filter((a) => a.hintsUsed).length / stim.length) * 100) : null;
  return { stimCount: stim.length, retCount: ret.length, stimAccuracy, avgCue, hintRate };
}

function renderCognitiveInsightsSection() {
  const summary = cognitiveInsightsSummary();
  const cueTrend = weeklyAverageBuckets(state.retrievalAttempts || [], 4, (a) => Number(a.cueLevelUsed));
  const accuracyTrend = weeklyAverageBuckets(state.cognitiveAttempts || [], 4, (a) => (a.correct ? 100 : 0));
  const activityRows = cognitiveActivityAccuracy();
  const cueRows = cueEffectivenessTally();
  const hasData = summary.stimCount > 0 || summary.retCount > 0;
  if (!hasData) {
    return `<div class="empty-state"><div><h3>Nothing logged yet</h3><p>Numbers appear here once Stimulation or Practice have been used a few times: this page only ever describes what's already happened, never predicts.</p></div></div>`;
  }
  return `<div class="app-grid">
    <article class="app-card metric-card blue"><span>Stimulation attempts</span><strong>${summary.stimCount}</strong></article>
    <article class="app-card metric-card green"><span>Stimulation accuracy</span><strong>${summary.stimAccuracy ?? 'n/a'}${summary.stimAccuracy != null ? '%' : ''}</strong></article>
    <article class="app-card metric-card yellow"><span>Practice reviews</span><strong>${summary.retCount}</strong></article>
    <article class="app-card metric-card peach"><span>Average cue level used</span><strong>${summary.avgCue ?? 'n/a'}</strong></article>
    <article class="app-card section-card">
      <div class="card-head"><h2>Average cue assistance</h2><span class="badge">Last 4 weeks</span></div>
      <p class="calming-hint">Higher means more assistance was needed to recall; lower means more was recalled independently.</p>
      ${(state.retrievalAttempts || []).length ? insightsTrendSvg(cueTrend) : `<div class="empty-state"><p>Use Practice a few times to see this trend.</p></div>`}
    </article>
    <article class="app-card section-card">
      <div class="card-head"><h2>Stimulation accuracy over time</h2><span class="badge">Last 4 weeks</span></div>
      ${(state.cognitiveAttempts || []).length ? insightsTrendSvg(accuracyTrend) : `<div class="empty-state"><p>Use Stimulation a few times to see this trend.</p></div>`}
    </article>
    <article class="app-card" style="grid-column:span 6">
      <div class="card-head"><h2>Accuracy by activity type</h2></div>
      ${activityRows.length ? `<div class="insight-bars">${activityRows.map((r) => `<div class="insight-bar-row"><span class="insight-bar-label">${escapeHtml(r.label)}</span><div class="insight-bar-track"><div class="insight-bar-fill" style="width:${r.pct}%;background:#8fb7f0"></div></div><span class="insight-bar-value">${r.pct}%</span></div>`).join('')}</div>` : `<div class="empty-state"><p>No stimulation attempts logged yet.</p></div>`}
    </article>
    <article class="app-card" style="grid-column:span 6">
      <div class="card-head"><h2>Cue effectiveness</h2></div>
      <p class="calming-hint">Success rate at each level of assistance offered during Practice.</p>
      ${cueRows.length ? `<div class="insight-bars">${cueRows.map((r) => `<div class="insight-bar-row"><span class="insight-bar-label">${escapeHtml(r.label)}</span><div class="insight-bar-track"><div class="insight-bar-fill" style="width:${r.pct}%;background:#e0c25f"></div></div><span class="insight-bar-value">${r.pct}%</span></div>`).join('')}</div>` : `<div class="empty-state"><p>No practice reviews logged yet.</p></div>`}
    </article>
    <article class="app-card section-card" style="grid-column:span 12">
      <div class="card-head"><h2>Export</h2></div>
      <p class="calming-hint">A plain summary of the numbers above, descriptive only, suitable to share with a healthcare professional. Not a diagnosis.</p>
      <button class="action-button" id="export-cognitive-insights">Export summary</button>
    </article>
  </div>`;
}

function exportCognitiveInsightsSummary() {
  const summary = cognitiveInsightsSummary();
  const activityRows = cognitiveActivityAccuracy();
  const cueRows = cueEffectivenessTally();
  const win = window.open('', '_blank', 'width=800,height=900');
  if (!win) return toast('Your browser blocked the print window, allow pop-ups for Meco to print a summary.', 'error');
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Cognitive activity summary | Meco</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;color:#161513;max-width:720px;margin:44px auto;padding:0 24px;line-height:1.6}
  h1{font-size:30px;margin:0 0 6px;font-weight:400}
  .meta{color:#666;font-size:13px;margin-bottom:22px;font-family:Arial,sans-serif}
  .brand{font-family:Arial,sans-serif;font-weight:700;letter-spacing:-.03em;font-size:13px;color:#999;margin-bottom:22px}
  h2{font-size:16px;font-family:Arial,sans-serif;border-bottom:1px solid #ddd;padding-bottom:6px;margin-top:30px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:6px 0;border-bottom:1px solid #eee}
  td:last-child{text-align:right;font-weight:700}
  .note{color:#888;font-size:11px;margin-top:44px;font-family:Arial,sans-serif;border-top:1px solid #eee;padding-top:14px}
  @media print{ body{margin:0;padding:26px} }
</style></head><body>
  <div class="brand">MECO, COGNITIVE ACTIVITY SUMMARY</div>
  <h1>${escapeHtml(state.settings.patientName || 'Meco member')}</h1>
  <div class="meta">Generated ${escapeHtml(new Date().toLocaleDateString())} · Descriptive summary only, not a diagnosis</div>
  <h2>Overview</h2>
  <table>
    <tr><td>Stimulation attempts</td><td>${summary.stimCount}</td></tr>
    <tr><td>Stimulation accuracy</td><td>${summary.stimAccuracy ?? 'n/a'}${summary.stimAccuracy != null ? '%' : ''}</td></tr>
    <tr><td>Practice reviews</td><td>${summary.retCount}</td></tr>
    <tr><td>Average cue level used (0 independent to 5 full answer)</td><td>${summary.avgCue ?? 'n/a'}</td></tr>
    <tr><td>Attempts where a hint was used</td><td>${summary.hintRate ?? 'n/a'}${summary.hintRate != null ? '%' : ''}</td></tr>
  </table>
  <h2>Accuracy by activity type</h2>
  <table>${activityRows.map((r) => `<tr><td>${escapeHtml(r.label)} (${r.count} attempt${r.count === 1 ? '' : 's'})</td><td>${r.pct}%</td></tr>`).join('') || '<tr><td colspan="2">No data yet.</td></tr>'}</table>
  <h2>Cue effectiveness</h2>
  <table>${cueRows.map((r) => `<tr><td>${escapeHtml(r.label)} (${r.count} time${r.count === 1 ? '' : 's'})</td><td>${r.pct}% successful</td></tr>`).join('') || '<tr><td colspan="2">No data yet.</td></tr>'}</table>
  <p class="note">This summary describes activity already logged in Meco. It is not a screening tool, does not diagnose any condition, and should not be used as a substitute for professional clinical assessment.<br>Printed from Meco on ${escapeHtml(new Date().toLocaleDateString())}.</p>
</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

function buildMemoryGraph() {
  const byId = (arr) => new Map((arr || []).map((item) => [item.id, item]));
  const visitorsById = byId(state.visitors);
  const placesById = byId(state.places);
  const sessionsById = byId(state.sessions);
  const journalById = byId(state.journalEntries);

  const memories = (state.memories || []).map((memory) => ({
    ...memory,
    people: (memory.peopleIds || []).map((id) => visitorsById.get(id)).filter(Boolean),
    place: memory.placeId ? placesById.get(memory.placeId) || null : null,
    session: memory.sessionId ? sessionsById.get(memory.sessionId) || null : null,
    journalEntry: memory.journalEntryId ? journalById.get(memory.journalEntryId) || null : null,
  })).sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

  const memoriesForPerson = (visitorId) => memories.filter((m) => (m.peopleIds || []).includes(visitorId));
  const sessionsForPerson = (visitorId) => (state.sessions || [])
    .filter((s) => s.visitorId === visitorId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const memoriesForPlace = (placeId) => memories.filter((m) => m.placeId === placeId);

  return { memories, memoriesForPerson, sessionsForPerson, memoriesForPlace, visitorsById, placesById, sessionsById };
}

function whyKnowThisPerson(visitor) {
  const graph = buildMemoryGraph();
  const sessions = graph.sessionsForPerson(visitor.id);
  const memories = graph.memoriesForPerson(visitor.id);
  const parts = [`${escapeHtml(visitor.relationship || 'Known to you')}.`];
  if (sessions.length) parts.push(`You last met on ${escapeHtml(formatDate(sessions[0].startedAt))}.`);
  if (memories.length) parts.push(`Shared memory: “${escapeHtml(memories[0].title)}.”`);
  return parts.join(' ');
}

function contentTabsMarkup(tabs, activeKey) {
  return `<div class="content-tabs" role="tablist">${tabs.map((t) => `<button type="button" class="content-tab-btn${t.key === activeKey ? ' active' : ''}" data-content-tab="${t.key}" role="tab" aria-selected="${t.key === activeKey}">${t.label}</button>`).join('')}</div>`;
}

function wireContentTabs(content, onSwitch) {
  content.querySelectorAll('[data-content-tab]').forEach((btn) => {
    btn.onclick = () => onSwitch(btn.dataset.contentTab);
  });
}

function confidenceBadgeMarkup(confidence) {
  const meta = {
    fact: { label: 'Fact', cls: 'confidence-fact' },
    'family-provided': { label: 'From family', cls: 'confidence-family' },
    'ai-inferred': { label: 'AI inference', cls: 'confidence-ai' },
    'insufficient-evidence': { label: 'Not enough evidence', cls: 'confidence-unknown' },
  }[confidence] || { label: 'Unverified', cls: 'confidence-unknown' };
  return `<span class="badge confidence-badge ${meta.cls}">${meta.label}</span>`;
}

let memoryGraphActiveTab = 'timeline';
let memoryDetailId = null;

let memoryCandidatesCache = [];

function renderMemoryGraphPage(content) {
  if (memoryDetailId) {
    const memory = (state.memories || []).find((m) => m.id === memoryDetailId);
    if (memory) {
      content.innerHTML = `${pageHead('Memory', 'A connected view of the people, places and moments Meco already knows about.')}<div id="memory-graph-panel"></div>`;
      renderMemoryDetail(content.querySelector('#memory-graph-panel'), memory);
      return;
    }
    memoryDetailId = null;
  }
  content.innerHTML = `${pageHead('Memory', 'A connected view of the people, places and moments Meco already knows about.')}
    ${contentTabsMarkup([{ key: 'timeline', label: '⏱ Timeline' }, { key: 'recall', label: '⌕ Recall' }], memoryGraphActiveTab)}
    <div id="memory-graph-panel"></div>`;
  wireContentTabs(content, (key) => { memoryGraphActiveTab = key; renderMemoryGraphPage(content); });
  const panel = content.querySelector('#memory-graph-panel');
  if (memoryGraphActiveTab === 'recall') renderRecallPanel(panel);
  else renderTimelinePanel(panel);
}

function timelineEntries() {
  const graph = buildMemoryGraph();
  const entries = [];
  (state.sessions || []).forEach((s) => entries.push({ kind: 'session', at: s.startedAt, title: `Visit with ${s.visitorName || 'a visitor'}`, sub: s.summary?.emotionalTone || 'Recorded visit', id: s.id }));
  (state.journalEntries || []).forEach((j) => entries.push({ kind: 'journal', at: j.createdAt, title: journalEntryTitle(j) || 'Journal entry', sub: (j.text || '').slice(0, 90), id: j.id }));
  graph.memories.forEach((m) => entries.push({ kind: 'memory', at: m.date || m.createdAt, title: m.title, sub: m.summary, id: m.id, confidence: m.confidence }));
  return entries.filter((e) => e.at).sort((a, b) => new Date(b.at) - new Date(a.at));
}

function timelineRowMarkup(entry) {
  const icon = { session: '≋', journal: '✎', memory: '⏱' }[entry.kind] || '•';
  return `<div class="timeline-row" data-timeline-entry="${escapeHtml(entry.kind)}:${escapeHtml(entry.id)}" role="button" tabindex="0">
    <span class="timeline-row-icon kind-${escapeHtml(entry.kind)}">${icon}</span>
    <div class="timeline-row-copy"><b>${escapeHtml(entry.title)}</b><small>${escapeHtml(formatDate(entry.at))}${entry.sub ? ` · ${escapeHtml(entry.sub.slice(0, 90))}` : ''}</small></div>
    ${entry.confidence ? confidenceBadgeMarkup(entry.confidence) : ''}
  </div>`;
}

function renderTimelinePanel(panel) {
  const entries = timelineEntries();
  panel.innerHTML = `<article class="app-card section-card">
    <div class="card-head"><h2>Life timeline</h2><span class="badge">${entries.length}</span></div>
    ${entries.length ? `<div class="timeline-list">${entries.map(timelineRowMarkup).join('')}</div>` : `<div class="empty-state"><div><h3>Nothing on the timeline yet</h3><p>Record a visit, write a journal entry, or save a memory from a visit report, they'll all show up here in order.</p></div></div>`}
  </article>`;
  panel.querySelectorAll('[data-timeline-entry]').forEach((row) => {
    row.onclick = () => {
      const [kind, id] = row.dataset.timelineEntry.split(':');
      if (kind === 'memory') openMemoryDetail(id);
      else if (kind === 'session') openSessionDetail(id);
      else if (kind === 'journal') { journalView = { mode: 'detail', id }; navigateApp('journal'); }
    };
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); } };
  });
}

function openMemoryDetail(id) {
  const memory = (state.memories || []).find((m) => m.id === id);
  if (!memory) return;
  memoryDetailId = id;
  navigateApp('graph');
}

function memoryDetailMarkup(memory) {
  const graph = buildMemoryGraph();
  const peopleOptions = state.visitors.map((v) => `<option value="${escapeHtml(v.id)}" ${(memory.peopleIds || []).includes(v.id) ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('');
  return `<article class="app-card section-card memory-detail-card">
    <div class="card-head">
      <h2>${escapeHtml(memory.title)}</h2>
      <div class="row-icon-actions">${confidenceBadgeMarkup(memory.confidence)}<button class="icon-button" id="close-memory-detail" title="Back to timeline">✕</button></div>
    </div>
    ${(memory.photoDataUrls || []).length ? `<div class="memory-photo-row">${memory.photoDataUrls.map((src) => `<img src="${src}" alt="">`).join('')}</div>` : ''}
    ${memory.voiceClipDataUrl ? `<div class="memory-voice-note"><b>A voice message, not a synthesized one</b><audio controls src="${memory.voiceClipDataUrl}"></audio></div>` : ''}
    <div class="form-grid">
      <div class="form-field full"><label>Title</label><input id="memory-title" value="${escapeHtml(memory.title)}"></div>
      <div class="form-field full"><label>Summary</label><textarea id="memory-summary" rows="2">${escapeHtml(memory.summary || '')}</textarea></div>
      <div class="form-field full"><label>Details</label><textarea id="memory-details" rows="4">${escapeHtml(memory.details || '')}</textarea></div>
      <div class="form-field"><label>Date</label><input id="memory-date" type="date" value="${escapeHtml((memory.date || '').slice(0, 10))}"></div>
      <div class="form-field"><label>Tags (comma separated)</label><input id="memory-tags" value="${escapeHtml((memory.tags || []).join(', '))}"></div>
      <div class="form-field"><label>Place</label><select id="memory-place"><option value="">None</option>${(state.places || []).map((p) => `<option value="${escapeHtml(p.id)}" ${memory.placeId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
      <div class="form-field full"><label>People in this memory</label><select id="memory-people" multiple size="4">${peopleOptions}</select></div>
    </div>
    <p class="memory-source-note">Source: ${escapeHtml(memory.source || 'manual')}${memory.session ? ` · from a visit with ${escapeHtml(memory.session.visitorName || 'a visitor')}` : ''}${memory.place ? ` · at ${escapeHtml(memory.place.name)}` : ''}${memory.contributorName ? ` · contributed by ${escapeHtml(memory.contributorName)}${memory.contributorRelation ? ` (${escapeHtml(memory.contributorRelation)})` : ''}` : ''}</p>
    <div class="action-row" style="margin-top:14px">
      <button class="action-button primary" id="save-memory-detail">Save changes</button>
      <button class="action-button danger" id="delete-memory-detail">Delete memory</button>
    </div>
  </article>`;
}

function renderMemoryDetail(panel, memory) {
  panel.innerHTML = memoryDetailMarkup(memory);
  panel.querySelector('#close-memory-detail').onclick = () => { memoryDetailId = null; renderMemoryGraphPage($('#app-content')); };
  panel.querySelector('#save-memory-detail').onclick = async () => {
    memory.title = $('#memory-title').value.trim().slice(0, 80) || memory.title;
    memory.summary = $('#memory-summary').value.trim().slice(0, 240);
    memory.details = $('#memory-details').value.trim().slice(0, 800);
    memory.date = $('#memory-date').value || memory.date;
    memory.tags = $('#memory-tags').value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 6);
    memory.placeId = $('#memory-place').value || null;
    memory.peopleIds = [...$('#memory-people').selectedOptions].map((opt) => opt.value);
    memory.updatedAt = new Date().toISOString();
    await persistState(true);
    memoryDetailId = null;
    renderMemoryGraphPage($('#app-content'));
  };
  panel.querySelector('#delete-memory-detail').onclick = async () => {
    if (!confirm(`Delete "${memory.title}"? This cannot be undone.`)) return;
    state.memories = state.memories.filter((m) => m.id !== memory.id);
    await persistState(true);
    memoryDetailId = null;
    renderMemoryGraphPage($('#app-content'));
  };
}

function recallMemoryDigest() {
  const graph = buildMemoryGraph();
  return graph.memories.map((m) => ({
    id: m.id,
    title: m.title,
    summary: m.summary,
    tags: m.tags || [],
    date: m.date,
    peopleNames: (m.people || []).map((p) => p.name),
    placeName: m.place?.name || null,
    confidence: m.confidence,
  }));
}

function recallResultMarkup(result, memoriesById) {
  const matchCards = (result.matches || []).map((match) => {
    const memory = memoriesById.get(match.memoryId);
    if (!memory) return '';
    return `<div class="recall-match-card" data-open-memory="${escapeHtml(memory.id)}" role="button" tabindex="0">
      <b>${escapeHtml(memory.title)}</b>
      <p>${escapeHtml(memory.summary || '')}</p>
      <small>${escapeHtml(match.why)}</small>
    </div>`;
  }).join('');
  return `<div class="recall-result">
    <div class="recall-answer">${confidenceBadgeMarkup(result.confidence)}<p>${escapeHtml(result.answer)}</p></div>
    ${matchCards ? `<div class="recall-matches">${matchCards}</div>` : ''}
    <small class="recall-provider">Answered by ${escapeHtml(result.provider || 'Meco')}</small>
  </div>`;
}

function renderRecallPanel(panel) {
  panel.innerHTML = `<article class="app-card section-card">
    <div class="card-head"><h2>Ask Meco to recall something</h2></div>
    <p class="calming-hint">Describe an incomplete memory (a person, a place, a feeling) and Meco will search what's already been saved and show its confidence, never a guess presented as fact.</p>
    <div class="recall-search-row"><input id="recall-query" type="text" placeholder="e.g. I remember going somewhere with Maya where we ate pasta. Where was it?" maxlength="300"><button id="recall-submit" class="action-button primary">Ask</button></div>
    <div id="recall-output"></div>
  </article>`;
  const input = panel.querySelector('#recall-query');
  const output = panel.querySelector('#recall-output');
  const run = async () => {
    const query = input.value.trim();
    if (!query) return;
    output.innerHTML = `<div class="empty-state"><p>Searching saved memories…</p></div>`;
    try {
      const memories = recallMemoryDigest();
      const result = await apiFetch('/api/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, memories }),
      });
      const memoriesById = new Map((state.memories || []).map((m) => [m.id, m]));
      output.innerHTML = recallResultMarkup(result, memoriesById);
      output.querySelectorAll('[data-open-memory]').forEach((card) => {
        card.onclick = () => openMemoryDetail(card.dataset.openMemory);
        card.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } };
      });
    } catch (error) {
      output.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    }
  };
  panel.querySelector('#recall-submit').onclick = run;
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });
}

let activitiesActiveTab = 'stimulation';

function renderActivitiesPage(content) {
  content.innerHTML = `${pageHead('Activities', 'Supportive exercises and reminiscence, not a treatment or diagnosis.')}
    ${contentTabsMarkup([{ key: 'stimulation', label: '✳ Stimulation' }, { key: 'reminiscence', label: '❖ Reminiscence' }, { key: 'practice', label: '↻ Practice' }], activitiesActiveTab)}
    <div id="activities-panel"></div>
    <p class="activities-disclaimer">A supportive activity, not a medical treatment or diagnosis.</p>`;
  wireContentTabs(content, (key) => { activitiesActiveTab = key; renderActivitiesPage(content); });
  const panel = content.querySelector('#activities-panel');
  if (activitiesActiveTab === 'reminiscence') renderReminiscencePanel(panel);
  else if (activitiesActiveTab === 'practice') renderPracticePanel(panel);
  else renderStimulationPanel(panel);
}

function nextReview(item, success) {
  let easeFactor = Number(item.easeFactor) || 2.0;
  let intervalDays = Number(item.intervalDays) || 1;
  let cueLevel = Number.isFinite(item.cueLevel) ? item.cueLevel : 5;
  if (success) {
    easeFactor = Math.min(3.0, easeFactor + 0.1);
    intervalDays = Math.max(1, Math.round(intervalDays * easeFactor));
    cueLevel = Math.max(0, cueLevel - 1);
  } else {
    easeFactor = Math.max(1.3, easeFactor - 0.3);
    intervalDays = Math.max(1, Math.round(intervalDays * 0.5));
    cueLevel = Math.min(5, cueLevel + 1);
  }
  return { ...item, easeFactor, intervalDays, cueLevel, dueAt: new Date(Date.now() + intervalDays * 86400000).toISOString() };
}

function maskAnswer(answer) {
  return String(answer || '').split(' ').map((word) => {
    if (word.length <= 2) return word;
    return `${word[0]}${'_'.repeat(word.length - 2)}${word[word.length - 1]}`;
  }).join(' ');
}

let retrievalFormOpen = false;
let practiceCurrentItem = null;
let practiceIgnoreSchedule = false;

function duePracticeItems(ignoreSchedule) {
  const items = state.retrievalItems || [];
  const now = Date.now();
  return items.filter((item) => ignoreSchedule || new Date(item.dueAt || 0).getTime() <= now);
}

function renderPracticePanel(panel) {
  const items = state.retrievalItems || [];
  if (retrievalFormOpen) {
    panel.innerHTML = retrievalItemFormMarkup();
    wireRetrievalItemForm(panel);
    return;
  }
  if (!items.length) {
    panel.innerHTML = `<article class="app-card section-card">
      <div class="empty-state"><div><h3>Nothing to practice yet</h3><p>Add a fact worth remembering (a name, a routine, where something lives) and Meco will space out practice over time.</p><button class="action-button primary" id="add-retrieval-item">Add something to practice</button></div></div>
    </article>`;
    panel.querySelector('#add-retrieval-item').onclick = () => { retrievalFormOpen = true; renderPracticePanel(panel); };
    return;
  }
  const due = duePracticeItems(practiceIgnoreSchedule);
  if (!practiceCurrentItem || !due.some((i) => i.id === practiceCurrentItem.id)) {
    practiceCurrentItem = due[0] || null;
  }
  if (!practiceCurrentItem) {
    const soonest = items.slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0];
    panel.innerHTML = `<article class="app-card section-card">
      <div class="card-head"><h2>Practice</h2><button class="action-button" id="add-retrieval-item">+ Add something</button></div>
      <div class="empty-state"><div><h3>All caught up</h3><p>${soonest ? `Next review: ${escapeHtml(formatDate(soonest.dueAt))}.` : ''}</p><button class="action-button" id="practice-anyway">Practice anyway</button></div></div>
    </article>`;
    panel.querySelector('#add-retrieval-item').onclick = () => { retrievalFormOpen = true; renderPracticePanel(panel); };
    panel.querySelector('#practice-anyway').onclick = () => { practiceIgnoreSchedule = true; practiceCurrentItem = null; renderPracticePanel(panel); };
    return;
  }
  renderPracticeItem(panel, due.length);
}

function retrievalItemFormMarkup() {
  const peopleOptions = state.visitors.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`).join('');
  return `<article class="app-card section-card">
    <div class="card-head"><h2>Add something to practice</h2><button class="icon-button" id="close-retrieval-form" title="Close">✕</button></div>
    <div class="form-grid">
      <div class="form-field full"><label>Question</label><input id="ri-prompt" maxlength="140" placeholder="e.g. Who is your caregiver?"></div>
      <div class="form-field full"><label>Answer</label><input id="ri-answer" maxlength="80" placeholder="e.g. Anna"></div>
      <div class="form-field"><label>Category</label><input id="ri-category" maxlength="40" placeholder="e.g. person, routine, place"></div>
      <div class="form-field"><label>Linked person (optional)</label><select id="ri-visitor"><option value="">None</option>${peopleOptions}</select></div>
      <div class="form-field full"><label>Context sentence (optional, used as a gentler hint)</label><input id="ri-context" maxlength="200" placeholder="e.g. She visits every Tuesday morning."></div>
    </div>
    <div class="action-row" style="margin-top:14px"><button class="action-button primary" id="save-retrieval-item">Add</button></div>
  </article>`;
}

function wireRetrievalItemForm(panel) {
  panel.querySelector('#close-retrieval-form').onclick = () => { retrievalFormOpen = false; renderPracticePanel(panel); };
  panel.querySelector('#save-retrieval-item').onclick = async () => {
    const prompt = panel.querySelector('#ri-prompt').value.trim();
    const answer = panel.querySelector('#ri-answer').value.trim();
    if (!prompt || !answer) return toast('A question and an answer are both needed.', 'error');
    const item = {
      id: crypto.randomUUID(),
      prompt: prompt.slice(0, 140),
      answer: answer.slice(0, 80),
      category: panel.querySelector('#ri-category').value.trim().slice(0, 40) || 'general',
      contextHint: panel.querySelector('#ri-context').value.trim().slice(0, 200),
      linkedVisitorId: panel.querySelector('#ri-visitor').value || null,
      easeFactor: 2.0, intervalDays: 1, cueLevel: 5,
      dueAt: new Date().toISOString(),
      createdBy: 'caregiver', createdAt: new Date().toISOString(),
    };
    state.retrievalItems = [item, ...(state.retrievalItems || [])].slice(0, 200);
    await persistState(true);
    retrievalFormOpen = false;
    renderPracticePanel(panel);
  };
}

function cueMarkup(item) {
  const level = item.cueLevel;
  if (level >= 5) return { cue: `<p class="cue-box cue-full"><b>Answer:</b> ${escapeHtml(item.answer)}</p>`, needsInput: false };
  if (level === 4) return { cue: `<p class="cue-box cue-context">${escapeHtml(item.contextHint || `Think about ${item.category}.`)}</p>`, needsInput: true };
  if (level === 3) {
    const visitor = item.linkedVisitorId ? state.visitors.find((v) => v.id === item.linkedVisitorId) : null;
    if (visitor) return { cue: `<div class="cue-box cue-person"><div class="person-avatar">${visitor.thumbnail ? `<img src="${visitor.thumbnail}" alt="">` : escapeHtml(visitor.name[0] || '?')}</div><span>${escapeHtml(visitor.name)}</span></div>`, needsInput: true };
    return { cue: `<p class="cue-box cue-category">A ${escapeHtml(item.category)}.</p>`, needsInput: true };
  }
  if (level === 2) return { cue: `<p class="cue-box cue-partial">${escapeHtml(maskAnswer(item.answer))}</p>`, needsInput: true };
  if (level === 1) return { cue: `<p class="cue-box cue-soft">This is about ${escapeHtml(item.category)}.</p>`, needsInput: true };
  return { cue: '', needsInput: true };
}

function renderPracticeItem(panel, dueCount) {
  const item = practiceCurrentItem;
  const { cue, needsInput } = cueMarkup(item);
  panel.innerHTML = `<article class="app-card section-card">
    <div class="card-head"><h2>Practice</h2><span class="badge">${dueCount} due</span></div>
    <p class="stim-prompt">${escapeHtml(item.prompt)}</p>
    ${cue}
    ${needsInput ? `<div class="stim-freeform"><input id="ri-answer-input" type="text" placeholder="Your answer"><button class="action-button primary" id="ri-submit">Check</button></div>` : `<button class="action-button primary" id="ri-acknowledge">I've got it</button>`}
    <div id="ri-feedback"></div>
    <div class="action-row" style="margin-top:14px"><button class="action-button" id="ri-more-help" ${item.cueLevel >= 5 ? 'disabled' : ''}>More help</button></div>
  </article>`;
  panel.querySelector('#ri-submit')?.addEventListener('click', () => answerPractice(panel, panel.querySelector('#ri-answer-input').value));
  panel.querySelector('#ri-answer-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') answerPractice(panel, panel.querySelector('#ri-answer-input').value); });
  panel.querySelector('#ri-acknowledge')?.addEventListener('click', () => answerPractice(panel, item.answer));
  panel.querySelector('#ri-more-help').onclick = () => {
    const bumped = { ...item, cueLevel: Math.min(5, item.cueLevel + 1) };
    state.retrievalItems = state.retrievalItems.map((i) => i.id === item.id ? bumped : i);
    practiceCurrentItem = bumped;
    renderPracticeItem(panel, dueCount);
  };
}

async function answerPractice(panel, given) {
  const item = practiceCurrentItem;
  const success = String(given || '').trim().toLowerCase() === String(item.answer || '').trim().toLowerCase();
  const updated = nextReview(item, success);
  state.retrievalItems = (state.retrievalItems || []).map((i) => i.id === item.id ? updated : i);
  const attempt = { id: crypto.randomUUID(), itemId: item.id, at: new Date().toISOString(), success, cueLevelUsed: item.cueLevel, latencyMs: 0 };
  state.retrievalAttempts = [attempt, ...(state.retrievalAttempts || [])].slice(0, 1000);
  await persistState(false);
  const feedback = panel.querySelector('#ri-feedback');
  feedback.innerHTML = success
    ? `<p class="stim-feedback-ok">Well remembered.</p>`
    : `<p class="stim-feedback-gentle">The answer was "${escapeHtml(item.answer)}", you'll see this one again sooner, with a bit more help.</p>`;
  panel.querySelectorAll('button, input').forEach((el) => el.disabled = true);
  practiceCurrentItem = null;
  setTimeout(() => renderPracticePanel(panel), 1800);
}

const STIMULATION_WORD_BANK = [
  { word: 'Happy', category: 'a feeling', decoys: ['Chair', 'Rain', 'Green'] },
  { word: 'Apple', category: 'a fruit', decoys: ['Hammer', 'Cloud', 'Guitar'] },
  { word: 'Dog', category: 'an animal', decoys: ['Spoon', 'Window', 'Thursday'] },
  { word: 'Blue', category: 'a colour', decoys: ['Bicycle', 'Kettle', 'Onion'] },
  { word: 'Kind', category: 'a way to describe someone', decoys: ['Table', 'Rainy', 'Twelve'] },
  { word: 'Kitchen', category: 'a room in a house', decoys: ['Elephant', 'Wednesday', 'Purple'] },
  { word: 'Joyful', category: 'a word close in meaning to "happy"', decoys: ['Tired', 'Square', 'Lamp'] },
  { word: 'Umbrella', category: 'something you use when it rains', decoys: ['Toaster', 'Feeling', 'Melody'] },
];
const STIMULATION_OBJECT_BANK = [
  { name: 'Kettle', use: 'boiling water for tea' }, { name: 'Umbrella', use: 'staying dry in the rain' },
  { name: 'Comb', use: 'tidying your hair' }, { name: 'Torch', use: 'seeing in the dark' },
  { name: 'Scissors', use: 'cutting paper' }, { name: 'Envelope', use: 'posting a letter' },
];
const shuffled = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

function buildStimulationExercise(activityType, level) {
  const graph = buildMemoryGraph();
  const visitors = state.visitors || [];
  const memories = graph.memories;
  const objects = state.objects || [];

  if (activityType === 'orientation') {
    const now = new Date();
    if (level <= 2) {
      const correct = now.toLocaleDateString(undefined, { weekday: 'long' });
      const others = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].filter((d) => d !== correct);
      return { prompt: 'What day of the week is it today?', kind: 'multiple-choice', options: shuffled([correct, ...shuffled(others).slice(0, 3)]), correctAnswer: correct, hint: `It's somewhere in the middle of the week, or is it the weekend? Today is ${correct}.` };
    }
    if (level <= 4) {
      const correct = now.toLocaleDateString(undefined, { month: 'long' });
      return { prompt: 'What month is it right now?', kind: 'free-text', correctAnswer: correct, hint: `The season might help, today falls in ${correct}.` };
    }
    const correct = now.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    return { prompt: "What is today's date (day and month)?", kind: 'free-text', correctAnswer: correct, hint: `Today is ${correct}.` };
  }

  if (activityType === 'autobiographical') {
    const withRelationship = visitors.filter((v) => v.relationship);
    if (withRelationship.length >= (level <= 2 ? 1 : 3)) {
      const pick = withRelationship[Math.floor(Math.random() * withRelationship.length)];
      const decoyPool = withRelationship.filter((v) => v.relationship !== pick.relationship).map((v) => v.relationship);
      const options = shuffled([pick.relationship, ...shuffled([...new Set(decoyPool)]).slice(0, level <= 2 ? 1 : 3)]);
      return { prompt: `How is ${pick.name} related to you?`, kind: 'multiple-choice', options, correctAnswer: pick.relationship, hint: `${pick.name} is your ${pick.relationship}.` };
    }
    return { prompt: 'What is your own name?', kind: 'free-text', correctAnswer: state.settings.patientName || '', hint: `Your name is ${state.settings.patientName || 'saved in Settings'}.` };
  }

  if (activityType === 'categorisation') {
    const knownPeople = visitors.map((v) => v.name);
    const knownPlaces = (state.places || []).map((p) => p.name);
    const askPeople = knownPeople.length >= 1 && (knownPlaces.length < 1 || Math.random() < 0.5);
    const pool = askPeople ? knownPeople : knownPlaces;
    if (pool.length) {
      const correct = pool[Math.floor(Math.random() * pool.length)];
      const decoys = ['Bicycle', 'Umbrella', 'Kettle', 'Thursday', 'Piano', 'Volcano'];
      const options = shuffled([correct, ...shuffled(decoys).slice(0, level <= 2 ? 2 : 3)]);
      return { prompt: `Which of these is ${askPeople ? 'someone you know' : 'a place you know'}?`, kind: 'multiple-choice', options, correctAnswer: correct, hint: `${correct} is ${askPeople ? 'someone in your trusted people list' : 'one of your saved places'}.` };
    }
    const bank = STIMULATION_WORD_BANK[Math.floor(Math.random() * STIMULATION_WORD_BANK.length)];
    const options = shuffled([bank.word, ...shuffled(bank.decoys).slice(0, level <= 2 ? 2 : 3)]);
    return { prompt: `Which of these is ${bank.category}?`, kind: 'multiple-choice', options, correctAnswer: bank.word, hint: `${bank.word} is ${bank.category}.` };
  }

  if (activityType === 'familiar-objects') {
    if (objects.length) {
      const object = objects[Math.floor(Math.random() * objects.length)];
      return { prompt: `Where was "${object.name}" last seen?`, kind: 'free-text', correctAnswer: object.lastObservedNote || '', hint: object.lastObservedNote ? `It was last noted: ${object.lastObservedNote}.` : "That one hasn't been logged yet: a caregiver can note it in Settings." };
    }
    const item = STIMULATION_OBJECT_BANK[Math.floor(Math.random() * STIMULATION_OBJECT_BANK.length)];
    return { prompt: `What would you use for ${item.use}?`, kind: 'free-text', correctAnswer: item.name, hint: `It's a ${item.name.toLowerCase()}.` };
  }

  if (activityType === 'language') {
    const bank = STIMULATION_WORD_BANK[Math.floor(Math.random() * STIMULATION_WORD_BANK.length)];
    const options = shuffled([bank.word, ...shuffled(bank.decoys).slice(0, level <= 2 ? 2 : 3)]);
    return { prompt: `Which word is ${bank.category}?`, kind: 'multiple-choice', options, correctAnswer: bank.word, hint: `${bank.word}, ${bank.category}.` };
  }

  if (level <= 2) {
    const a = 1 + Math.floor(Math.random() * 5), b = 1 + Math.floor(Math.random() * 4);
    return { prompt: `What is ${a} + ${b}?`, kind: 'number', correctAnswer: String(a + b), hint: `Count up from ${a}, ${b} more times.` };
  }
  if (level <= 4) {
    const a = 5 + Math.floor(Math.random() * 10), b = 1 + Math.floor(Math.random() * 9);
    return { prompt: `What is ${a} - ${b}?`, kind: 'number', correctAnswer: String(a - b), hint: `Count back from ${a}, ${b} times.` };
  }
  const start = 2 + Math.floor(Math.random() * 3), step = 2 + Math.floor(Math.random() * 3);
  const seq = [start, start + step, start + step * 2];
  return { prompt: `What comes next? ${seq.join(', ')}, __`, kind: 'number', correctAnswer: String(start + step * 3), hint: `Each number goes up by ${step}.` };
}

const STIMULATION_ACTIVITY_LABEL = { language: 'Language', categorisation: 'Categorisation', numbers: 'Numbers', 'familiar-objects': 'Familiar objects', orientation: 'Orientation', autobiographical: 'About you' };
let stimulationCurrent = null;
let stimulationHintShown = false;

function nextStimulationExercise(panel) {
  const level = Number(state.settings.stimulationLevel) || 2;
  const types = Object.keys(STIMULATION_ACTIVITY_LABEL);
  const activityType = types[Math.floor(Math.random() * types.length)];
  stimulationCurrent = { activityType, level, startedAt: Date.now(), ...buildStimulationExercise(activityType, level) };
  stimulationHintShown = false;
  renderStimulationExercise(panel);
}

function renderStimulationExercise(panel) {
  const ex = stimulationCurrent;
  const answerField = ex.kind === 'multiple-choice'
    ? `<div class="stim-options">${ex.options.map((opt) => `<button type="button" class="stim-option" data-stim-option="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`).join('')}</div>`
    : `<div class="stim-freeform"><input id="stim-answer" type="${ex.kind === 'number' ? 'number' : 'text'}" placeholder="Your answer"><button class="action-button primary" id="stim-submit">Check</button></div>`;
  panel.innerHTML = `<article class="app-card section-card">
    <div class="card-head"><h2>${escapeHtml(STIMULATION_ACTIVITY_LABEL[ex.activityType])}</h2><span class="badge">Level ${ex.level}</span></div>
    <p class="stim-prompt">${escapeHtml(ex.prompt)}</p>
    ${answerField}
    <div id="stim-feedback"></div>
    <div class="action-row" style="margin-top:14px"><button class="action-button" id="stim-hint">Need a hint?</button><button class="action-button" id="stim-skip">Skip</button></div>
  </article>`;
  panel.querySelectorAll('[data-stim-option]').forEach((button) => button.onclick = () => answerStimulation(panel, button.dataset.stimOption));
  panel.querySelector('#stim-submit')?.addEventListener('click', () => answerStimulation(panel, panel.querySelector('#stim-answer').value));
  panel.querySelector('#stim-answer')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') answerStimulation(panel, panel.querySelector('#stim-answer').value); });
  panel.querySelector('#stim-hint').onclick = () => { stimulationHintShown = true; panel.querySelector('#stim-feedback').innerHTML = `<p class="stim-hint-text">${escapeHtml(ex.hint)}</p>`; };
  panel.querySelector('#stim-skip').onclick = () => nextStimulationExercise(panel);
}

async function answerStimulation(panel, given) {
  const ex = stimulationCurrent;
  const normalize = (v) => String(v || '').trim().toLowerCase();
  const correct = normalize(given) === normalize(ex.correctAnswer) || (ex.kind === 'number' && Number(given) === Number(ex.correctAnswer));
  const attempt = { id: crypto.randomUUID(), activityType: ex.activityType, at: new Date().toISOString(), correct, latencyMs: Date.now() - ex.startedAt, hintsUsed: stimulationHintShown };
  state.cognitiveAttempts = [attempt, ...(state.cognitiveAttempts || [])].slice(0, 500);

  const recent = state.cognitiveAttempts.slice(0, 3);
  const level = Number(state.settings.stimulationLevel) || 2;
  if (recent.length === 3 && recent.every((a) => a.correct && !a.hintsUsed)) state.settings.stimulationLevel = Math.min(5, level + 1);
  else if (recent.length >= 2 && recent.slice(0, 2).every((a) => !a.correct)) state.settings.stimulationLevel = Math.max(1, level - 1);
  await persistState(false);
  const feedback = panel.querySelector('#stim-feedback');
  feedback.innerHTML = correct
    ? `<p class="stim-feedback-ok">That's right${stimulationHintShown ? ', nicely worked out with the hint' : ''}.</p>`
    : `<p class="stim-feedback-gentle">Not quite: the answer was "${escapeHtml(String(ex.correctAnswer))}". No pressure, on to the next one.</p>`;
  panel.querySelectorAll('button, input').forEach((el) => { if (el.id !== 'stim-hint') el.disabled = true; });
  setTimeout(() => nextStimulationExercise(panel), 1800);
}

function renderStimulationPanel(panel) {
  nextStimulationExercise(panel);
}

let reminiscenceCollectionId = null;
let reminiscenceIndex = 0;

function reminiscenceSourceMemories(collection) {
  const graph = buildMemoryGraph();
  if (!collection) return graph.memories;
  const ids = new Set(collection.memoryIds || []);
  return graph.memories.filter((m) => ids.has(m.id));
}

function renderReminiscencePanel(panel) {
  const collections = state.reminiscenceCollections || [];
  const activeCollection = collections.find((c) => c.id === reminiscenceCollectionId) || null;
  const items = reminiscenceSourceMemories(activeCollection);
  const current = items[reminiscenceIndex] || null;
  panel.innerHTML = `<article class="app-card section-card">
    <div class="card-head"><h2>Reminiscence</h2><button class="action-button" id="reminiscence-manage">Manage collections</button></div>
    ${collections.length ? `<div class="content-tabs" style="margin-bottom:18px">
      <button type="button" class="content-tab-btn${!activeCollection ? ' active' : ''}" data-reminiscence-collection="">All memories</button>
      ${collections.map((c) => `<button type="button" class="content-tab-btn${activeCollection?.id === c.id ? ' active' : ''}" data-reminiscence-collection="${escapeHtml(c.id)}">${escapeHtml(c.title)}</button>`).join('')}
    </div>` : ''}
    ${current ? reminiscenceCardMarkup(current, items.length) : `<div class="empty-state"><div><h3>Nothing to reminisce over yet</h3><p>Save a memory from a visit report, or add a family contribution, and it will appear here.</p></div></div>`}
  </article>
  <div id="reminiscence-manager" class="hidden"></div>`;
  panel.querySelectorAll('[data-reminiscence-collection]').forEach((button) => button.onclick = () => {
    reminiscenceCollectionId = button.dataset.reminiscenceCollection || null;
    reminiscenceIndex = 0;
    renderReminiscencePanel(panel);
  });
  panel.querySelector('#reminiscence-manage').onclick = () => renderReminiscenceManager(panel);
  wireReminiscenceCard(panel, items);
}

function reminiscenceCardMarkup(memory, total) {
  return `<div class="reminiscence-card">
    ${(memory.photoDataUrls || [])[0] ? `<img src="${memory.photoDataUrls[0]}" alt="" class="reminiscence-photo">` : `<div class="reminiscence-photo reminiscence-photo-empty">${escapeHtml((memory.title || '?')[0])}</div>`}
    <h3>${escapeHtml(memory.title)}</h3>
    <p class="reminiscence-prompt">Tell me about this: what do you remember?</p>
    <p class="reminiscence-summary">${escapeHtml(memory.summary || '')}</p>
    ${memory.voiceClipDataUrl ? `<audio controls src="${memory.voiceClipDataUrl}"></audio>` : ''}
    <div class="action-row" style="margin-top:14px">
      <button class="action-button" id="reminiscence-prev" ${total <= 1 ? 'disabled' : ''}>← Previous</button>
      <span class="reminiscence-count">${total ? `Memory` : ''}</span>
      <button class="action-button" id="reminiscence-next" ${total <= 1 ? 'disabled' : ''}>Next →</button>
      <button class="action-button" id="reminiscence-read">Read aloud</button>
    </div>
  </div>`;
}

function wireReminiscenceCard(panel, items) {
  panel.querySelector('#reminiscence-prev')?.addEventListener('click', () => { reminiscenceIndex = (reminiscenceIndex - 1 + items.length) % items.length; renderReminiscencePanel(panel); });
  panel.querySelector('#reminiscence-next')?.addEventListener('click', () => { reminiscenceIndex = (reminiscenceIndex + 1) % items.length; renderReminiscencePanel(panel); });
  panel.querySelector('#reminiscence-read')?.addEventListener('click', () => {
    const memory = items[reminiscenceIndex];
    if (memory) speakText(`${memory.title}. ${memory.summary || ''}`);
  });
}

function renderReminiscenceManager(panel) {
  const collections = state.reminiscenceCollections || [];
  const graph = buildMemoryGraph();
  const manager = panel.querySelector('#reminiscence-manager');
  manager.classList.remove('hidden');
  manager.innerHTML = `<article class="app-card section-card" style="margin-top:18px">
    <div class="card-head"><h2>Collections</h2><button class="icon-button" id="close-reminiscence-manager" title="Close">✕</button></div>
    <div class="family-link-row"><input id="new-collection-title" type="text" maxlength="60" placeholder="e.g. Childhood, Career, Holidays"><button class="action-button" id="add-collection">+ New collection</button></div>
    ${collections.length ? collections.map((c) => `<div class="object-row" data-collection-id="${escapeHtml(c.id)}">
        <span class="object-row-icon">❖</span>
        <div class="object-row-copy"><b>${escapeHtml(c.title)}</b><small>${(c.memoryIds || []).length} memories</small></div>
        <div class="action-row"><button class="action-button" data-edit-collection="${escapeHtml(c.id)}">Edit</button><button class="icon-button danger" data-delete-collection="${escapeHtml(c.id)}" title="Remove">✕</button></div>
      </div>`).join('') : '<div class="empty-state"><p>No collections yet.</p></div>'}
    <div id="collection-editor"></div>
  </article>`;
  manager.querySelector('#close-reminiscence-manager').onclick = () => manager.classList.add('hidden');
  manager.querySelector('#add-collection').onclick = async () => {
    const title = manager.querySelector('#new-collection-title').value.trim().slice(0, 60);
    if (!title) return;
    state.reminiscenceCollections = [...collections, { id: crypto.randomUUID(), title, memoryIds: [], createdBy: 'caregiver' }];
    await persistState(true);
    renderReminiscencePanel(panel);
    renderReminiscenceManager(panel);
  };
  manager.querySelectorAll('[data-delete-collection]').forEach((button) => button.onclick = async () => {
    if (!confirm('Remove this collection? The memories in it are not deleted.')) return;
    state.reminiscenceCollections = collections.filter((c) => c.id !== button.dataset.deleteCollection);
    if (reminiscenceCollectionId === button.dataset.deleteCollection) reminiscenceCollectionId = null;
    await persistState(true);
    renderReminiscencePanel(panel);
    renderReminiscenceManager(panel);
  });
  manager.querySelectorAll('[data-edit-collection]').forEach((button) => button.onclick = () => {
    const collection = collections.find((c) => c.id === button.dataset.editCollection);
    const editor = manager.querySelector('#collection-editor');
    editor.innerHTML = `<div class="memory-people-chips" style="margin-top:14px">${graph.memories.map((m) => `<button type="button" class="memory-people-chip${(collection.memoryIds || []).includes(m.id) ? ' selected' : ''}" data-toggle-collection-memory="${escapeHtml(m.id)}">${escapeHtml(m.title)}</button>`).join('')}</div>`;
    editor.querySelectorAll('[data-toggle-collection-memory]').forEach((chip) => chip.onclick = async () => {
      const memoryId = chip.dataset.toggleCollectionMemory;
      const set = new Set(collection.memoryIds || []);
      if (set.has(memoryId)) set.delete(memoryId); else set.add(memoryId);
      collection.memoryIds = [...set];

      chip.classList.toggle('selected');
      const row = manager.querySelector(`[data-collection-id="${CSS.escape(collection.id)}"] .object-row-copy small`);
      if (row) row.textContent = `${collection.memoryIds.length} memories`;
      await persistState(false);
    });
  });
}

function insightsTrendSvg(buckets) {
  const width = 640, height = 180, pad = { top: 14, right: 16, bottom: 24, left: 28 };
  const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const xFor = (i) => pad.left + (i / Math.max(1, buckets.length - 1)) * plotW;
  const yFor = (n) => pad.top + plotH - (n / maxCount) * plotH;
  const points = buckets.map((b, i) => ({ x: xFor(i), y: yFor(b.count), b }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const gridLines = [0, maxCount].map((v) => `<line x1="${pad.left}" y1="${yFor(v)}" x2="${width - pad.right}" y2="${yFor(v)}" class="trend-grid" />`).join('');
  const labels = buckets.map((b, i) => (i % Math.ceil(buckets.length / 5) === 0 ? `<text x="${xFor(i)}" y="${height - 6}" class="trend-axis-label" text-anchor="middle">${escapeHtml(b.label)}</text>` : '')).join('');
  const markers = points.map((p, i) => `<circle class="trend-point" cx="${p.x}" cy="${p.y}" r="5" tabindex="0" role="img" aria-label="Week of ${escapeHtml(p.b.label)}: ${p.b.count} visit${p.b.count === 1 ? '' : 's'}"></circle>`).join('');
  return `<div class="trend-chart-wrap"><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Visits per week over the last ${buckets.length} weeks">${gridLines}<path d="${linePath}" class="trend-line" />${markers}${labels}</svg></div>`;
}

let insightsActiveTab = 'visits';

function visitInsightsMarkup() {
  const buckets = weeklyVisitCounts(8);
  const thisWeek = buckets[buckets.length - 1].count;
  const lastWeek = buckets[buckets.length - 2]?.count ?? 0;
  const delta = thisWeek - lastWeek;
  const deltaLabel = delta === 0 ? 'Same as last week' : `${delta > 0 ? '+' : ''}${delta} vs. last week`;
  const tones = toneDistribution();
  const topPeople = topVisitedPeople(5);
  const toneColors = { Warm: '#e59a7c', Calm: '#8bb9e0', Joyful: '#e0c25f', Anxious: '#c98f8f', Quiet: '#a9a49c' };
  return `<div class="app-grid">
      <article class="app-card metric-card blue"><span>Total visits</span><strong>${state.sessions.length}</strong></article>
      <article class="app-card metric-card green"><span>This week</span><strong>${thisWeek}</strong></article>
      <article class="app-card metric-card yellow"><span>Last week</span><strong>${lastWeek}</strong></article>
      <article class="app-card metric-card peach"><span>Trend</span><strong style="font-size:26px">${escapeHtml(deltaLabel)}</strong></article>
      <article class="app-card section-card">
        <div class="card-head"><h2>Visits over time</h2><span class="badge">Last 8 weeks</span></div>
        ${state.sessions.length ? insightsTrendSvg(buckets) : `<div class="empty-state"><div><h3>Nothing to chart yet</h3><p>Recorded visits will build this trend automatically.</p></div></div>`}
      </article>
      <article class="app-card" style="grid-column:span 6">
        <div class="card-head"><h2>Tone, at a glance</h2></div>
        ${tones.length ? `<div class="insight-bars">${tones.map((t) => `<div class="insight-bar-row"><span class="insight-bar-label">${escapeHtml(t.tone)}</span><div class="insight-bar-track"><div class="insight-bar-fill" style="width:${t.pct}%;background:${toneColors[t.tone] || '#b7b2a8'}"></div></div><span class="insight-bar-value">${t.count}</span></div>`).join('')}</div>` : `<div class="empty-state"><p>Generate an AI report on a visit to see tones here.</p></div>`}
      </article>
      <article class="app-card" style="grid-column:span 6">
        <div class="card-head"><h2>Who visits most</h2></div>
        ${topPeople.length ? `<div class="insight-bars">${topPeople.map((p) => `<div class="insight-bar-row"><span class="insight-bar-label">${escapeHtml(p.name)}</span><div class="insight-bar-track"><div class="insight-bar-fill" style="width:${p.pct}%;background:#8fb7f0"></div></div><span class="insight-bar-value">${p.count}</span></div>`).join('')}</div>` : `<div class="empty-state"><p>Recorded visits will rank people here.</p></div>`}
      </article>
      <article class="app-card section-card" style="grid-column:span 12">
        <div class="card-head"><h2>Mood check-ins</h2><span class="badge">${(state.moodCheckIns || []).length}</span></div>
        ${moodCheckInTrendMarkup()}
      </article>
    </div>`;
}

function renderInsights(content) {
  content.innerHTML = `${pageHead('Insights', 'Patterns across the visits already recorded, nothing scored, nothing predicted.')}
    ${contentTabsMarkup([{ key: 'visits', label: '◈ Visits' }, { key: 'cognitive', label: '✳ Cognitive' }], insightsActiveTab)}
    <div id="insights-panel">${insightsActiveTab === 'cognitive' ? renderCognitiveInsightsSection() : visitInsightsMarkup()}</div>`;
  wireContentTabs(content, (key) => { insightsActiveTab = key; renderInsights(content); });
  content.querySelector('#export-cognitive-insights')?.addEventListener('click', exportCognitiveInsightsSummary);
}

function moodCheckInTrendMarkup() {
  const entries = (state.moodCheckIns || []).slice(0, 14);
  if (!entries.length) return `<div class="empty-state"><p>Nothing logged yet, check-ins tapped in Patient mode will appear here.</p></div>`;
  return `<div class="mood-trend-row">${entries.map((entry) => {
    const meta = journalMoods.find((mood) => mood.key === entry.mood) || journalMoods[2];
    return `<div class="mood-trend-chip" title="${escapeHtml(meta.label)} · ${escapeHtml(formatDate(entry.createdAt))}"><span>${meta.glyph}</span><small>${timeAgoShort(entry.createdAt)}</small></div>`;
  }).join('')}</div>`;
}

function careNoteRow(note) {
  return `<div class="care-note-row${note.pinned ? ' pinned' : ''}" data-note-id="${escapeHtml(note.id)}">
    <div class="care-note-row-body">
      ${note.pinned ? '<span class="care-note-pin-flag">Pinned</span>' : ''}
      <p>${escapeHtml(note.text)}</p>
      <small>${escapeHtml(formatDate(note.createdAt))}</small>
    </div>
    <div class="row-icon-actions">
      <button class="icon-button" data-toggle-pin="${escapeHtml(note.id)}" title="${note.pinned ? 'Unpin' : 'Pin to top'}">${note.pinned ? '◆' : '◈'}</button>
      <button class="icon-button danger" data-delete-note="${escapeHtml(note.id)}" title="Delete">✕</button>
    </div>
  </div>`;
}

function renderCareNotes(content) {
  const notes = (state.careNotes || []).slice().sort((a, b) => (b.pinned - a.pinned) || (new Date(b.createdAt) - new Date(a.createdAt)));
  content.innerHTML = `${pageHead('Care Notes', "A shared log for anyone in this care circle, separate from the patient's own Journal.")}
    <div class="app-grid">
      <article class="app-card section-card">
        <div class="form-field full"><label>New note</label><textarea id="new-care-note" rows="3" maxlength="500" placeholder="e.g. Mum seemed tired after lunch today, might be worth a shorter visit Thursday."></textarea></div>
        <div class="action-row" style="margin-top:12px"><button id="save-care-note" class="action-button primary">Add note</button></div>
      </article>
      <article class="app-card section-card">
        <div class="card-head"><h2>Notes</h2><span class="badge">${notes.length}</span></div>
        ${notes.length ? `<div class="care-notes-list">${notes.map(careNoteRow).join('')}</div>` : `<div class="empty-state"><div><h3>No notes yet</h3><p>Anything worth flagging for next time: a mood, a preference, a reminder for whoever visits next.</p></div></div>`}
      </article>
    </div>`;
  $('#save-care-note').onclick = async () => {
    const textarea = $('#new-care-note');
    const text = textarea.value.trim();
    if (!text) return toast('Write something before adding a note.', 'error');
    state.careNotes = [{ id: `note_${Date.now()}`, text: text.slice(0, 500), createdAt: new Date().toISOString(), pinned: false }, ...(state.careNotes || [])];
    textarea.value = '';
    await persistState(true);
    renderCareNotes(content);
  };
  $$('[data-toggle-pin]').forEach((button) => button.onclick = async () => {
    const note = state.careNotes.find((item) => item.id === button.dataset.togglePin);
    if (!note) return;
    note.pinned = !note.pinned;
    await persistState();
    renderCareNotes(content);
  });
  $$('[data-delete-note]').forEach((button) => button.onclick = async () => {
    if (!confirm('Delete this note?')) return;
    state.careNotes = state.careNotes.filter((item) => item.id !== button.dataset.deleteNote);
    await persistState(true);
    renderCareNotes(content);
  });
}

let companionView = { mode: 'list', id: null };

function wellbeingBadgeTone(score) {
  if (score >= 70) return 'success';
  if (score >= 40) return '';
  return 'error';
}

function companionChatRowMarkup(chat) {
  const analysis = chat.analysis;
  const patientTurns = (chat.messages || []).filter((m) => m.role !== 'assistant').length;
  const note = analysis ? analysis.note : 'Not yet reviewed';
  const notePreview = note.length > 80 ? `${note.slice(0, 80).trim()}…` : note;
  return `<div class="companion-row${analysis?.flagged ? ' flagged' : ''}" data-open-companion="${escapeHtml(chat.id)}" role="button" tabindex="0">
    <div class="person-avatar">❖</div>
    <div class="row-copy">
      <b>${escapeHtml(companionChatTitle(chat))}</b>
      <small>${escapeHtml(formatDate(chat.startedAt))} · ${patientTurns} message${patientTurns === 1 ? '' : 's'} · ${escapeHtml(notePreview)}</small>
    </div>
    <div class="row-meta companion-row-meta">
      ${analysis ? `<span class="badge ${wellbeingBadgeTone(analysis.wellbeingScore)}">${analysis.wellbeingScore}/100</span>` : ''}
      ${analysis?.flagged ? '<span class="badge error">✳ Review</span>' : ''}
    </div>
  </div>`;
}

function companionOverviewCardMarkup() {
  const overview = state.companionOverview;
  const reviewedCount = (state.companionChats || []).filter((chat) => chat.analysis).length;
  if (!reviewedCount) return '';
  return `<article class="app-card section-card companion-overview-card">
    <div class="card-head"><h2>Overall wellbeing signal</h2><button class="action-button" id="refresh-companion-overview">↻ Refresh</button></div>
    ${overview ? `<div class="companion-overview-body">
      <div class="score-ring" style="--score:${overview.score}"><strong>${overview.score}</strong></div>
      <div class="companion-overview-copy">
        <b>${escapeHtml(overview.trend)}</b>
        <p>${escapeHtml(overview.summary)}</p>
        <small>Based on ${reviewedCount} reviewed conversation${reviewedCount === 1 ? '' : 's'} · ${escapeHtml(overview.safetyNote)}</small>
      </div>
    </div>` : '<p class="companion-safety-note">Computing an overview…</p>'}
  </article>`;
}

function companionWellbeingSeries() {
  return (state.companionChats || [])
    .filter((chat) => chat.analysis && typeof chat.analysis.wellbeingScore === 'number')
    .slice()
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
}

function companionTrendChartMarkup() {
  const series = companionWellbeingSeries();
  if (series.length < 2) return '';
  const width = 640, height = 200, pad = { top: 16, right: 16, bottom: 12, left: 32 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xFor = (i) => pad.left + (i / (series.length - 1)) * plotW;
  const yFor = (score) => pad.top + plotH - (score / 100) * plotH;
  const points = series.map((chat, i) => ({ x: xFor(i), y: yFor(chat.analysis.wellbeingScore), score: chat.analysis.wellbeingScore }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const gridLines = [0, 25, 50, 75, 100].map((v) => `<line x1="${pad.left}" y1="${yFor(v)}" x2="${width - pad.right}" y2="${yFor(v)}" class="trend-grid" /><text x="${pad.left - 8}" y="${yFor(v) + 3}" class="trend-axis-label" text-anchor="end">${v}</text>`).join('');
  const markers = points.map((p, i) => `<circle class="trend-point" cx="${p.x}" cy="${p.y}" r="5" data-index="${i}" tabindex="0" role="img" aria-label="${escapeHtml(formatDate(series[i].startedAt))}: wellbeing ${p.score} out of 100"></circle>`).join('');
  return `<article class="app-card section-card">
    <div class="card-head"><h2>Wellbeing over time</h2><span class="badge">${series.length} reviewed</span></div>
    <div class="trend-chart-wrap">
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Wellbeing signal trend across ${series.length} reviewed conversations, scored 0 to 100">
        ${gridLines}
        <path d="${linePath}" class="trend-line" />
        ${markers}
      </svg>
      <div class="trend-tooltip" id="trend-tooltip" hidden></div>
    </div>
    <p class="companion-safety-note">An informal signal from casual conversation only, not a clinical measure.</p>
  </article>`;
}

function wireCompanionTrendChart(content) {
  const svg = content.querySelector('.trend-chart');
  const tooltip = content.querySelector('#trend-tooltip');
  if (!svg || !tooltip) return;
  const series = companionWellbeingSeries();
  $$('.trend-point', svg).forEach((circle, i) => {
    const chat = series[i];
    const show = () => {
      const notePreview = chat.analysis.note ? `<br><span>${escapeHtml(companionHistoryTruncate(chat.analysis.note, 80))}</span>` : '';
      tooltip.innerHTML = `<b>${escapeHtml(formatDate(chat.startedAt))}</b><br>Wellbeing: ${chat.analysis.wellbeingScore}/100${notePreview}`;
      const circleRect = circle.getBoundingClientRect();
      const wrapRect = svg.parentElement.getBoundingClientRect();
      tooltip.style.left = `${circleRect.left - wrapRect.left + circleRect.width / 2}px`;
      tooltip.style.top = `${circleRect.top - wrapRect.top}px`;
      tooltip.hidden = false;
    };
    const hide = () => { tooltip.hidden = true; };
    circle.addEventListener('mouseenter', show);
    circle.addEventListener('mouseleave', hide);
    circle.addEventListener('focus', show);
    circle.addEventListener('blur', hide);
  });
}

function companionDetailMarkup(chat) {
  const analysis = chat.analysis;
  const bubbles = (chat.messages || []).map((m) => `<div class="companion-bubble ${m.role === 'assistant' ? 'ai' : 'patient'}"><p>${escapeHtml(m.text)}</p></div>`).join('');
  return `<article class="app-card section-card">
    <div class="detail-head">
      <div><h2>${escapeHtml(companionChatTitle(chat))}</h2><small>${escapeHtml(formatDate(chat.startedAt))}</small></div>
      <div class="action-row">
        <button class="action-button" data-rename-companion="${escapeHtml(chat.id)}">Rename</button>
        <button class="action-button" id="back-to-companion">← Back</button>
      </div>
    </div>
    ${analysis ? `<div class="companion-analysis">
      ${analysis.flagged ? `<div class="companion-flag-banner">✳ <b>Review recommended:</b> ${escapeHtml(analysis.flagReason || 'This conversation may need a closer look.')}</div>` : ''}
      <p class="companion-note">${escapeHtml(analysis.note)}</p>
      <div class="companion-meta-row">
        <span class="badge ${wellbeingBadgeTone(analysis.wellbeingScore)}">Wellbeing signal: ${analysis.wellbeingScore}/100</span>
        ${analysis.moodWords.map((word) => `<span class="badge">${escapeHtml(word)}</span>`).join('')}
      </div>
      <p class="companion-safety-note">${escapeHtml(analysis.safetyNote)}</p>
    </div>` : '<p class="companion-safety-note">This conversation has not been reviewed yet.</p>'}
    <div class="card-head" style="margin-top:22px"><h2>Conversation</h2></div>
    <div class="transcript-scroll companion-transcript">${bubbles}</div>
  </article>`;
}

function renderCompanion(content) {
  const chats = state.companionChats || [];
  if (companionView.mode === 'detail') {
    const chat = chats.find((item) => item.id === companionView.id);
    if (!chat) { companionView = { mode: 'list', id: null }; }
    else {

      if (chat.analysis?.flagged && !chat.analysis.acknowledged) { chat.analysis.acknowledged = true; queueSave(); }
      content.innerHTML = `${pageHead('Companion', "Conversations between your Meco member and their AI companion.")}${companionDetailMarkup(chat)}`;
      $('#back-to-companion').onclick = () => { companionView = { mode: 'list', id: null }; renderCompanion(content); };
      $('[data-rename-companion]').onclick = (event) => renameCompanionChat(event.currentTarget.dataset.renameCompanion);
      return;
    }
  }
  content.innerHTML = `${pageHead('Companion', 'Conversations between your Meco member and their AI companion.', '<button class="action-button" id="start-companion-chat">Start a chat now</button>')}
    ${flaggedChatBannerMarkup()}
    <div class="companion-disclaimer">
      <b>Not a clinical tool.</b> The notes and wellbeing signal below are an AI's informal read of casual conversation only, not a diagnosis, screening tool, or substitute for professional medical advice. If you're concerned about your care recipient's wellbeing, please talk to a healthcare professional.
    </div>
    ${companionOverviewCardMarkup()}
    ${companionTrendChartMarkup()}
    <article class="app-card section-card">
      <div class="card-head"><h2>Conversations</h2><span class="badge">${chats.length}</span></div>
      ${chats.length ? `<div class="session-list">${chats.map(companionChatRowMarkup).join('')}</div>` : '<div class="empty-state"><div><h3>No conversations yet</h3><p>Once your Meco member chats with their companion, conversations will appear here.</p></div></div>'}
    </article>`;
  wireCompanionTrendChart(content);
  wireFlaggedChatBanner(content);
  $('#start-companion-chat').onclick = () => {

    journalDraft = null;
    companionSession = { id: `chat_${Date.now()}`, startedAt: new Date().toISOString(), messages: [], busy: false };
    navigateApp('patient');
  };
  $('#refresh-companion-overview')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Refreshing…';
    await refreshCompanionOverview();
  });
  $$('[data-open-companion]', content).forEach((row) => {
    const open = () => { companionView = { mode: 'detail', id: row.dataset.openCompanion }; renderCompanion(content); };
    row.onclick = open;
    row.onkeydown = (event) => { if (event.key === 'Enter') open(); };
  });
}

function renderSessions(content) {
  if (sessionsView.mode === 'detail') {
    const session = state.sessions.find((item) => item.id === sessionsView.id);
    if (session) return renderSessionDetail(content, session);
    sessionsView = { mode: 'list', id: null };
  }
  const sorted = state.sessions.slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  content.innerHTML = `${pageHead('Visit Reports', 'Open a visit to read the conversation and its report.')}
    <div class="app-grid">
      ${sorted.length ? sorted.map(sessionCard).join('') : `<article class="app-card section-card"><div class="empty-state"><div><h3>No reports yet</h3><p>Complete a visit in patient mode to create the first report.</p><button class="action-button primary" id="reports-patient">Open patient mode</button></div></div></article>`}
    </div>`;
  $('#reports-patient')?.addEventListener('click', () => navigateApp('patient'));
  $$('[data-open-session]').forEach((card) => {
    const open = () => { sessionsView = { mode: 'detail', id: card.dataset.openSession }; renderSessions(content); };
    card.onclick = open;
    card.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
  });
}

function wireSessionActions(content) {
  $$('[data-rename-session]').forEach((button) => button.onclick = () => renameSession(button.dataset.renameSession));
  $$('[data-report-session]').forEach((button) => button.onclick = () => generateSessionSummary(button.dataset.reportSession));
  $$('[data-download-session]').forEach((button) => button.onclick = () => downloadTranscript(state.sessions.find((session) => session.id === button.dataset.downloadSession)));
  $$('[data-delete-session]').forEach((button) => button.onclick = async () => {
    const item = state.sessions.find((session) => session.id === button.dataset.deleteSession);
    if (!item || !confirm(`Delete "${sessionTitle(item)}"?`)) return;
    state.sessions = state.sessions.filter((session) => session.id !== item.id);
    sessionsView = { mode: 'list', id: null };
    await persistState(true);
    renderSessions(content);
  });
}

function transcriptToText(session) {
  const header = [
    `Meco visit transcript`,
    `Visit: ${sessionTitle(session)}`,
    `Visitor: ${session.visitorName || 'Unrecognized visitor'}${session.relationship ? ` (${session.relationship})` : ''}`,
    `Recorded: ${formatDate(session.startedAt)}`,
    `Turns: ${(session.transcript || []).length}`,
    '',
  ].join('\n');
  const body = (session.transcript || []).map((line) => {
    const speaker = line.displaySpeaker || line.speaker || 'Speaker';
    const text = `[${formatDuration(line.start || 0)}] ${speaker}: ${line.text || ''}`;
    return line.translation ? `${text}\n${' '.repeat(9)}${line.translation}` : text;
  }).join('\n');
  return `${header}${body}\n`;
}

function downloadTranscript(session) {
  if (!session?.transcript?.length) return toast('There is no transcript to download yet.', 'error');
  const stamp = new Date(session.startedAt || Date.now()).toISOString().slice(0, 10);
  const safeName = String(sessionTitle(session)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'visit';
  const blob = new Blob([transcriptToText(session)], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `meco-visit-${safeName}-${stamp}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Transcript downloaded.', 'success');
}

async function generateSessionSummary(id) {
  const session = state.sessions.find((item) => item.id === id);
  const button = $(`[data-report-session="${CSS.escape(id)}"]`);
  if (!session || !session.transcript?.length) return toast('This visit has no transcript to summarize.', 'error');
  if (button) { button.disabled = true; button.textContent = 'Generating…'; }
  try {
    const result = await apiFetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitorName: session.visitorName,
        relationship: session.relationship,
        transcript: session.transcript,
      }),
    });
    session.summary = result;
    await persistState();
    toast(`Report generated with ${result.provider}.`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    renderSessions($('#app-content'));
  }
}

function utteranceMarkupReadOnly(line) {
  return `<div class="utterance"><div class="utterance-head"><b>${escapeHtml(line.displaySpeaker || line.speaker || 'Speaker')}</b><small>${formatDuration(line.start || 0)}</small></div><p>${escapeHtml(line.text || '')}</p>${line.translation ? `<small>${escapeHtml(line.translation)}</small>` : ''}</div>`;
}

function googleCalendarCardMarkup() {
  const googleAccount = clerk?.user?.externalAccounts?.find((account) => account.provider === 'google');
  const connected = Boolean(googleAccount && String(googleAccount.approvedScopes || '').includes('calendar'));
  const label = connected
    ? `Connected as ${googleAccount.emailAddress || googleAccount.identifier || 'your Google account'}`
    : googleAccount ? 'Connected, but calendar access was not granted' : 'Not connected';
  let action = '';
  if (config.features.localDemo) {
    action = '<small>Sign in with a real account to connect Google Calendar.</small>';
  } else if (!config.features.googleCalendar) {
    action = '<small>The server is not configured for Google Calendar yet.</small>';
  } else if (!connected) {
    action = '<button class="action-button primary" id="connect-google-calendar" type="button">Connect Google Calendar</button>';
  } else {
    action = `<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="calendar-sync-toggle" ${state.settings.googleCalendarSync ? 'checked' : ''}> Sync visits &amp; reminders automatically</label>`;
  }
  return `<article class="app-card section-card" style="margin-top:18px">
    <div class="card-head"><h2>Google Calendar</h2></div>
    <div class="people-list"><div class="person-row"><div class="person-avatar">G</div><div class="row-copy"><b>${escapeHtml(label)}</b><small>Two-way sync with your primary Google Calendar, including weekly repeats, checked roughly every 90 seconds so edits made on either side reach the other.</small></div><span class="badge">${connected ? 'Connected' : 'Not connected'}</span></div></div>
    <div class="action-row" style="margin-top:14px">${action}</div>
  </article>`;
}

async function connectGoogleCalendar() {
  if (!clerk?.user) return toast('Sign in again to connect Google Calendar.', 'error');
  const scopes = ['https://www.googleapis.com/auth/calendar.events'];
  const redirectUrl = `${location.origin}/app`;
  try {
    const googleAccount = clerk.user.externalAccounts.find((account) => account.provider === 'google');
    const result = googleAccount
      ? await googleAccount.reauthorize({ redirectUrl, additionalScopes: scopes })
      : await clerk.user.createExternalAccount({ strategy: 'oauth_google', redirectUrl, additionalScopes: scopes });
    const redirect = result?.verification?.externalVerificationRedirectURL;
    if (redirect) window.location.href = typeof redirect === 'string' ? redirect : redirect.href;
    else toast('Google did not return a consent link. Check that Google is enabled in the Clerk dashboard.', 'error');
  } catch (error) {
    toast(`Couldn't start the Google Calendar connection: ${error.message || error}`, 'error');
  }
}

let customSelectGlobalListenerAttached = false;
function ensureCustomSelectGlobalListener() {
  if (customSelectGlobalListenerAttached) return;
  customSelectGlobalListenerAttached = true;
  document.addEventListener('click', (event) => {
    $$('.custom-select.open').forEach((wrap) => { if (!wrap.contains(event.target)) wrap.classList.remove('open'); });
  });
}

function enhanceSelect(select) {
  ensureCustomSelectGlobalListener();
  const wrap = document.createElement('div');
  wrap.className = 'custom-select';
  select.parentNode.insertBefore(wrap, select);
  select.tabIndex = -1;
  wrap.appendChild(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  const label = document.createElement('span');
  const chevron = document.createElement('span');
  chevron.className = 'custom-select-chevron';
  trigger.append(label, chevron);
  wrap.appendChild(trigger);

  const panel = document.createElement('div');
  panel.className = 'custom-select-panel';
  panel.setAttribute('role', 'listbox');
  wrap.appendChild(panel);

  const options = [...select.options];
  const optionEls = options.map((option) => {
    const item = document.createElement('div');
    item.className = 'custom-select-option';
    item.setAttribute('role', 'option');
    item.textContent = option.textContent;
    item.addEventListener('click', () => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
      wrap.classList.remove('open');
    });
    panel.appendChild(item);
    return item;
  });

  function sync() {
    const current = select.options[select.selectedIndex];
    label.textContent = current ? current.textContent : '';
    optionEls.forEach((item, index) => item.classList.toggle('selected', options[index].value === select.value));
    wrap.classList.toggle('disabled', select.disabled);
  }

  trigger.addEventListener('click', () => {
    if (select.disabled) return;
    $$('.custom-select.open').forEach((other) => { if (other !== wrap) other.classList.remove('open'); });
    wrap.classList.toggle('open');
  });
  trigger.addEventListener('keydown', (event) => {
    if (select.disabled) return;
    if (event.key === 'Escape') wrap.classList.remove('open');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const currentIndex = options.findIndex((option) => option.value === select.value);
      const nextIndex = Math.min(options.length - 1, Math.max(0, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      select.value = options[nextIndex].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    }
  });

  sync();
}

function enhanceSelectsIn(container) {
  container.querySelectorAll('select').forEach(enhanceSelect);
}

function setSelectDisabled(selector, disabled) {
  const select = $(selector);
  if (!select) return;
  select.disabled = disabled;
  select.closest('.custom-select')?.classList.toggle('disabled', disabled);
}

function renderSettings(content) {
  const s = state.settings;
  content.innerHTML = `${pageHead('Settings', 'Adjust patient mode, voice support and transcription.')}
    <article class="app-card section-card"><form id="settings-form">
      <div class="settings-group">
        <p class="settings-group-title">Profile</p>
        <div class="form-grid">
          <div class="form-field"><label>Patient display name</label><input name="patientName" value="${escapeHtml(s.patientName)}"></div>
          <div class="form-field"><label>Caregiver name</label><input name="caregiverName" value="${escapeHtml(s.caregiverName)}"></div>
          <div class="form-field full"><label>Caregiver reassurance note</label><textarea name="caregiverNote" rows="3">${escapeHtml(s.caregiverNote)}</textarea></div>
        </div>
      </div>
      <div class="settings-group">
        <p class="settings-group-title">Voice &amp; conversation</p>
        <div class="form-grid">
          <div class="form-field"><label>Voice</label><select name="voiceGender"><option value="female" ${s.voiceGender === 'female' ? 'selected' : ''}>Female voice preference</option><option value="male" ${s.voiceGender === 'male' ? 'selected' : ''}>Male voice preference</option><option value="default" ${s.voiceGender === 'default' ? 'selected' : ''}>Browser default</option></select></div>
          <div class="form-field"><label>Expected visit speakers</label><select name="expectedSpeakers">${[2,3,4,5,6].map((n) => `<option value="${n}" ${Number(s.expectedSpeakers) === n ? 'selected' : ''}>${n} speakers</option>`).join('')}</select></div>
          <div class="form-field"><label>Conversation capture</label><select name="transcriptionMode"><option value="live" ${s.transcriptionMode !== 'batch' ? 'selected' : ''}>Live during the visit${config.features.liveTranscription ? '' : ' (needs a key)'}</option><option value="batch" ${s.transcriptionMode === 'batch' ? 'selected' : ''}>After the visit with AssemblyAI</option></select></div>
        </div>
      </div>
      <div class="settings-group">
        <p class="settings-group-title">Matching &amp; greeting</p>
        <div class="form-grid">
          <div class="form-field full"><label class="range-label">Voice match strictness <span id="voice-threshold-value" class="range-value-badge">${Math.round(Number(s.voiceThreshold) * 100)}%</span></label><div class="range-row"><input id="voice-threshold-range" name="voiceThreshold" type="range" min="0.5" max="0.9" step="0.01" value="${s.voiceThreshold}"><span>Flexible ↔ Strict</span></div></div>
          <div class="form-field full"><label class="range-label">Greeting speed <span id="rate-value" class="range-value-badge">${Number(s.ttsRate).toFixed(2)}×</span></label><div class="range-row"><input id="rate-range" name="ttsRate" type="range" min="0.5" max="1.25" step="0.05" value="${s.ttsRate}"><span>Slow ↔ Natural</span></div></div>
          <div class="form-field full"><label class="range-label">Greeting pitch <span id="pitch-value" class="range-value-badge">${Number(s.ttsPitch).toFixed(2)}</span></label><div class="range-row"><input id="pitch-range" name="ttsPitch" type="range" min="0.7" max="1.3" step="0.05" value="${s.ttsPitch}"><span>Low ↔ High</span></div></div>
          <div class="form-field full"><label class="range-label">Face match threshold <span id="threshold-value" class="range-value-badge">${Math.round(Number(s.faceThreshold) * 100)}%</span></label><div class="range-row"><input id="threshold-range" name="faceThreshold" type="range" min="0.55" max="0.9" step="0.01" value="${s.faceThreshold}"><span>Flexible ↔ Strict</span></div></div>
        </div>
      </div>
      <div class="settings-group">
        <p class="settings-group-title">Accessibility</p>
        <label class="elder-mode-toggle"><input type="checkbox" name="elderMode" ${s.elderMode ? 'checked' : ''}> <span><b>Elder-friendly display</b><small>Larger text and bigger buttons on patient mode, the companion chat and the journal, for anyone who finds the normal size hard to read or tap.</small></span></label>
      </div>
      <div class="action-row settings-actions"><button class="action-button primary" type="submit">Save settings</button><button id="test-greeting" class="action-button" type="button">Test greeting voice</button></div>
    </form></article>
    ${familyContributionsCardMarkup()}
    ${placesCardMarkup()}
    ${objectMemoryCardMarkup()}
    ${googleCalendarCardMarkup()}
    <article class="app-card section-card" style="margin-top:18px"><div class="card-head"><h2>Service status</h2></div><div class="people-list"><div class="person-row"><div class="person-avatar">C</div><div class="row-copy"><b>Clerk authentication</b><small>Protects the Meco workspace and server API calls</small></div><span class="badge">${config.features.clerk ? 'Configured' : 'Missing'}</span></div><div class="person-row"><div class="person-avatar">A</div><div class="row-copy"><b>Appwrite backend</b><small>Persists the private account state</small></div><span class="badge">${escapeHtml(backendName)}</span></div><div class="person-row"><div class="person-avatar">AI</div><div class="row-copy"><b>AssemblyAI</b><small>Multi-speaker transcription and diarisation</small></div><span class="badge">${config.features.assemblyai ? 'Configured' : 'Missing'}</span></div><div class="person-row"><div class="person-avatar">≋</div><div class="row-copy"><b>Live transcription</b><small>Streams the visit through Meco while it is recorded</small></div><span class="badge">${config.features.liveTranscription ? 'Configured' : 'Missing'}</span></div><div class="person-row"><div class="person-avatar">◉</div><div class="row-copy"><b>Voice recognition</b><small>${voiceprints.length} voiceprint${voiceprints.length === 1 ? '' : 's'} on the local server</small></div><span class="badge">${config.features.voiceId ? 'Enabled' : 'Disabled'}</span></div><div class="person-row"><div class="person-avatar">文</div><div class="row-copy"><b>Transcript translation</b><small>Shows each turn in the chosen conversation language</small></div><span class="badge">${config.features.translation ? 'Configured' : 'Missing'}</span></div><div class="person-row"><div class="person-avatar">G</div><div class="row-copy"><b>Gemini / Groq</b><small>Structured caregiver visit summaries</small></div><span class="badge">${config.features.gemini ? 'Gemini' : config.features.groq ? 'Groq' : 'Local fallback'}</span></div></div></article>
    ${dataPrivacyCardMarkup()}`;
  $('#rate-range').oninput = (event) => $('#rate-value').textContent = `${Number(event.target.value).toFixed(2)}×`;
  $('#pitch-range').oninput = (event) => $('#pitch-value').textContent = Number(event.target.value).toFixed(2);
  $('#threshold-range').oninput = (event) => $('#threshold-value').textContent = `${Math.round(Number(event.target.value) * 100)}%`;
  $('#voice-threshold-range').oninput = (event) => $('#voice-threshold-value').textContent = `${Math.round(Number(event.target.value) * 100)}%`;
  enhanceSelectsIn($('#settings-form'));
  loadVoiceprints();
  $('#settings-form').onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.settings = {
      ...state.settings,
      patientName: String(data.get('patientName') || '').slice(0, 80),
      caregiverName: String(data.get('caregiverName') || '').slice(0, 80),
      caregiverNote: String(data.get('caregiverNote') || '').slice(0, 500),
      voiceGender: String(data.get('voiceGender') || 'default'),
      expectedSpeakers: Number(data.get('expectedSpeakers') || 2),
      transcriptionMode: String(data.get('transcriptionMode') || 'live'),
      voiceThreshold: Number(data.get('voiceThreshold') || .62),
      ttsRate: Number(data.get('ttsRate') || .82),
      ttsPitch: Number(data.get('ttsPitch') || 1.04),
      faceThreshold: Number(data.get('faceThreshold') || .70),
      elderMode: data.get('elderMode') === 'on',
    };
    $('#sidebar-care-note').textContent = state.settings.caregiverNote;
    await persistState(true);
  };
  $('#test-greeting').onclick = () => speakText(`Hello ${state.settings.patientName}. You are safe. Take your time. Meco is here with you.`);
  $('#connect-google-calendar')?.addEventListener('click', connectGoogleCalendar);
  $('#calendar-sync-toggle')?.addEventListener('change', async (event) => {
    state.settings.googleCalendarSync = event.target.checked;
    await persistState(true);
  });
  wireFamilyContributionsCard(content);
  wirePlacesCard(content);
  wireObjectMemoryCard(content);
  wireDataPrivacyCard(content);
}

const CONTRIBUTION_TYPE_LABEL = { photo: 'Photo', story: 'Story', event: 'Upcoming event', correction: 'Correction', voice: 'Voice message' };

let familyLinkCache = '';

function familyContributionsCardMarkup() {
  const pending = (state.familyContributions || []).filter((c) => c.status === 'pending');
  return `<article class="app-card section-card" style="margin-top:18px">
    <div class="card-head"><h2>Family contributions</h2></div>
    <p class="calming-hint">Share this link with family, anything they send sits here for review before it becomes part of Meco.</p>
    <div class="family-link-row">
      <input id="family-link-field" type="text" readonly value="${escapeHtml(familyLinkCache || '')}" placeholder="Generate a link to get started">
      <button class="action-button" id="family-link-generate">${familyLinkCache ? 'Copy' : 'Generate link'}</button>
      <button class="action-button" id="family-link-regenerate" title="Invalidate the old link and make a new one">Regenerate</button>
    </div>
    ${pending.length ? `<div class="family-contrib-list">${pending.map(familyContributionRowMarkup).join('')}</div>` : `<div class="empty-state"><div><h3>Nothing waiting for review</h3><p>Contributions from family will show up here.</p></div></div>`}
  </article>`;
}

function familyContributionRowMarkup(c) {
  const person = c.aboutVisitorId ? state.visitors.find((v) => v.id === c.aboutVisitorId) : null;
  return `<div class="family-contrib-row" data-contribution-id="${escapeHtml(c.id)}">
    <div class="card-head" style="margin-bottom:8px">
      <div><b>${escapeHtml(c.title)}</b> <span class="badge">${escapeHtml(CONTRIBUTION_TYPE_LABEL[c.type] || c.type)}</span></div>
      <small>${escapeHtml(c.contributorName)}${c.contributorRelation ? ` · ${escapeHtml(c.contributorRelation)}` : ''}${person ? ` · about ${escapeHtml(person.name)}` : ''}</small>
    </div>
    ${c.text ? `<p>${escapeHtml(c.text)}</p>` : ''}
    ${c.photoDataUrl ? `<img src="${c.photoDataUrl}" alt="" class="family-contrib-photo">` : ''}
    ${c.voiceDataUrl ? `<audio controls src="${c.voiceDataUrl}"></audio>` : ''}
    <div class="action-row" style="margin-top:10px">
      <button class="action-button primary" data-approve-contribution="${escapeHtml(c.id)}">Approve</button>
      <button class="action-button danger" data-reject-contribution="${escapeHtml(c.id)}">Reject</button>
    </div>
  </div>`;
}

function wireFamilyContributionsCard(content) {
  $('#family-link-generate')?.addEventListener('click', async () => {
    if (familyLinkCache) { copyToClipboard(familyLinkCache); return; }
    await generateFamilyLink(false);
  });
  $('#family-link-regenerate')?.addEventListener('click', () => {
    if (!confirm('The old link will stop working. Generate a fresh one?')) return;
    generateFamilyLink(true);
  });
  content.querySelectorAll('[data-approve-contribution]').forEach((button) => button.onclick = () => approveContribution(button.dataset.approveContribution));
  content.querySelectorAll('[data-reject-contribution]').forEach((button) => button.onclick = () => rejectContribution(button.dataset.rejectContribution));
}

async function generateFamilyLink(regenerate) {
  try {
    const result = await apiFetch('/api/family/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate }),
    });
    familyLinkCache = result.url;
    renderSettings($('#app-content'));
    copyToClipboard(result.url);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Link copied.', 'success')).catch(() => toast('Copy the link from the field.', ''));
}

async function approveContribution(id) {
  const contribution = (state.familyContributions || []).find((c) => c.id === id);
  if (!contribution) return;
  if (contribution.type === 'correction') {

    state.careNotes = [{
      id: `note_${Date.now()}`,
      text: `Correction from ${contribution.contributorName} (family)${contribution.contributorRelation ? `, ${contribution.contributorRelation}` : ''}: ${contribution.title}${contribution.text ? `, ${contribution.text}` : ''}`,
      createdAt: new Date().toISOString(),
      pinned: true,
    }, ...(state.careNotes || [])];
  } else {
    const memory = {
      id: `mem_${Date.now()}`,
      title: contribution.title,
      date: new Date().toISOString(),
      peopleIds: contribution.aboutVisitorId ? [contribution.aboutVisitorId] : [],
      placeId: null, sessionId: null, journalEntryId: null,
      photoDataUrls: contribution.photoDataUrl ? [contribution.photoDataUrl] : [],
      voiceClipDataUrl: contribution.voiceDataUrl || null,
      summary: (contribution.text || contribution.title).slice(0, 240),
      details: contribution.text || '',
      tags: [],
      source: 'family',
      confidence: 'family-provided',
      contributorName: contribution.contributorName,
      contributorRelation: contribution.contributorRelation,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    state.memories = [memory, ...(state.memories || [])].slice(0, 500);
  }
  state.familyContributions = state.familyContributions.filter((c) => c.id !== id);
  await persistState(true);
  renderSettings($('#app-content'));
}

async function rejectContribution(id) {
  state.familyContributions = (state.familyContributions || []).filter((c) => c.id !== id);
  await persistState(true);
  renderSettings($('#app-content'));
}

function placesCardMarkup() {
  const graph = buildMemoryGraph();
  const places = state.places || [];
  return `<article class="app-card section-card" style="margin-top:18px">
    <div class="card-head"><h2>Places</h2><button class="action-button" id="add-place">+ Add place</button></div>
    <p class="calming-hint">Name the places worth remembering, link a memory to one from its edit view to build "what happened here last time."</p>
    ${places.length ? `<div class="object-list">${places.map((place) => placeRowMarkup(place, graph)).join('')}</div>` : `<div class="empty-state"><div><h3>No places yet</h3><p>Add somewhere meaningful, home, the garden, a favourite café.</p></div></div>`}
  </article>`;
}

function placeRowMarkup(place, graph) {
  const linked = graph.memoriesForPlace(place.id);
  return `<div class="object-row" data-place-row="${escapeHtml(place.id)}">
    <span class="object-row-icon">⚲</span>
    <div class="object-row-copy"><b>${escapeHtml(place.name)}</b><small>${place.notes ? `${escapeHtml(place.notes)} · ` : ''}${linked.length} memor${linked.length === 1 ? 'y' : 'ies'} linked</small>
      <div class="place-memories hidden"></div>
    </div>
    <div class="action-row">
      <button class="action-button" data-toggle-place="${escapeHtml(place.id)}" ${linked.length ? '' : 'disabled'}>What happened here?</button>
      <button class="icon-button danger" data-delete-place="${escapeHtml(place.id)}" title="Remove">✕</button>
    </div>
  </div>`;
}

function wirePlacesCard(content) {
  $('#add-place')?.addEventListener('click', addPlacePrompt);
  content.querySelectorAll('[data-delete-place]').forEach((button) => button.onclick = () => deletePlace(button.dataset.deletePlace));
  content.querySelectorAll('[data-toggle-place]').forEach((button) => button.onclick = () => {
    const row = button.closest('[data-place-row]');
    const panel = row?.querySelector('.place-memories');
    if (!panel) return;
    const opening = panel.classList.contains('hidden');
    if (opening) {
      const graph = buildMemoryGraph();
      const linked = graph.memoriesForPlace(button.dataset.togglePlace);
      panel.innerHTML = linked.map((m) => `<button type="button" class="related-memory-card" data-open-place-memory="${escapeHtml(m.id)}"><b>${escapeHtml(m.title)}</b><small>${escapeHtml(formatDate(m.date || m.createdAt))}, ${escapeHtml(m.summary || '')}</small></button>`).join('');
      panel.querySelectorAll('[data-open-place-memory]').forEach((card) => card.onclick = () => openMemoryDetail(card.dataset.openPlaceMemory));
    }
    panel.classList.toggle('hidden', !opening);
    button.textContent = opening ? 'Hide' : 'What happened here?';
  });
}

async function addPlacePrompt() {
  const name = window.prompt('Name this place (e.g. The garden, Home, GP surgery)');
  if (!name || !name.trim()) return;
  const notes = window.prompt('A short note about it? (optional)') || '';
  state.places = [...(state.places || []), { id: crypto.randomUUID(), name: name.trim().slice(0, 60), notes: notes.trim().slice(0, 140), createdAt: new Date().toISOString() }].slice(0, 100);
  await persistState(true);
  renderSettings($('#app-content'));
}

async function deletePlace(id) {
  const place = (state.places || []).find((item) => item.id === id);
  if (!place || !confirm(`Remove "${place.name}"? Memories already linked to it keep their own record, only the place entry goes.`)) return;
  state.places = (state.places || []).filter((item) => item.id !== id);
  (state.memories || []).forEach((memory) => { if (memory.placeId === id) memory.placeId = null; });
  await persistState(true);
  renderSettings($('#app-content'));
}

function objectMemoryCardMarkup() {
  const objects = state.objects || [];
  return `<article class="app-card section-card" style="margin-top:18px">
    <div class="card-head"><h2>Object memory</h2><button class="action-button" id="add-object">+ Add object</button></div>
    <p class="calming-hint">Track where commonly-misplaced things were last seen, logged by a caregiver, never guessed.</p>
    ${objects.length ? `<div class="object-list">${objects.map(objectRowMarkup).join('')}</div>` : `<div class="empty-state"><div><h3>Nothing tracked yet</h3><p>Add glasses, keys, a wallet, anything worth a quick "last seen" note.</p></div></div>`}
  </article>`;
}

function objectRowMarkup(object) {
  const status = object.lastObservedAt
    ? `Last seen ${escapeHtml(formatDate(object.lastObservedAt))}${object.lastObservedNote ? `, ${escapeHtml(object.lastObservedNote)}` : ''}`
    : 'Not yet observed';
  return `<div class="object-row" data-object-id="${escapeHtml(object.id)}">
    <span class="object-row-icon">${escapeHtml(object.icon || '◆')}</span>
    <div class="object-row-copy"><b>${escapeHtml(object.name)}</b><small>${status}</small></div>
    <div class="action-row">
      <button class="action-button" data-mark-observed="${escapeHtml(object.id)}">Mark seen here</button>
      <button class="icon-button danger" data-delete-object="${escapeHtml(object.id)}" title="Remove">✕</button>
    </div>
  </div>`;
}

function objectMemoryOverviewCardMarkup() {
  const objects = state.objects || [];
  if (!objects.length) return '';
  const lines = objects.slice(0, 3).map((object) => `${escapeHtml(object.name)}, ${object.lastObservedAt ? escapeHtml(formatDate(object.lastObservedAt)) : 'not yet observed'}`);
  return `<article class="app-card teaser-tile" id="overview-objects-tile" role="button" tabindex="0" style="grid-column:span 6">
    <div class="teaser-tile-icon">◆</div>
    <div><h3>Object memory</h3><p>${lines.join(' · ')}</p></div>
    <span class="teaser-tile-go">→</span>
  </article>`;
}

function wireObjectMemoryCard(content) {
  $('#add-object')?.addEventListener('click', addObjectPrompt);
  content.querySelectorAll('[data-mark-observed]').forEach((button) => button.onclick = () => markObjectObserved(button.dataset.markObserved));
  content.querySelectorAll('[data-delete-object]').forEach((button) => button.onclick = () => deleteObjectMemory(button.dataset.deleteObject));
}

async function addObjectPrompt() {
  const name = window.prompt('What should Meco help track? (e.g. Glasses, Keys, Wallet)');
  if (!name || !name.trim()) return;
  state.objects = [...(state.objects || []), {
    id: crypto.randomUUID(), name: name.trim().slice(0, 60), icon: '◆',
    lastObservedAt: null, lastObservedNote: '', createdAt: new Date().toISOString(),
  }].slice(0, 50);
  await persistState(true);
  renderSettings($('#app-content'));
}

async function markObjectObserved(id) {
  const object = (state.objects || []).find((item) => item.id === id);
  if (!object) return;
  const note = window.prompt(`Where was ${object.name} last seen? (optional)`, object.lastObservedNote || '') ?? '';
  object.lastObservedAt = new Date().toISOString();
  object.lastObservedNote = note.trim().slice(0, 140);
  await persistState(true);
  renderAppPage(currentPage);
}

async function deleteObjectMemory(id) {
  const object = (state.objects || []).find((item) => item.id === id);
  if (!object || !confirm(`Stop tracking ${object.name}?`)) return;
  state.objects = (state.objects || []).filter((item) => item.id !== id);
  await persistState(true);
  renderAppPage(currentPage);
}

const DATA_PRIVACY_CATEGORIES = [
  { key: 'visitors', label: 'Trusted people', desc: 'Removes every enrolled face/voice, their memory cues and Familiar Sounds. Visit reports already saved keep the visitor’s name as plain text.', countOf: (s) => (s.visitors || []).length },
  { key: 'sessions', label: 'Visit transcripts & reports', desc: 'Removes every recorded transcript, AI summary and engagement score. Enrolled people and scheduled visits remain.', countOf: (s) => (s.sessions || []).length },
  { key: 'visits', label: 'Scheduled visits', desc: 'Removes upcoming and past calendar entries. Already-recorded visit reports remain.', countOf: (s) => (s.visits || []).length },
  { key: 'reminders', label: 'Reminders', desc: 'Removes every reminder, whether added manually or synced from Google Calendar.', countOf: (s) => (s.reminders || []).length },
  { key: 'journalEntries', label: 'Journal entries', desc: 'Removes everything written in the patient’s own Journal.', countOf: (s) => (s.journalEntries || []).length },
  { key: 'careNotes', label: 'Care Notes', desc: 'Removes the caregiver-to-caregiver note log. Journal entries remain, that’s a separate space.', countOf: (s) => (s.careNotes || []).length },
  { key: 'moodCheckIns', label: 'Mood check-ins', desc: 'Removes every quick mood tap logged from Patient mode.', countOf: (s) => (s.moodCheckIns || []).length },
  { key: 'companionChats', label: 'Companion chat history', desc: 'Removes saved Companion conversations and the rolling wellbeing overview built from them.', countOf: (s) => (s.companionChats || []).length },
];

function dataPrivacyCardMarkup() {
  return `<article class="app-card section-card privacy-data-card" style="margin-top:18px">
    <div class="card-head"><h2>Data &amp; privacy</h2><span class="badge">Delete by category</span></div>
    <p class="privacy-data-intro">Each of these clears independently, deleting one never touches the others. There's no confirmation email or waiting period: once you confirm, it's gone from this account.</p>
    <div class="privacy-data-list">
      ${DATA_PRIVACY_CATEGORIES.map((cat) => `<div class="privacy-data-row">
        <div class="privacy-data-row-copy"><b>${escapeHtml(cat.label)}</b><small>${escapeHtml(cat.desc)}</small></div>
        <span class="badge">${cat.countOf(state)}</span>
        <button type="button" class="action-button danger" data-clear-category="${cat.key}" ${cat.countOf(state) ? '' : 'disabled'}>Delete all</button>
      </div>`).join('')}
    </div>
  </article>`;
}

async function clearDataCategory(key) {
  const cat = DATA_PRIVACY_CATEGORIES.find((c) => c.key === key);
  if (!cat) return;
  const count = cat.countOf(state);
  if (!count) return;
  if (!confirm(`Delete all ${count} ${cat.label.toLowerCase()}? ${cat.desc}\n\nThis cannot be undone.`)) return;
  if (key === 'companionChats') { state.companionChats = []; state.companionOverview = null; }
  else state[key] = [];
  await persistState(true);
  renderAppPage(currentPage);
}

function wireDataPrivacyCard(content) {
  content.querySelectorAll('[data-clear-category]').forEach((button) => {
    button.onclick = () => clearDataCategory(button.dataset.clearCategory);
  });
}

function speakText(text) {
  if (!window.speechSynthesis) return toast('Speech synthesis is not supported in this browser.', 'error');
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = Number(state.settings.ttsRate || .82);
  utterance.pitch = Number(state.settings.ttsPitch || 1.04);
  const voices = speechSynthesis.getVoices();
  if (state.settings.voiceGender === 'female') utterance.voice = voices.find((voice) => /Samantha|Zira|female|Google UK English Female/i.test(voice.name)) || null;
  if (state.settings.voiceGender === 'male') utterance.voice = voices.find((voice) => /Daniel|David|male|Google UK English Male/i.test(voice.name)) || null;
  speechSynthesis.speak(utterance);
}

const liveTranscriptionAvailable = () => Boolean(config.features?.liveTranscription);
const voiceIdAvailable = () => Boolean(config.features?.voiceId);
const translationAvailable = () => Boolean(config.features?.translation);
const liveModeEnabled = () => liveTranscriptionAvailable() && (state.settings.transcriptionMode || 'live') !== 'batch';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

async function loadVoiceprints() {
  if (!voiceIdAvailable()) { voiceprints = []; voiceprintsLoaded = true; return voiceprints; }
  try {
    const result = await apiFetch('/api/voice/speakers');
    voiceprints = Array.isArray(result.speakers) ? result.speakers : [];
  } catch (error) {
    voiceprints = [];
    console.warn('Voice recognition unavailable:', error.message);
  }
  voiceprintsLoaded = true;
  return voiceprints;
}

function voiceprintFor(visitor) {
  if (!visitor) return null;
  return voiceprints.find((item) => item.personId === visitor.id)
    || voiceprints.find((item) => item.name.toLowerCase() === String(visitor.name || '').toLowerCase())
    || null;
}

function floatToInt16(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = clamp(input[i], -1, 1);
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function concatFloat32(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length; });
  return output;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeString(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeString(8, 'WAVE');
  writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = clamp(samples[i], -1, 1);
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function recordVoiceSample(durationMs, onProgress) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  if (audioCtx.state !== 'running') await audioCtx.resume().catch(() => {});
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(2048, 1, 1);
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  const chunks = [];
  processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(silent);
  silent.connect(audioCtx.destination);
  try {
    const started = Date.now();
    await new Promise((resolve) => {
      const tick = () => {
        const elapsed = Date.now() - started;
        onProgress?.(Math.max(0, Math.ceil((durationMs - elapsed) / 1000)));
        if (elapsed >= durationMs) return resolve();
        setTimeout(tick, 200);
      };
      tick();
    });
    const samples = concatFloat32(chunks);
    return { base64: await blobToBase64(encodeWav(samples, audioCtx.sampleRate)), sampleRate: audioCtx.sampleRate };
  } finally {
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch {}
    try { source.disconnect(); } catch {}
    stream.getTracks().forEach((track) => track.stop());
    audioCtx.close().catch(() => {});
  }
}

const voicePromptSentence = () => [
  'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the hills.',
  'Could you please pass the blue umbrella? I think it might rain again this afternoon.',
  'We walked through the garden and talked about the photographs in the old blue album.',
][Math.floor(Math.random() * 3)];

async function enrollVoiceSample({ name, personId }, onProgress) {
  const sample = await recordVoiceSample(12000, onProgress);
  const result = await apiFetch('/api/voice/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, personId: personId || '', audio: sample.base64 }),
  });
  await loadVoiceprints();
  return result;
}

async function identifyVoice(samples, sampleRate) {
  try {
    const audio = await blobToBase64(encodeWav(samples, sampleRate));
    const result = await apiFetch('/api/voice/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio }),
    });
    const scores = Array.isArray(result.scores) ? result.scores : [];
    if (!scores.length) return null;
    const best = scores.reduce((top, item) => (item.score > top.score ? item : top), scores[0]);
    return best.score >= Number(state.settings.voiceThreshold || 0.62) ? best : null;
  } catch (error) {
    console.warn('Voice identification failed:', error.message);
    return null;
  }
}

function liveSpeakerName(clusterKey) {
  if (!liveContext) return 'Speaker';
  if (!liveContext.clusterNames.has(clusterKey)) {
    const index = liveContext.clusterNames.size;
    const fallback = index === 0
      ? (patientContext?.visitor?.name || 'Visitor')
      : index === 1 ? state.settings.patientName : `Speaker ${index + 1}`;
    liveContext.clusterNames.set(clusterKey, fallback);
  }
  return liveContext.clusterNames.get(clusterKey);
}

const TURN_MERGE_GAP_MS = 3000;

function pushLiveTurn({ speaker, displaySpeaker, text, start, end, confidence }) {

  const last = liveContext.turns[liveContext.turns.length - 1];
  if (last && last.speaker === speaker && (start - (last.end || last.start || 0)) < TURN_MERGE_GAP_MS) {
    last.text = `${last.text} ${text}`.replace(/\s+/g, ' ').trim();
    last.end = end;
    renderLiveTranscript();
    translateTurn(last);
    return last;
  }
  const turn = {
    id: `live_${liveContext.turns.length}_${Date.now()}`,
    speaker,
    displaySpeaker,
    text,
    start,
    end,
    confidence: confidence ?? null,
    source: 'live',
  };
  liveContext.turns.push(turn);
  renderLiveTranscript();
  translateTurn(turn);
  return turn;
}

async function translateTurn(turn) {
  const source = state.settings.conversationLanguage || 'en';
  const target = state.settings.translationLanguage || 'en';
  if (target === source || !translationAvailable() || !turn.text.trim()) return;
  try {
    const result = await apiFetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: turn.text, source, target }),
    });
    turn.translation = result.text;
    turn.translationLanguage = target;
    renderLiveTranscript();
  } catch (error) {
    console.warn('Translation failed:', error.message);
  }
}

function renderLiveTranscript() {
  const scroll = $('#transcript-scroll');
  if (!scroll || !liveContext) return;

  if (liveContext.stopping) return;
  const badge = $('#transcript-badge');
  if (badge) badge.textContent = liveContext.turns.length ? `${turnsLabel(liveContext.turns.length)} · live` : 'Listening';
  const body = liveContext.turns.map((turn) => `<div class="utterance"><div class="utterance-head"><b>${escapeHtml(turn.displaySpeaker)}</b><small>${formatDuration(turn.start || 0)}</small></div><p>${escapeHtml(turn.text)}</p>${turn.translation ? `<small>${escapeHtml(turn.translation)}</small>` : ''}</div>`).join('');
  const interim = liveContext.interim ? `<div class="utterance utterance-interim"><div class="utterance-head"><b>Listening…</b></div><p>${escapeHtml(liveContext.interim)}</p></div>` : '';
  scroll.innerHTML = body + interim || '<div class="empty-state"><p>Meco is listening. Speaker-labelled turns appear here as people talk.</p></div>';
  scroll.scrollTop = scroll.scrollHeight;
}

function turnsFromClustering(alternative, transcript, startMs) {
  const words = alternative.words || [];
  if (!words.length) return [{ key: 'cluster-0', text: transcript, start: startMs, end: startMs }];
  const groups = [];
  let run = [words[0]];
  const flush = () => {
    const first = run[0];
    const last = run[run.length - 1];
    groups.push({
      key: `cluster-${first.speaker ?? 0}`,
      text: run.map((word) => word.punctuated_word || word.word).join(' '),
      start: Math.round((first.start || 0) * 1000),
      end: Math.round((last.end || 0) * 1000),
    });
  };
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].speaker === run[run.length - 1].speaker) run.push(words[i]);
    else { flush(); run = [words[i]]; }
  }
  flush();
  return groups;
}

async function handleLiveResult(data) {
  if (!liveContext?.active) return;
  const alternative = data.channel?.alternatives?.[0];
  if (!alternative) return;
  const transcript = (alternative.transcript || '').trim();
  const startMs = Math.round((data.start || 0) * 1000);
  const endMs = startMs + Math.round((data.duration || 0) * 1000);

  if (!data.is_final) {
    if (transcript) { liveContext.interim = transcript; renderLiveTranscript(); }
    return;
  }
  liveContext.interim = '';
  const segment = concatFloat32(liveContext.pendingChunks);
  liveContext.pendingChunks = [];
  if (!transcript) { renderLiveTranscript(); return; }

  const clusters = turnsFromClustering(alternative, transcript, startMs);
  const created = clusters.map((cluster) => pushLiveTurn({
    speaker: cluster.key,
    displaySpeaker: liveSpeakerName(cluster.key),
    text: cluster.text,
    start: cluster.start || startMs,
    end: cluster.end || endMs,
    confidence: alternative.confidence,
  }));

  if (voiceprints.length && clusters.length === 1 && segment.length > liveContext.sampleRate * 0.4) {
    const match = await identifyVoice(segment, liveContext.sampleRate);
    if (match && liveContext?.active) {
      const visitor = state.visitors.find((item) => item.id === match.personId) || null;
      const name = visitor?.name || match.name;
      liveContext.clusterNames.set(clusters[0].key, name);
      created[0].displaySpeaker = name;
      created[0].speaker = `voice-${match.id}`;
      created[0].voiceScore = Number(match.score.toFixed(3));
      if (visitor) created[0].visitorId = visitor.id;
      renderLiveTranscript();
    }
  }
}

async function openSpeechSocket(sampleRate) {
  const speechLanguage = state.settings.conversationLanguage || 'en';
  const language = speechLanguage === 'en' ? 'en-US' : speechLanguage;
  const connect = (socket, label) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    socket.onopen = () => { clearTimeout(timer); resolve({ socket, transport: label }); };
    socket.onerror = () => { clearTimeout(timer); resolve(null); };
  });

  try {
    const credential = await apiFetch('/api/live-key');
    if (credential.key) {
      const params = new URLSearchParams({
        model: credential.model || 'nova-2',
        language,
        smart_format: 'true',
        punctuate: 'true',
        diarize: 'true',
        interim_results: 'true',
        encoding: 'linear16',
        sample_rate: String(sampleRate),
        channels: '1',
      });
      const direct = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['token', credential.key]);
      direct.binaryType = 'arraybuffer';
      const opened = await connect(direct, 'direct');
      if (opened) return opened;
      try { direct.close(); } catch {}
      console.warn('Direct speech connection failed; falling back to the Meco relay.');
    }
  } catch (error) {
    console.warn('Speech credential unavailable:', error.message);
  }

  const token = await getToken();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const relayed = new WebSocket(`${protocol}//${location.host}/api/live-transcribe?rate=${sampleRate}&language=${encodeURIComponent(language)}`, ['meco-live', token]);
  relayed.binaryType = 'arraybuffer';
  const opened = await connect(relayed, 'relay');
  if (!opened) { try { relayed.close(); } catch {} }
  return opened;
}

async function startLiveConversation(stream) {
  if (!liveModeEnabled()) return false;
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state !== 'running') await audioCtx.resume().catch(() => {});
  const sampleRate = Math.round(audioCtx.sampleRate);

  const opened = await openSpeechSocket(sampleRate);
  if (!opened) {
    audioCtx.close().catch(() => {});
    return false;
  }
  const socket = opened.socket;

  liveContext = {
    socket, audioCtx, sampleRate, stream,
    transport: opened.transport,
    processor: null, source: null,
    turns: [], pendingChunks: [], interim: '',
    clusterNames: new Map(),
    active: true, ready: opened.transport === 'direct',
    audioSent: 0,
  };

  socket.onmessage = (event) => {
    let data;
    try { data = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }
    if (data.type === 'MecoReady') { liveContext.ready = true; return; }
    if (data.type === 'MecoError') { toast(data.error, 'error'); return; }
    if (data.type === 'Results') handleLiveResult(data);
  };
  socket.onclose = (event) => {
    if (liveContext?.active && !liveContext.stopping) {
      toast(`The live transcription connection closed (code ${event.code || 0}).`, 'error');
      const badge = $('#transcript-badge');
      if (badge) badge.textContent = liveContext.turns.length ? turnsLabel(liveContext.turns.length) : 'Disconnected';
    }
  };

  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  processor.onaudioprocess = (event) => {
    if (!liveContext?.active) return;
    const input = event.inputBuffer.getChannelData(0);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(floatToInt16(input).buffer);
      liveContext.audioSent += input.length;
    }
    if (voiceprints.length) liveContext.pendingChunks.push(new Float32Array(input));

    let peak = 0;
    for (let i = 0; i < input.length; i += 1) { const value = Math.abs(input[i]); if (value > peak) peak = value; }
    if (peak > 0.01) liveContext.heardAudio = true;
  };
  source.connect(processor);
  processor.connect(silent);
  silent.connect(audioCtx.destination);
  liveContext.source = source;
  liveContext.processor = processor;

  setTimeout(() => {
    if (liveContext?.active && !liveContext.heardAudio && !liveContext.turns.length) {
      toast('Meco is connected but hearing silence. Check that the right microphone is selected and unmuted.', 'error');
    }
  }, 6000);
  return true;
}

function stopLiveConversation() {
  if (!liveContext) return [];
  const turns = liveContext.turns.filter((turn) => String(turn.text || '').trim());
  liveContext.stopping = true;
  liveContext.active = false;
  liveContext.interim = '';
  try { if (liveContext.processor) { liveContext.processor.onaudioprocess = null; liveContext.processor.disconnect(); } } catch {}
  try { liveContext.source?.disconnect(); } catch {}
  try {
    if (liveContext.socket?.readyState === WebSocket.OPEN) {
      liveContext.socket.send(JSON.stringify({ type: 'CloseStream' }));
      liveContext.socket.close();
    }
  } catch {}
  liveContext.audioCtx?.close?.().catch(() => {});
  liveContext = null;
  return turns;
}

async function finishLiveConversation() {
  if (!liveContext) return [];
  const session = liveContext;
  session.stopping = true;
  try { if (session.processor) { session.processor.onaudioprocess = null; session.processor.disconnect(); } } catch {}
  try { session.source?.disconnect(); } catch {}
  try {
    if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'CloseStream' }));
  } catch {}
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    session.socket?.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  await sleep(250);
  return stopLiveConversation();
}

function conversationLanguageOptions(selected) {
  return conversationLanguages.map((item) => `<option value="${item.code}" ${selected === item.code ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
}

function conversationLanguageRowMarkup(locked) {
  const disabled = locked ? 'disabled' : '';
  const translateHint = translationAvailable() ? '' : ', needs a translation key';
  const translateDisabled = locked || !translationAvailable() ? 'disabled' : '';
  return `<div class="form-grid conversation-lang-row"><div class="form-field"><label>Speech language</label><select id="speech-language" ${disabled}>${conversationLanguageOptions(state.settings.conversationLanguage)}</select></div><div class="form-field"><label>Translate to${translateHint}</label><select id="translation-language" ${translateDisabled}>${conversationLanguageOptions(state.settings.translationLanguage)}</select></div></div>`;
}

function wireConversationLanguageRow() {
  $('#speech-language').onchange = async (event) => {
    state.settings.conversationLanguage = event.target.value;
    await persistState(true);
  };
  const translationSelect = $('#translation-language');
  if (translationSelect && !translationSelect.disabled) {
    translationSelect.onchange = async (event) => {
      state.settings.translationLanguage = event.target.value;
      await persistState(true);
    };
  }
}

function patientOrientationMarkup() {
  const now = new Date();
  const dayLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = state.settings.patientName && state.settings.patientName !== 'Meco Member' ? `, ${state.settings.patientName}` : '';
  const next = sortedVisits().find((visit) => !dateParts(visit.date).isPast);
  const nextParts = next ? dateParts(next.date) : null;

  const nextWhen = nextParts ? (nextParts.isToday ? 'today' : nextParts.tag === 'Tomorrow' ? 'tomorrow' : `on ${nextParts.tag}`) : '';
  const nextLabel = next
    ? `${escapeHtml(next.visitorName || 'A visit')} ${escapeHtml(nextWhen)}${next.time ? ` at ${escapeHtml(next.time)}` : ''}`
    : 'Nothing scheduled right now';
  return `<div class="patient-orientation">
    <div class="patient-orientation-greeting"><small>TODAY IS</small><h2>${escapeHtml(dayLabel)}</h2><p>${escapeHtml(greeting)}${name}.</p></div>
    <div class="patient-orientation-next"><small>NEXT VISIT</small><p>${nextLabel}</p></div>
    <div class="patient-orientation-actions">
      <button type="button" id="browse-memories-btn" class="action-button">Browse memories</button>
      <button type="button" id="patient-help-btn" class="action-button danger">I need help</button>
    </div>
  </div>`;
}

function timeAgoShort(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function patientTodaysVisitorsNote() {
  const todays = sortedVisits().filter((v) => dateParts(v.date).isToday);
  if (todays.length <= 1) return '';
  return `Expected today: ${todays.map((v) => `${escapeHtml(v.visitorName || 'a visitor')}${v.time ? ` (${escapeHtml(v.time)})` : ''}`).join(', ')}`;
}

function patientRecentActivityNote() {
  const combined = [
    ...(state.cognitiveAttempts || []).map((a) => ({ at: a.at, label: 'a stimulation activity' })),
    ...(state.retrievalAttempts || []).map((a) => ({ at: a.at, label: 'a practice review' })),
  ].filter((a) => a.at).sort((a, b) => new Date(b.at) - new Date(a.at));
  const last = combined[0];
  return last ? `Last activity: ${last.label}, ${timeAgoShort(last.at)}` : '';
}

function patientQuickBarMarkup() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = state.settings.patientName && state.settings.patientName !== 'Meco Member' ? `, ${state.settings.patientName}` : '';
  const dayLabel = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const next = sortedVisits().find((visit) => !dateParts(visit.date).isPast);
  const nextParts = next ? dateParts(next.date) : null;
  const nextWhen = nextParts ? (nextParts.isToday ? 'today' : nextParts.tag === 'Tomorrow' ? 'tomorrow' : `on ${nextParts.tag}`) : '';
  const nextBit = next ? ` · ${escapeHtml(next.visitorName || 'A visit')} ${escapeHtml(nextWhen)}${next.time ? ` at ${escapeHtml(next.time)}` : ''}` : '';
  const orientationExtra = [patientTodaysVisitorsNote(), patientRecentActivityNote()].filter(Boolean).join(' · ');
  const activeMood = state.moodCheckIns?.[0];
  const activeMoodMeta = activeMood ? journalMoods.find((mood) => mood.key === activeMood.mood) : null;
  const calmingOn = Boolean(calmingAudio?.kind) && calmingAudio.kind !== 'off';
  return `<div class="patient-quickbar">
    <button type="button" class="quickbar-back" id="exit-patient" aria-label="Return to caregiver">←</button>
    <div class="quickbar-greeting"><b>${escapeHtml(greeting)}${name}</b><small>${escapeHtml(dayLabel)}${nextBit}</small>${orientationExtra ? `<small class="quickbar-orientation-extra">${orientationExtra}</small>` : ''}</div>
    <div class="quickbar-actions">
      <button type="button" class="quickbar-icon-btn" id="mood-popover-toggle" aria-label="How are you feeling?" title="How are you feeling?">${activeMoodMeta ? activeMoodMeta.glyph : '◎'}</button>
      <button type="button" class="quickbar-icon-btn${calmingOn ? ' active' : ''}" id="calming-popover-toggle" aria-label="Calming sound" title="Calming sound">♪</button>
      <button type="button" class="quickbar-icon-btn" id="browse-memories-btn" aria-label="Browse memories" title="Browse memories">▤</button>
      <button type="button" class="quickbar-icon-btn" id="patient-activities-btn" aria-label="Activities" title="Activities">✳</button>
      <button type="button" class="quickbar-icon-btn danger" id="patient-help-btn" aria-label="I need help" title="I need help">✚</button>
    </div>
    <div class="patient-popover hidden" id="mood-popover">${moodCheckInMarkup()}</div>
    <div class="patient-popover hidden" id="calming-popover">${calmingSoundCardMarkup()}</div>
  </div>`;
}

function wirePatientQuickBar(content) {
  const pairs = [['mood-popover-toggle', 'mood-popover'], ['calming-popover-toggle', 'calming-popover']];
  pairs.forEach(([toggleId, popoverId]) => {
    const toggle = content.querySelector(`#${toggleId}`);
    const popover = content.querySelector(`#${popoverId}`);
    if (!toggle || !popover) return;
    toggle.onclick = (event) => {
      event.stopPropagation();
      const willOpen = popover.classList.contains('hidden');
      content.querySelectorAll('.patient-popover').forEach((p) => p.classList.add('hidden'));
      if (willOpen) popover.classList.remove('hidden');
    };
  });
}

function moodCheckInMarkup() {
  const latest = state.moodCheckIns?.[0];
  const latestMeta = latest ? journalMoods.find((mood) => mood.key === latest.mood) : null;
  return `<div class="mood-checkin-strip">
    <div class="mood-checkin-head">
      <span>How are you feeling right now?</span>
      ${latestMeta ? `<small>Last check-in: ${latestMeta.glyph} ${escapeHtml(latestMeta.label)} · ${timeAgoShort(latest.createdAt)}</small>` : ''}
    </div>
    <div class="mood-checkin-options">
      ${journalMoods.map((mood) => `<button type="button" class="mood-checkin-chip" data-mood-checkin="${mood.key}" title="${escapeHtml(mood.label)}" aria-label="${escapeHtml(mood.label)}"><span class="mood-checkin-glyph">${mood.glyph}</span><span class="mood-checkin-label">${escapeHtml(mood.label)}</span></button>`).join('')}
    </div>
  </div>`;
}

async function logMoodCheckIn(moodKey, container) {
  const meta = journalMoods.find((mood) => mood.key === moodKey);
  if (!meta) return;
  state.moodCheckIns = [{ id: `mood_${Date.now()}`, mood: moodKey, createdAt: new Date().toISOString() }, ...(state.moodCheckIns || [])].slice(0, 200);
  const strip = container?.querySelector('.mood-checkin-strip');
  if (strip) strip.outerHTML = moodCheckInMarkup();
  wireMoodCheckIn(container);
  const toggleIcon = container?.querySelector('#mood-popover-toggle');
  if (toggleIcon) toggleIcon.textContent = meta.glyph;
  const responses = {
    happy: "I'm glad you're feeling happy.",
    calm: "That's good, glad you're feeling calm.",
    okay: 'Thanks for letting me know.',
    tired: "Thanks for telling me. It's alright to rest.",
    anxious: "Thank you for sharing that. You're safe here.",
    sad: "I'm sorry you're feeling sad. You're not alone.",
  };
  speakText(responses[moodKey] || 'Thanks for letting me know.');
  try { await persistState(false); } catch {  }
}

function wireMoodCheckIn(container) {
  container?.querySelectorAll('[data-mood-checkin]').forEach((button) => {
    button.onclick = () => logMoodCheckIn(button.dataset.moodCheckin, container);
  });
}

let calmingAudio = null;

const CALMING_SOUNDS = [
  { id: 'off', label: 'Off', chip: 'Off' },
  { id: 'rain', label: 'Gentle rain', chip: 'Rain' },
  { id: 'ocean', label: 'Ocean waves', chip: 'Ocean' },
  { id: 'pad', label: 'Soft piano pad', chip: 'Soft pad' },
  { id: 'forest', label: 'Forest breeze', chip: 'Forest' },
  { id: 'hum', label: 'Warm hum', chip: 'Warm hum' },
];

function makeNoiseBuffer(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function stopCalmingSound() {
  if (!calmingAudio) return;
  const dead = calmingAudio;
  calmingAudio = null;
  try {
    const now = dead.ctx.currentTime;
    dead.master.gain.cancelScheduledValues(now);
    dead.master.gain.setValueAtTime(dead.master.gain.value, now);
    dead.master.gain.linearRampToValueAtTime(0, now + 0.7);
  } catch {}
  setTimeout(() => { try { dead.ctx.close(); } catch {} }, 800);
}

function setCalmingVolume(volume) {
  if (!calmingAudio) return;
  try {
    const now = calmingAudio.ctx.currentTime;
    calmingAudio.master.gain.cancelScheduledValues(now);
    calmingAudio.master.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, volume)) * 0.55, now + 0.15);
  } catch {}
}

function startCalmingSound(kind, volume = 0.5) {
  stopCalmingSound();
  if (!kind || kind === 'off') return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const master = ctx.createGain();
  const target = Math.max(0, Math.min(1, volume)) * 0.55;
  master.gain.value = 0;
  master.connect(ctx.destination);
  master.gain.linearRampToValueAtTime(target, ctx.currentTime + 1.4);

  if (kind === 'rain' || kind === 'ocean') {
    const noise = ctx.createBufferSource();
    noise.buffer = makeNoiseBuffer(ctx, 4);
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = kind === 'rain' ? 950 : 480;
    filter.Q.value = 0.6;
    noise.connect(filter);
    filter.connect(master);
    if (kind === 'ocean') {

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.09;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 220;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();
    }
    noise.start();
  } else if (kind === 'pad') {

    [130.81, 164.81, 196.0].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = (i - 1) * 4;
      const tremolo = ctx.createOscillator();
      tremolo.frequency.value = 0.05 + i * 0.02;
      const tremoloGain = ctx.createGain();
      tremoloGain.gain.value = 0.12;
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 0.28;
      tremolo.connect(tremoloGain);
      tremoloGain.connect(voiceGain.gain);
      osc.connect(voiceGain);
      voiceGain.connect(master);
      osc.start();
      tremolo.start();
    });
  } else if (kind === 'forest') {

    const noise = ctx.createBufferSource();
    noise.buffer = makeNoiseBuffer(ctx, 4);
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 0.5;
    const sway = ctx.createGain();
    sway.gain.value = 0.75;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain);
    lfoGain.connect(sway.gain);
    noise.connect(filter);
    filter.connect(sway);
    sway.connect(master);
    lfo.start();
    noise.start();
  } else if (kind === 'hum') {

    [65.41, 130.81].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = i === 0 ? 0.5 : 0.18;
      osc.connect(voiceGain);
      voiceGain.connect(master);
      osc.start();
    });
  }
  calmingAudio = { ctx, master, kind };
}

function calmingSoundCardMarkup() {
  const activeKind = calmingAudio?.kind || 'off';
  const chips = CALMING_SOUNDS.map((sound) => `<button type="button" class="calming-chip${activeKind === sound.id ? ' active' : ''}" data-calm="${sound.id}">${sound.chip}</button>`).join('');
  return `<div class="calming-popover-body">
    <div class="card-head"><h2>Calming sound</h2><span id="calming-status" class="badge">${activeKind === 'off' ? 'Off' : 'Playing'}</span></div>
    <p class="calming-hint">Lyric-free ambient sound to leave playing quietly during the visit.</p>
    <div class="calming-options" role="group" aria-label="Choose a calming sound">${chips}</div>
    <div class="calming-volume-row"><label for="calming-volume">Volume</label><input type="range" id="calming-volume" min="0" max="100" value="50"></div>
  </div>`;
}

function wireCalmingSoundCard(content) {
  const status = content.querySelector('#calming-status');
  const volumeInput = content.querySelector('#calming-volume');
  content.querySelectorAll('.calming-chip').forEach((btn) => {
    btn.onclick = () => {
      const kind = btn.dataset.calm;
      startCalmingSound(kind, Number(volumeInput?.value || 50) / 100);
      content.querySelectorAll('.calming-chip').forEach((b) => b.classList.toggle('active', b === btn));
      if (status) status.textContent = kind === 'off' ? 'Off' : 'Playing';
      content.querySelector('#calming-popover-toggle')?.classList.toggle('active', kind !== 'off');
    };
  });
  if (volumeInput) volumeInput.oninput = () => setCalmingVolume(Number(volumeInput.value) / 100);
}

let memoriesBrowseActive = false;

let patientActivitiesActive = false;
let patientActivitiesTab = 'stimulation';
let patientActiveTab = 'camera';

const PATIENT_TABS = [
  { key: 'camera', label: 'Camera' },
  { key: 'conversation', label: 'Conversation' },
  { key: 'report', label: 'Report' },
];

function renderPatient(content) {
  if (companionSession) { renderCompanionChat(content); return; }
  if (journalDraft) { renderJournalComposer(content); return; }
  if (memoriesBrowseActive) { renderMemoriesBrowse(content); return; }
  if (patientActivitiesActive) { renderPatientActivities(content); return; }

  const capturing = Boolean(liveContext) || patientContext?.recorder?.state === 'recording';
  if (!capturing) patientContext = { stream: null, audioStream: null, recorder: null, chunks: [], blob: null, visitor: null, transcript: [], summary: null, startedAt: null, matchStreak: {}, scanning: false, busy: false };

  content.classList.add('app-content-fixed');
  content.innerHTML = `${patientQuickBarMarkup()}
    <div class="patient-page${state.settings.elderMode ? ' elder-mode' : ''}">
      <div class="patient-tabset">
        <div class="patient-tabset-bar" role="tablist">
          ${PATIENT_TABS.map((tab) => `<button type="button" class="patient-tabset-btn${patientActiveTab === tab.key ? ' active' : ''}" data-patient-tab="${tab.key}" role="tab" aria-selected="${patientActiveTab === tab.key}">${tab.label}</button>`).join('')}
        </div>
        <div class="patient-tabset-panels">
          <div class="patient-tabset-panel${patientActiveTab === 'camera' ? ' active' : ''}" data-patient-panel="camera">
            <article class="app-card patient-camera-card"><video id="patient-video" class="patient-video" autoplay muted playsinline></video><div class="patient-overlay"><div class="patient-status-row"><span class="scan-status"><i></i><span id="scan-text">Camera is off</span></span><span id="record-status" class="scan-status hidden"><span class="recording-dot"></span><span>Recording visit</span></span></div><div class="face-guide"></div><div class="patient-bottom"><div id="matched-card" class="matched-card"><h3>Ready when you are</h3><p>Start the camera. Meco will look only for enrolled trusted people.</p></div><div class="patient-controls"><button id="start-patient-camera" class="action-button">Start camera</button><button id="start-recording" class="action-button primary">Record visit</button><button id="stop-recording" class="action-button" disabled>Stop recording</button><button id="save-visit" class="action-button" disabled>Save visit</button></div></div></div></article>
          </div>
          <div class="patient-tabset-panel${patientActiveTab === 'conversation' ? ' active' : ''}" data-patient-panel="conversation">
            <article class="app-card transcript-card"><div class="card-head"><h2>Conversation</h2><span id="transcript-badge" class="badge">Waiting</span></div>${conversationLanguageRowMarkup(capturing)}<div id="transcript-scroll" class="transcript-scroll"><div class="empty-state"><p>${liveModeEnabled() ? 'Speaker-labelled turns appear here live while the visit is recorded.' : 'AssemblyAI speaker-labelled turns will appear here after the recording.'}</p></div></div></article>
          </div>
          <div class="patient-tabset-panel${patientActiveTab === 'report' ? ' active' : ''}" data-patient-panel="report">
            <article class="app-card"><div class="card-head"><h2>Visit report</h2></div><div id="live-summary"><p>Generate the report after a transcript is ready.</p></div><div class="action-row" style="margin-top:18px"><button id="generate-summary" class="action-button primary" disabled>Generate AI report</button><button id="download-transcript" class="action-button" disabled>Download .txt</button><button id="save-session" class="action-button" disabled>Save visit</button></div></article>
          </div>
        </div>
      </div>
    </div>`;
  loadVoiceprints();
  enhanceSelectsIn(content);
  wireConversationLanguageRow();
  wireCalmingSoundCard(content);
  wireMoodCheckIn(content);
  wirePatientQuickBar(content);
  content.querySelectorAll('[data-patient-tab]').forEach((btn) => {
    btn.onclick = () => {
      patientActiveTab = btn.dataset.patientTab;
      content.querySelectorAll('[data-patient-tab]').forEach((b) => { b.classList.toggle('active', b === btn); b.setAttribute('aria-selected', String(b === btn)); });
      content.querySelectorAll('[data-patient-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.patientPanel === patientActiveTab));
    };
  });
  $('#exit-patient').onclick = () => { stopCalmingSound(); navigateApp('overview'); };
  $('#browse-memories-btn').onclick = () => { memoriesBrowseActive = true; renderPatient(content); };
  $('#patient-activities-btn').onclick = () => { patientActivitiesActive = true; renderPatient(content); };
  $('#patient-help-btn').onclick = () => triggerPatientSOS();
  $('#start-patient-camera').onclick = startPatientCamera;
  $('#start-recording').onclick = startPatientRecording;
  $('#stop-recording').onclick = stopPatientRecording;
  $('#save-visit').onclick = saveVisitNow;
  $('#generate-summary').onclick = generatePatientSummary;
  $('#download-transcript').onclick = () => downloadTranscript({
    visitorName: patientContext.visitor?.name || 'Unrecognized visitor',
    relationship: patientContext.visitor?.relationship || '',
    startedAt: patientContext.startedAt,
    transcript: patientContext.transcript,
  });
  $('#save-session').onclick = saveVisitNow;
  if (capturing) restorePatientCaptureUi();
  else if (patientContext.transcript?.length) {
    renderEditableTranscript();
    $('#transcript-badge').textContent = turnsLabel(patientContext.transcript.length);
    enableTranscriptActions();
  }
}

async function triggerPatientSOS() {
  state.sosEvents = [{ id: `sos_${Date.now()}`, createdAt: new Date().toISOString(), acknowledged: false }, ...(state.sosEvents || [])].slice(0, 50);
  const card = document.getElementById('matched-card');
  if (card) {
    card.innerHTML = '<h3>Help is on the way</h3><p>Your caregiver will see this the next time they open Meco. You are safe, take a breath.</p>';
    card.classList.add('sos-active');
  }
  speakText('Your caregiver will see this. You are safe.');
  toast('A caregiver alert was saved.', 'success');
  try { await persistState(); } catch {  }
}

function unacknowledgedSosEvents() {
  return (state.sosEvents || []).filter((event) => !event.acknowledged);
}

function sosAlertBannerMarkup() {
  const pending = unacknowledgedSosEvents();
  if (!pending.length) return '';
  const latest = pending[0];
  return `<div class="flagged-alert-banner sos" role="alert">
    <span class="flagged-alert-icon">✳</span>
    <div class="flagged-alert-copy"><b>Help was requested in Patient mode</b><p>${escapeHtml(formatDate(latest.createdAt))}${pending.length > 1 ? ` · ${pending.length} requests` : ''}</p></div>
    <button class="action-button" id="ack-sos">Mark as seen</button>
  </div>`;
}

function wireSosAlertBanner(content) {
  content.querySelector('#ack-sos')?.addEventListener('click', async () => {
    state.sosEvents.forEach((event) => { event.acknowledged = true; });
    await persistState(true);
    renderOverview(content);
  });
}

function renderMemoriesBrowse(content) {
  const people = state.visitors || [];
  content.innerHTML = `${pageHead('Browse memories', 'Familiar faces and the stories that go with them.', '<button class="action-button" id="exit-memories">← Back</button>')}
    <div class="memories-browse${state.settings.elderMode ? ' elder-mode' : ''}">
      ${people.length ? people.map((person) => {
        const youtubeId = youtubeIdFromUrl(person.songUrl);
        return `
        <article class="memory-browse-card">
          <div class="memory-browse-portrait">${person.thumbnail ? `<img src="${person.thumbnail}" alt="">` : escapeHtml(person.name[0] || '?')}</div>
          <h2>${escapeHtml(person.name)}</h2>
          <small>${escapeHtml(person.relationship || '')}</small>
          <p>${escapeHtml(person.memory || 'No memory cue added yet.')}</p>
          <button class="icon-button" data-read-memory="${escapeHtml(person.id)}" title="Read this aloud" aria-label="Read this memory aloud">◉</button>
          ${youtubeId ? `<div class="memory-song" data-song-id="${escapeHtml(person.id)}"><button class="action-button primary" data-play-song="${escapeHtml(youtubeId)}">▶ Play ${escapeHtml(person.songTitle || 'their song')}</button></div>` : ''}
        </article>`;
      }).join('') : `<div class="empty-state"><div><h3>No one enrolled yet</h3><p>Once a caregiver adds a trusted person, they'll show up here.</p></div></div>`}
    </div>`;
  $('#exit-memories').onclick = () => { memoriesBrowseActive = false; navigateApp('patient'); };
  $$('[data-play-song]').forEach((button) => button.addEventListener('click', () => {
    const wrap = button.closest('.memory-song');
    const videoId = button.dataset.playSong;
    wrap.innerHTML = `<iframe width="100%" height="200" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1" title="Familiar song" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
  }));
  $$('[data-read-memory]').forEach((button) => button.addEventListener('click', () => {
    const person = people.find((item) => item.id === button.dataset.readMemory);
    if (!person) return;
    const relationship = person.relationship ? `, your ${person.relationship.toLowerCase()}` : '';
    speakText(`${person.name}${relationship}. ${person.memory || ''}`);
  }));
}

function renderPatientActivities(content) {
  content.innerHTML = `${pageHead('Activities', 'Supportive exercises and reminiscence, not a treatment or diagnosis.', '<button class="action-button" id="exit-patient-activities">← Back</button>')}
    <div class="patient-page">
      ${contentTabsMarkup([{ key: 'stimulation', label: '✳ Stimulation' }, { key: 'reminiscence', label: '❖ Reminiscence' }, { key: 'practice', label: '↻ Practice' }], patientActivitiesTab)}
      <div id="patient-activities-panel" class="patient-activities-scroll"></div>
    </div>
    <p class="activities-disclaimer">A supportive activity, not a medical treatment or diagnosis.</p>`;
  wireContentTabs(content, (key) => { patientActivitiesTab = key; renderPatientActivities(content); });
  const panel = content.querySelector('#patient-activities-panel');
  if (patientActivitiesTab === 'reminiscence') renderReminiscencePanel(panel);
  else if (patientActivitiesTab === 'practice') renderPracticePanel(panel);
  else renderStimulationPanel(panel);
  content.querySelector('#exit-patient-activities').onclick = () => { patientActivitiesActive = false; renderPatient(content); };
}

function renderCompanionChat(content) {
  const micAvailable = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  content.innerHTML = `<div class="companion-chat-page${state.settings.elderMode ? ' elder-mode' : ''}">
    <div class="companion-chat-head">
      <div class="companion-chat-title"><strong>Meco</strong><small>Your companion</small></div>
      <div class="companion-chat-head-actions">
        <button id="toggle-companion-voice" type="button" class="companion-voice-toggle" aria-pressed="${companionVoiceMode ? 'true' : 'false'}">${companionVoiceMode ? 'Voice replies: On' : 'Voice replies: Off'}</button>
        <button id="end-companion-chat" class="pill-button dark">Done chatting</button>
      </div>
    </div>
    <div class="companion-chat-scroll" id="companion-chat-scroll"></div>
    <form id="companion-chat-form" class="companion-chat-form">
      ${micAvailable ? '<button type="button" id="companion-mic-btn" class="companion-mic-btn" aria-label="Speak your message" title="Speak your message">◉</button>' : ''}
      <input id="companion-chat-input" type="text" placeholder="Type here…" autocomplete="off" maxlength="600" />
      <button type="submit" class="pill-button dark">Send</button>
    </form>
  </div>`;
  $('#end-companion-chat').onclick = () => endCompanionChat();
  $('#toggle-companion-voice').onclick = () => toggleCompanionVoiceMode();
  $('#companion-mic-btn')?.addEventListener('click', () => startCompanionListening());
  $('#companion-chat-form').onsubmit = (event) => {
    event.preventDefault();
    const input = $('#companion-chat-input');
    const text = input.value.trim();
    if (!text || companionSession.busy) return;
    input.value = '';
    sendCompanionMessage(text);
  };
  if (!companionSession.messages.length) {
    const greeting = buildCompanionGreeting();
    pushCompanionMessage(greeting, 'assistant');
    if (companionVoiceMode) speakText(greeting);
  } else {
    renderCompanionMessages();
  }
}

let companionVoiceMode = false;

function toggleCompanionVoiceMode() {
  companionVoiceMode = !companionVoiceMode;
  const button = $('#toggle-companion-voice');
  if (button) {
    button.textContent = companionVoiceMode ? 'Voice replies: On' : ' Voice replies: Off';
    button.setAttribute('aria-pressed', companionVoiceMode ? 'true' : 'false');
  }
  if (companionVoiceMode) {
    const lastReply = companionSession?.messages.filter((m) => m.role === 'assistant').slice(-1)[0];
    if (lastReply) speakText(lastReply.text);
  } else {
    window.speechSynthesis?.cancel();
  }
}

function startCompanionListening() {
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) return toast('Voice input is not supported in this browser.', 'error');
  const micButton = $('#companion-mic-btn');
  if (!micButton || micButton.classList.contains('listening')) return;
  const recognition = new SpeechRecognitionCtor();
  recognition.lang = state.settings.conversationLanguage === 'en' ? 'en-US' : (state.settings.conversationLanguage || 'en-US');
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  micButton.classList.add('listening');
  micButton.textContent = '●';
  micButton.setAttribute('aria-label', 'Listening…');
  recognition.onresult = (event) => {
    const transcript = event.results[0]?.[0]?.transcript?.trim();
    if (transcript && companionSession && !companionSession.busy) sendCompanionMessage(transcript);
  };
  recognition.onerror = () => toast("Didn't catch that, try again, or type instead.", 'error');
  recognition.onend = () => {
    micButton.classList.remove('listening');
    micButton.textContent = '◉';
    micButton.setAttribute('aria-label', 'Speak your message');
  };
  recognition.start();
}

function buildCompanionGreeting() {
  const name = state.settings.patientName && state.settings.patientName !== 'Meco Member' ? `, ${state.settings.patientName}` : '';
  const withMemory = (state.visitors || []).filter((v) => v.memory?.trim());
  if (!withMemory.length) return `Hello${name}! I'm really glad to spend some time with you. How are you feeling today?`;
  const chatCount = (state.companionChats || []).length;
  const visitor = withMemory[chatCount % withMemory.length];
  const relationship = visitor.relationship ? ` (your ${visitor.relationship.toLowerCase()})` : '';
  return `Hello${name}! I remember you mentioning ${visitor.name}${relationship}, "${visitor.memory.trim()}" Would you like to tell me more about that?`;
}

function pushCompanionMessage(text, role) {
  companionSession.messages.push({ role, text, at: new Date().toISOString() });
  renderCompanionMessages();
}

function renderCompanionMessages() {
  const scroll = $('#companion-chat-scroll');
  if (!scroll || !companionSession) return;
  const bubbles = companionSession.messages.map((m) => `<div class="companion-bubble ${m.role === 'assistant' ? 'ai' : 'patient'}"><p>${escapeHtml(m.text)}</p></div>`).join('');
  const typing = companionSession.busy ? '<div class="companion-bubble ai companion-typing"><span></span><span></span><span></span></div>' : '';
  scroll.innerHTML = bubbles + typing;
  scroll.scrollTop = scroll.scrollHeight;
}

const companionHistoryShortDate = (value) => value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)) : '';
const companionHistoryTruncate = (text, max) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean;
};
const COMPANION_HISTORY_BUDGET = 14000;

function buildCompanionHistoryDigest() {
  const sections = [];

  const withMemory = (state.visitors || []).filter((v) => v.memory?.trim());
  if (withMemory.length) {
    sections.push(`People they know, with a caregiver-written memory cue for each (useful for gentle reminiscence, inviting them to recall a specific positive memory, not just for identifying who's who):\n${withMemory.map((v) => `- ${v.name}${v.relationship ? ` (${v.relationship})` : ''}: "${v.memory.trim()}"`).join('\n')}`);
  }

  const allSessions = (state.sessions || []).slice().sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  if (allSessions.length) {
    sections.push(`Recorded visits and conversations (every visit that's been captured, most recent first):\n${allSessions.map((s) => {
      const who = s.visitorName || 'someone';
      const relationship = s.relationship ? ` (${s.relationship})` : '';
      const tone = s.summary?.emotionalTone ? `, mood: ${s.summary.emotionalTone}` : '';
      const detail = s.summary?.summary
        ? companionHistoryTruncate(s.summary.summary, 180)
        : companionHistoryTruncate((s.transcript || []).map((line) => line.text).filter(Boolean).join(' '), 180);
      return `- ${companionHistoryShortDate(s.startedAt)}: ${who}${relationship}${tone}${detail ? `, ${detail}` : ''}`;
    }).join('\n')}`);
  }

  const allJournal = (state.journalEntries || []).slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  if (allJournal.length) {
    sections.push(`Journal entries, in their own words (most recent first):\n${allJournal.map((entry) => {
      const mood = journalMoodMeta(entry.mood).label.toLowerCase();
      return `- ${companionHistoryShortDate(entry.createdAt)} (feeling ${mood}): ${companionHistoryTruncate(entry.text, 180)}`;
    }).join('\n')}`);
  }

  const allVisits = (state.visits || []).slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  if (allVisits.length) {
    sections.push(`Scheduled visits (past and upcoming):\n${allVisits.map((v) => `- ${v.date}${v.time ? ` ${v.time}` : ''}: ${v.visitorName || 'a visit'}${v.note ? `, ${companionHistoryTruncate(v.note, 100)}` : ''}`).join('\n')}`);
  }

  const allReminders = (state.reminders || []).slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  if (allReminders.length) {
    sections.push(`Reminders:\n${allReminders.map((r) => `- ${r.date}${r.time ? ` ${r.time}` : ''}: ${companionHistoryTruncate(r.text, 100)}${r.done ? ' (done)' : ''}`).join('\n')}`);
  }

  const allChats = (state.companionChats || []).filter((chat) => chat.id !== companionSession?.id).slice().sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  if (allChats.length) {
    sections.push(`Past conversations with you (Meco):\n${allChats.map((c) => `- ${companionHistoryShortDate(c.startedAt)}: ${c.analysis?.note ? companionHistoryTruncate(c.analysis.note, 180) : 'a casual chat'}`).join('\n')}`);
  }

  return sections.join('\n\n').slice(0, COMPANION_HISTORY_BUDGET);
}

async function sendCompanionMessage(text) {
  pushCompanionMessage(text, 'user');
  companionSession.busy = true;
  renderCompanionMessages();
  try {
    const result = await apiFetch('/api/companion/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientName: state.settings.patientName,
        messages: companionSession.messages.map((m) => ({ role: m.role, text: m.text })),
        history: buildCompanionHistoryDigest(),
      }),
    });
    if (!companionSession) return;
    companionSession.busy = false;
    pushCompanionMessage(result.text, 'assistant');
    if (companionVoiceMode) speakText(result.text);
  } catch (error) {
    if (!companionSession) return;
    companionSession.busy = false;
    const fallback = "I'm having a little trouble right now, but I'm still here with you.";
    pushCompanionMessage(fallback, 'assistant');
    if (companionVoiceMode) speakText(fallback);
  }
}

async function endCompanionChat() {
  if (!companionSession) return;
  const hasReply = companionSession.messages.some((m) => m.role === 'user');
  if (!hasReply) { companionSession = null; navigateApp('companion'); return; }
  const chat = {
    id: companionSession.id,
    title: '',
    startedAt: companionSession.startedAt,
    endedAt: new Date().toISOString(),
    messages: companionSession.messages.map(({ role, text, at }) => ({ role, text, at })),
  };
  toast('Saving your chat…');
  try {
    chat.analysis = await apiFetch('/api/companion/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientName: state.settings.patientName, messages: chat.messages }),
    });
  } catch (error) {
    chat.analysis = null;
  }
  state.companionChats = [chat, ...(state.companionChats || [])].slice(0, 60);
  await persistState(true);
  if (chat.analysis?.flagged) triggerFlaggedChatAlert(chat);
  companionSession = null;
  navigateApp('companion');
  refreshCompanionOverview();
}

const JOURNAL_ALLOWED_TAGS = new Set(['P', 'DIV', 'BR', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'STRONG', 'B', 'EM', 'I', 'U', 'SPAN']);

const JOURNAL_DISCARD_TAGS = new Set(['SCRIPT', 'STYLE']);
const JOURNAL_FONT_SIZES = ['14px', '16px', '20px', '26px'];

function sanitizeJournalHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const clean = (parent) => {
    [...parent.childNodes].forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) return;
      if (node.nodeType !== Node.ELEMENT_NODE) { parent.removeChild(node); return; }
      if (JOURNAL_DISCARD_TAGS.has(node.tagName)) { parent.removeChild(node); return; }
      if (!JOURNAL_ALLOWED_TAGS.has(node.tagName)) {
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
        return;
      }
      const style = node.getAttribute('style') || '';
      [...node.attributes].forEach((attr) => node.removeAttribute(attr.name));
      const alignMatch = /text-align:\s*(left|center|right)/i.exec(style);
      const sizeMatch = new RegExp(`font-size:\\s*(${JOURNAL_FONT_SIZES.join('|')})`, 'i').exec(style);
      const rebuilt = [alignMatch && `text-align:${alignMatch[1].toLowerCase()}`, sizeMatch && `font-size:${sizeMatch[1].toLowerCase()}`].filter(Boolean).join(';');
      if (rebuilt) node.setAttribute('style', rebuilt);
      clean(node);
    });
  };
  clean(template.content);

  return template.innerHTML.replace(/\u200B/g, '');
}

function journalCurrentBlock(editor) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  let node = selection.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  while (node && node !== editor && !/^(P|DIV|H2|H3|LI|BLOCKQUOTE)$/.test(node.tagName)) node = node.parentElement;
  return node === editor ? null : node;
}

function journalToggleBlock(editor, tag) {
  const block = journalCurrentBlock(editor);
  document.execCommand('formatBlock', false, block?.tagName === tag ? 'p' : tag.toLowerCase());
}

function journalSetAlign(editor, align) {
  let block = journalCurrentBlock(editor);
  if (!block) {
    document.execCommand('formatBlock', false, 'p');
    block = journalCurrentBlock(editor);
  }
  if (block) block.style.textAlign = align;
}

function journalWrapSelection(tagName, styleAttr = '') {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const wrapper = document.createElement(tagName);
  if (styleAttr) wrapper.setAttribute('style', styleAttr);
  if (selection.isCollapsed) {
    wrapper.appendChild(document.createTextNode('\u200B'));
    range.insertNode(wrapper);
    const caret = document.createRange();
    caret.setStart(wrapper.firstChild, 1);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    return;
  }
  try {
    range.surroundContents(wrapper);
  } catch {
    wrapper.appendChild(range.cloneContents());
    range.deleteContents();
    range.insertNode(wrapper);
  }
  selection.removeAllRanges();
  const after = document.createRange();
  after.selectNodeContents(wrapper);
  selection.addRange(after);
}

function journalToggleInlineCode() {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  let node = selection.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const existing = node?.closest?.('code');
  if (existing) {
    const parent = existing.parentNode;
    while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    parent.removeChild(existing);
  } else {
    journalWrapSelection('code');
  }
}

const journalIcons = {
  bullet: '<svg viewBox="0 0 20 14" width="18" height="14" fill="currentColor"><circle cx="1.5" cy="1.5" r="1.5"/><rect x="6" y="0.4" width="14" height="2.2" rx="1.1"/><circle cx="1.5" cy="7" r="1.5"/><rect x="6" y="5.9" width="14" height="2.2" rx="1.1"/><circle cx="1.5" cy="12.5" r="1.5"/><rect x="6" y="11.4" width="14" height="2.2" rx="1.1"/></svg>',
  quote: '<svg viewBox="0 0 20 14" width="16" height="14" fill="currentColor"><path d="M2 8V4.6C2 2.1 3.9 0.5 6.2 0.5V2.4C4.8 2.4 4 3.2 4 4.5V5.1H6.2V8H2Z"/><path d="M10.8 8V4.6C10.8 2.1 12.7 0.5 15 0.5V2.4C13.6 2.4 12.8 3.2 12.8 4.5V5.1H15V8H10.8Z"/></svg>',
  alignLeft: '<svg viewBox="0 0 20 14" width="18" height="14" fill="currentColor"><rect width="20" height="2.2" rx="1.1"/><rect y="4" width="13" height="2.2" rx="1.1"/><rect y="8" width="20" height="2.2" rx="1.1"/><rect y="11.8" width="13" height="2.2" rx="1.1"/></svg>',
  alignCenter: '<svg viewBox="0 0 20 14" width="18" height="14" fill="currentColor"><rect width="20" height="2.2" rx="1.1"/><rect x="3.5" y="4" width="13" height="2.2" rx="1.1"/><rect width="20" y="8" height="2.2" rx="1.1"/><rect x="3.5" y="11.8" width="13" height="2.2" rx="1.1"/></svg>',
  alignRight: '<svg viewBox="0 0 20 14" width="18" height="14" fill="currentColor"><rect width="20" height="2.2" rx="1.1"/><rect x="7" y="4" width="13" height="2.2" rx="1.1"/><rect width="20" y="8" height="2.2" rx="1.1"/><rect x="7" y="11.8" width="13" height="2.2" rx="1.1"/></svg>',
};

const journalToolbarGroups = [
  [
    { cmd: 'bold', label: 'Bold', symbol: '<b>B</b>' },
    { cmd: 'italic', label: 'Italic', symbol: '<i>I</i>' },
    { cmd: 'underline', label: 'Underline', symbol: '<u>U</u>' },
    { cmd: 'code', label: 'Inline code', symbol: '<code>&lt;/&gt;</code>' },
  ],
  [
    { cmd: 'heading2', label: 'Heading', symbol: 'H2' },
    { cmd: 'heading3', label: 'Subheading', symbol: 'H3' },
    { cmd: 'quote', label: 'Quote', symbol: journalIcons.quote },
  ],
  [
    { cmd: 'bullet', label: 'Bullet list', symbol: journalIcons.bullet },
    { cmd: 'number', label: 'Numbered list', symbol: '1.' },
  ],
  [
    { cmd: 'align-left', label: 'Align left', symbol: journalIcons.alignLeft },
    { cmd: 'align-center', label: 'Align center', symbol: journalIcons.alignCenter },
    { cmd: 'align-right', label: 'Align right', symbol: journalIcons.alignRight },
  ],
  [
    { cmd: 'size-s', label: 'Small text', symbol: '<span style="font-size:11px">A</span>' },
    { cmd: 'size-m', label: 'Normal text', symbol: '<span style="font-size:14px">A</span>' },
    { cmd: 'size-l', label: 'Large text', symbol: '<span style="font-size:17px">A</span>' },
    { cmd: 'size-xl', label: 'Extra large text', symbol: '<span style="font-size:20px">A</span>' },
  ],
];

function runJournalCommand(cmd, editor) {
  editor.focus();
  const fontSizeByCmd = { 'size-s': JOURNAL_FONT_SIZES[0], 'size-m': JOURNAL_FONT_SIZES[1], 'size-l': JOURNAL_FONT_SIZES[2], 'size-xl': JOURNAL_FONT_SIZES[3] };
  if (cmd === 'bold') document.execCommand('bold');
  else if (cmd === 'italic') document.execCommand('italic');
  else if (cmd === 'underline') document.execCommand('underline');
  else if (cmd === 'code') journalToggleInlineCode();
  else if (cmd === 'heading2') journalToggleBlock(editor, 'H2');
  else if (cmd === 'heading3') journalToggleBlock(editor, 'H3');
  else if (cmd === 'bullet') document.execCommand('insertUnorderedList');
  else if (cmd === 'number') document.execCommand('insertOrderedList');
  else if (cmd === 'quote') journalToggleBlock(editor, 'BLOCKQUOTE');
  else if (cmd === 'align-left') journalSetAlign(editor, 'left');
  else if (cmd === 'align-center') journalSetAlign(editor, 'center');
  else if (cmd === 'align-right') journalSetAlign(editor, 'right');
  else if (fontSizeByCmd[cmd]) journalWrapSelection('span', `font-size:${fontSizeByCmd[cmd]}`);
  journalDraft.html = editor.innerHTML;
  journalDraft.text = editor.innerText;
  updateJournalSaveState();
}

function renderJournalComposer(content) {
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'this morning' : hour < 18 ? 'this afternoon' : 'this evening';

  const toolbarMarkup = journalToolbarGroups.map((group) => `<span class="toolbar-group">${group.map((item) => `<button type="button" data-cmd="${item.cmd}" aria-label="${item.label}" title="${item.label}">${item.symbol}</button>`).join('')}</span>`).join('');
  content.innerHTML = `<div class="journal-composer-page${state.settings.elderMode ? ' elder-mode' : ''}">
    <div class="journal-composer-head">
      <div class="journal-composer-title"><strong>My journal</strong><small>${escapeHtml(formatJournalDate(new Date()))}</small></div>
      <button id="cancel-journal-entry" class="action-button">← Back</button>
    </div>
    <p class="journal-prompt">How are you feeling ${timeOfDay}? What happened today?</p>
    <div class="mood-picker">${journalMoods.map((mood) => `<button type="button" class="mood-chip mood-${mood.key}" data-mood="${mood.key}"><span class="mood-emoji">${mood.glyph}</span><span>${mood.label}</span></button>`).join('')}</div>
    <div class="journal-toolbar" role="toolbar" aria-label="Text formatting">${toolbarMarkup}</div>
    <div id="journal-editor" class="journal-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Journal entry" data-placeholder="Write as much or as little as you like…">${journalDraft.html || ''}</div>
    <div class="journal-composer-actions"><button id="save-journal-entry" class="pill-button dark" disabled>Save entry</button></div>
  </div>`;
  $('#cancel-journal-entry').onclick = () => { journalDraft = null; navigateApp('journal'); };
  $$('.mood-chip', content).forEach((chip) => {
    chip.onclick = () => {
      journalDraft.mood = chip.dataset.mood;
      $$('.mood-chip', content).forEach((other) => other.classList.toggle('selected', other === chip));
      updateJournalSaveState();
    };
  });
  const editor = $('#journal-editor');
  $$('[data-cmd]', content).forEach((button) => {

    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => runJournalCommand(button.dataset.cmd, editor));
  });
  editor.addEventListener('input', () => {
    journalDraft.html = editor.innerHTML;
    journalDraft.text = editor.innerText;
    updateJournalSaveState();
  });

  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = (event.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  $('#save-journal-entry').onclick = () => saveJournalEntry();
}

function updateJournalSaveState() {
  const button = $('#save-journal-entry');
  if (button) button.disabled = !(journalDraft?.mood && journalDraft?.text?.trim());
}

async function saveJournalEntry() {
  if (!journalDraft?.mood || !journalDraft.text?.trim()) return;
  const entry = {
    id: `journal_${Date.now()}`,
    title: '',
    mood: journalDraft.mood,
    html: sanitizeJournalHtml(journalDraft.html).slice(0, 20000),

    text: journalDraft.text.replace(/\u200B/g, '').trim().slice(0, 4000),
    createdAt: new Date().toISOString(),
  };
  toast('Saving your journal entry…');
  state.journalEntries = [entry, ...(state.journalEntries || [])].slice(0, 200);
  journalDraft = null;
  await persistState(true);
  navigateApp('journal');
}

const formatJournalDate = (value) => value ? new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(value)) : 'Not set';

const journalMoodMeta = (key) => journalMoods.find((mood) => mood.key === key) || journalMoods.find((mood) => mood.key === 'okay');

const journalEntryTitle = (entry) => entry?.title?.trim() || null;

function journalEntryRowMarkup(entry) {
  const meta = journalMoodMeta(entry.mood);
  const plain = (entry.text || '').trim();
  const preview = plain.length > 90 ? `${plain.slice(0, 90).trim()}…` : plain;
  return `<div class="journal-row" data-open-journal="${escapeHtml(entry.id)}" role="button" tabindex="0">
    <div class="person-avatar mood-avatar mood-${meta.key}">${meta.glyph}</div>
    <div class="row-copy"><b>${escapeHtml(journalEntryTitle(entry) || meta.label)}</b><small>${escapeHtml(formatDate(entry.createdAt))} · ${escapeHtml(preview)}</small></div>
    <div class="row-meta"><span class="badge">${escapeHtml(meta.label)}</span></div>
  </div>`;
}

function journalDetailMarkup(entry) {
  const meta = journalMoodMeta(entry.mood);
  const title = journalEntryTitle(entry);
  const eyebrow = `${meta.glyph} Feeling ${escapeHtml(meta.label.toLowerCase())}${title ? ` · ${escapeHtml(formatDate(entry.createdAt))}` : ''}`;
  return `<article class="app-card section-card journal-detail-card">
    <div class="detail-head">
      <div><p class="journal-detail-eyebrow">${eyebrow}</p><h2>${escapeHtml(title || formatJournalDate(entry.createdAt))}</h2>${title ? '' : `<small>${escapeHtml(formatDate(entry.createdAt))}</small>`}</div>
      <div class="action-row">
        <button class="action-button" data-read-journal="${escapeHtml(entry.id)}">Read aloud</button>
        <button class="action-button" data-rename-journal="${escapeHtml(entry.id)}">Rename</button>
        <button class="action-button danger" data-delete-journal="${escapeHtml(entry.id)}">Delete</button>
        <button class="action-button" id="back-to-journal">← Back</button>
      </div>
    </div>
    <div class="journal-detail-text">${sanitizeJournalHtml(entry.html || escapeHtml(entry.text || '').replace(/\n/g, '<br>'))}</div>
  </article>`;
}

function journalMoodTrendMarkup() {
  const chronological = (state.journalEntries || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (chronological.length < 3) return '';
  const dots = chronological.map((entry) => {
    const meta = journalMoodMeta(entry.mood);
    return `<span class="mood-dot mood-${meta.key}" title="${escapeHtml(formatDate(entry.createdAt))}, feeling ${escapeHtml(meta.label.toLowerCase())}"></span>`;
  }).join('');
  return `<article class="app-card section-card">
    <div class="card-head"><h2>Mood over time</h2><span class="badge">${chronological.length} entries</span></div>
    <div class="mood-trend-strip">${dots}</div>
    <div class="mood-trend-legend">${journalMoods.map((mood) => `<span class="mood-trend-legend-item"><span class="mood-dot mood-${mood.key}"></span>${escapeHtml(mood.label)}</span>`).join('')}</div>
  </article>`;
}

function renderJournal(content) {
  const entries = (state.journalEntries || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (journalView.mode === 'detail') {
    const entry = entries.find((item) => item.id === journalView.id);
    if (!entry) { journalView = { mode: 'list', id: null }; }
    else {
      content.innerHTML = `${pageHead('Journal', 'Feelings and happenings your Meco member has shared, in their own words.')}${journalDetailMarkup(entry)}`;
      $('#back-to-journal').onclick = () => { journalView = { mode: 'list', id: null }; renderJournal(content); };
      $('[data-rename-journal]').onclick = (event) => renameJournalEntry(event.currentTarget.dataset.renameJournal);
      $('[data-delete-journal]').onclick = (event) => deleteJournalEntry(event.currentTarget.dataset.deleteJournal);
      $('[data-read-journal]').onclick = () => speakText(entry.text || 'This entry has no text to read.');
      return;
    }
  }
  content.innerHTML = `${pageHead('Journal', 'Feelings and happenings your Meco member has shared, in their own words.', '<button class="action-button" id="start-journal-now">Write a new entry</button>')}
    ${journalMoodTrendMarkup()}
    <article class="app-card section-card">
      <div class="card-head"><h2>Entries</h2><span class="badge">${entries.length}</span></div>
      ${entries.length ? `<div class="session-list">${entries.map(journalEntryRowMarkup).join('')}</div>` : '<div class="empty-state"><div><h3>No entries yet</h3><p>Once your Meco member writes in their journal, entries will appear here.</p></div></div>'}
    </article>`;
  $('#start-journal-now').onclick = () => {

    companionSession = null;
    journalDraft = { mood: null, text: '' };
    navigateApp('patient');
  };
  $$('[data-open-journal]', content).forEach((row) => {
    const open = () => { journalView = { mode: 'detail', id: row.dataset.openJournal }; renderJournal(content); };
    row.onclick = open;
    row.onkeydown = (event) => { if (event.key === 'Enter') open(); };
  });
}

function renameJournalEntry(id) {
  const entry = (state.journalEntries || []).find((item) => item.id === id);
  if (!entry) return;
  const next = window.prompt('Name this entry', entry.title?.trim() || '');
  if (next === null) return;
  entry.title = next.trim().slice(0, 90);
  queueSave();
  renderJournal($('#app-content'));
}

async function deleteJournalEntry(id) {
  const entry = (state.journalEntries || []).find((item) => item.id === id);
  if (!entry || !confirm('Delete this journal entry? This cannot be undone.')) return;
  state.journalEntries = (state.journalEntries || []).filter((item) => item.id !== id);
  journalView = { mode: 'list', id: null };
  await persistState(true);
  renderJournal($('#app-content'));
}

const companionChatTitle = (chat) => chat?.title?.trim() || 'Conversation';

function renameCompanionChat(id) {
  const chat = (state.companionChats || []).find((item) => item.id === id);
  if (!chat) return;
  const next = window.prompt('Name this conversation', chat.title?.trim() || '');
  if (next === null) return;
  chat.title = next.trim().slice(0, 90);
  queueSave();
  renderCompanion($('#app-content'));
}

async function refreshCompanionOverview() {
  const reviewed = (state.companionChats || []).filter((chat) => chat.analysis).slice(0, 30)
    .map((chat) => ({
      startedAt: chat.startedAt,
      note: chat.analysis.note,
      moodWords: chat.analysis.moodWords,
      wellbeingScore: chat.analysis.wellbeingScore,
      flagged: chat.analysis.flagged,
    }));
  if (!reviewed.length) return;
  try {
    state.companionOverview = await apiFetch('/api/companion/overview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientName: state.settings.patientName, chats: reviewed }),
    });
    await persistState();
    if (currentPage === 'companion') renderCompanion($('#app-content'));
  } catch (error) {
    console.warn('Companion overview failed:', error.message);
  }
}

function enableTranscriptActions() {
  $('#generate-summary').disabled = false;
  $('#download-transcript').disabled = false;
  $('#save-session').disabled = false;
  $('#save-visit').disabled = false;
}

function restorePatientCaptureUi() {
  const video = $('#patient-video');
  if (patientContext.stream && video) {
    video.srcObject = patientContext.stream;
    video.play().catch(() => {});
    $('#start-patient-camera').disabled = true;
  }
  $('#scan-text').textContent = patientContext.visitor
    ? `${patientContext.visitor.name} recognized`
    : patientContext.stream ? 'Scanning for trusted people…' : 'Camera is off';
  if (patientContext.visitor) {
    $('#matched-card').innerHTML = `<h3>Hi, this is ${escapeHtml(patientContext.visitor.name)}.</h3><p>${escapeHtml(patientContext.visitor.relationship)}. ${escapeHtml(patientContext.visitor.memory || '')}</p>`;
  }
  $('#record-status').classList.remove('hidden');
  $('#start-recording').disabled = true;
  $('#stop-recording').disabled = false;
  $('#save-visit').disabled = false;
  renderLiveTranscript();
}

async function startPatientCamera() {
  if (patientContext?.stream) return;
  if (!faceModelsReady && !(await loadFaceModels())) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } }, audio: false });
    patientContext.stream = stream;
    activeStreams.push(stream);
    const video = $('#patient-video');
    video.srcObject = stream;
    await video.play();
    patientContext.scanning = true;
    $('#scan-text').textContent = state.visitors.length ? 'Scanning for trusted people…' : 'No trusted people enrolled';
    $('#start-patient-camera').disabled = true;
    $('#start-recording').disabled = false;
    if (!state.visitors.length) return;
    let processing = false;
    const loop = setInterval(async () => {
      if (processing || !patientContext?.scanning || video.readyState < 2) return;
      processing = true;
      try {
        const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: .45 })).withFaceLandmarks().withFaceDescriptor();
        if (!detection) {
          $('#scan-text').textContent = 'Looking for a face…';
          patientContext.matchStreak = {};
          return;
        }
        let best = null;
        let bestSimilarity = -1;
        for (const visitor of state.visitors) {
          for (const pose of poses) {
            const descriptor = visitor.descriptors?.[pose];
            if (!Array.isArray(descriptor) || descriptor.length !== 128) continue;
            const distance = faceapi.euclideanDistance(detection.descriptor, new Float32Array(descriptor));
            const similarity = Math.max(0, 1 - distance / 2);
            if (similarity > bestSimilarity) { best = visitor; bestSimilarity = similarity; }
          }
        }
        if (best && bestSimilarity >= Number(state.settings.faceThreshold || .70)) {
          const streak = (patientContext.matchStreak[best.id] || 0) + 1;
          patientContext.matchStreak = { [best.id]: streak };
          $('#scan-text').textContent = `Checking ${best.name}… ${Math.round(bestSimilarity * 100)}%`;
          if (streak >= 2 && patientContext.visitor?.id !== best.id) {
            patientContext.visitor = best;
            patientContext.scanning = false;
            $('#scan-text').textContent = `${best.name} recognized`;
            $('#matched-card').innerHTML = `<h3>Hi, this is ${escapeHtml(best.name)}.</h3><p>${escapeHtml(best.relationship)}. ${escapeHtml(best.memory || '')}</p>`;
            speakText(`Hi ${state.settings.patientName}. This is ${best.name}, your ${best.relationship}. ${best.memory || ''}`);
          }
        } else {
          patientContext.matchStreak = {};
          $('#scan-text').textContent = 'Face not recognized yet';
        }
      } catch (error) {
        console.warn(error);
      } finally { processing = false; }
    }, 1100);
    activeIntervals.push(loop);
  } catch (error) {
    toast(`Camera could not start: ${error.message}`, 'error');
  }
}

function chooseRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function startPatientRecording() {
  if (!patientContext || patientContext.busy || patientContext.stopping) return;
  patientContext.stopping = false;
  try {
    if (!patientContext.audioStream?.active) {
      patientContext.audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      activeStreams.push(patientContext.audioStream);
    }
    const mimeType = chooseRecorderMimeType();
    patientContext.chunks = [];
    patientContext.blob = null;
    patientContext.transcript = [];
    patientContext.summary = null;
    patientContext.startedAt = new Date().toISOString();
    patientContext.recorder = new MediaRecorder(patientContext.audioStream, mimeType ? { mimeType } : undefined);
    patientContext.recorder.ondataavailable = (event) => { if (event.data.size) patientContext.chunks.push(event.data); };
    patientContext.recorder.start(1000);
    $('#record-status').classList.remove('hidden');
    $('#start-recording').disabled = true;
    $('#stop-recording').disabled = false;
    $('#save-visit').disabled = false;
    setSelectDisabled('#speech-language', true);
    setSelectDisabled('#translation-language', true);
    $('#transcript-badge').textContent = 'Recording';
    $('#transcript-scroll').innerHTML = '<div class="empty-state"><p>Recording the visit securely in this browser…</p></div>';

    if (liveModeEnabled()) {
      const started = await startLiveConversation(patientContext.audioStream).catch((error) => {
        console.warn('Live transcription failed to start:', error.message);
        return false;
      });
      if (started) {
        $('#transcript-badge').textContent = 'Listening';
        renderLiveTranscript();
        toast(voiceprints.length
          ? 'Live transcription is on, enrolled voices are named automatically.'
          : 'Live transcription is on, voices are split automatically.', 'success');
      } else {
        stopLiveConversation();
        toast('Live transcription is unavailable. Meco will transcribe with AssemblyAI after the recording.', 'error');
      }
    }
  } catch (error) {
    toast(`Microphone recording could not start: ${error.message}`, 'error');
  }
}

async function stopRecorder() {
  if (!patientContext?.recorder || patientContext.recorder.state === 'inactive') return patientContext?.blob;
  return new Promise((resolve, reject) => {
    const recorder = patientContext.recorder;
    recorder.onstop = () => {
      const type = recorder.mimeType || patientContext.chunks[0]?.type || 'audio/webm';
      patientContext.blob = new Blob(patientContext.chunks, { type });
      resolve(patientContext.blob);
    };
    recorder.onerror = (event) => reject(event.error || new Error('Recorder failed.'));
    recorder.stop();
  });
}

function showVisitProgress(percent, heading, detail = '') {
  const scroll = $('#transcript-scroll');
  if (!scroll) return;
  const existing = scroll.querySelector('.formatting-state');
  if (!existing) {
    scroll.innerHTML = `<div class="formatting-state"><strong>${escapeHtml(heading)}</strong><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div><small>${escapeHtml(detail)}</small></div>`;
    return;
  }
  existing.querySelector('strong').textContent = heading;
  existing.querySelector('small').textContent = detail;
  existing.querySelector('.progress-fill').style.width = `${percent}%`;
}

async function tidyTranscript(turns) {
  if (turns.length < 2) return turns;
  const badge = $('#transcript-badge');
  if (badge) badge.textContent = 'Tidying…';
  showVisitProgress(62, 'Formatting the conversation', 'Grouping fragments into full turns and repairing mis-hearings');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60000);
  try {
    const result = await apiFetch('/api/refine-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: turns }),
      signal: abort.signal,
    });
    const refined = Array.isArray(result.transcript) ? result.transcript : [];
    if (!refined.length) return turns;
    if (result.provider && result.provider !== 'unchanged') {
      toast(`Transcript grouped into ${turnsLabel(refined.length)}${result.provider === 'local-merge' ? '' : ` with ${result.provider}`}.`, 'success');
    }
    return refined;
  } catch (error) {
    console.warn('Transcript tidy-up failed:', error.message);
    return turns;
  } finally {
    clearTimeout(timer);
  }
}

function releaseRecordingAudio() {
  if (!patientContext) return;
  patientContext.audioStream?.getTracks?.().forEach((track) => track.stop());
  patientContext.audioStream = null;
}

async function stopPatientRecording() {
  if (!patientContext || patientContext.stopping) return;
  patientContext.stopping = true;
  $('#stop-recording').disabled = true;
  $('#record-status').classList.add('hidden');
  $('#transcript-badge').textContent = 'Finishing';
  showVisitProgress(22, 'Finishing the recording', 'Catching the last few words');
  try {
    const [liveTurns] = await Promise.all([
      liveContext ? finishLiveConversation() : Promise.resolve([]),
      stopRecorder().catch(() => null),
    ]);
    releaseRecordingAudio();
    if (!patientContext) return;
    if (liveTurns.length) {
      const tidied = await tidyTranscript(liveTurns);
      if (!patientContext) return;
      patientContext.transcript = tidied;
      $('#transcript-badge').textContent = turnsLabel(tidied.length);
      renderEditableTranscript();
      enableTranscriptActions();
    } else {
      $('#transcript-badge').textContent = patientContext.transcript.length ? turnsLabel(patientContext.transcript.length) : 'Stopped';
    }
    $('#start-recording').disabled = false;
    setSelectDisabled('#speech-language', false);
    setSelectDisabled('#translation-language', !translationAvailable());
    toast('Recording stopped.', 'success');
  } catch (error) {
    $('#transcript-badge').textContent = 'Stopped';
    toast(`The recording could not be stopped cleanly: ${error.message}`, 'error');
  } finally {

    stopLiveConversation();
    releaseRecordingAudio();
    if (patientContext) {
      patientContext.stopping = false;
      patientContext.busy = false;
      $('#start-recording').disabled = false;
      $('#stop-recording').disabled = true;
      $('#record-status').classList.add('hidden');

      if (patientContext.transcript.length || patientContext.chunks?.length) $('#save-visit').disabled = false;
    }
  }
}

async function transcribeRecordedAudio() {
  const blob = await stopRecorder();
  releaseRecordingAudio();
  if (!blob?.size) throw new Error('The audio recording was empty.');
  $('#transcript-badge').textContent = 'Uploading';
  $('#transcript-scroll').innerHTML = '<div class="empty-state"><p>AssemblyAI is separating and transcribing the speakers…</p></div>';
  const token = await getToken();
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Speakers-Expected': String(state.settings.expectedSpeakers || 2),
    },
    body: blob,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Transcription failed (${response.status}).`);
  const speakerNames = {};
  const labels = [...new Set((result.utterances || []).map((item) => item.speaker))];
  labels.forEach((label, index) => {
    speakerNames[label] = index === 0 ? (patientContext.visitor?.name || 'Visitor') : index === 1 ? state.settings.patientName : `Speaker ${label}`;
  });
  const turns = (result.utterances || []).map((item) => ({ ...item, displaySpeaker: speakerNames[item.speaker] || `Speaker ${item.speaker}` }));
  if (!patientContext) return [];
  patientContext.transcript = await tidyTranscript(turns);
  if (!patientContext) return [];
  $('#transcript-badge').textContent = turnsLabel(patientContext.transcript.length);
  renderEditableTranscript();
  return patientContext.transcript;
}

async function saveVisitNow() {
  if (!patientContext || patientContext.saving) return;
  patientContext.saving = true;
  const saveButtons = ['#save-visit', '#save-session'].map((selector) => $(selector)).filter(Boolean);
  saveButtons.forEach((button) => { button.disabled = true; });
  try {
    if (liveContext || patientContext.recorder?.state === 'recording') {
      await stopPatientRecording();
      if (!patientContext) return;
    }
    if (!patientContext.transcript.length) {
      const recorded = patientContext.blob?.size || patientContext.chunks?.length;
      if (!recorded) {
        toast('There is nothing to save yet. Record the visit first.', 'error');
        return;
      }
      await transcribeRecordedAudio();
      if (!patientContext) return;
    }
    if (!patientContext.transcript.length) {
      toast('No speech was captured, so there is nothing to save.', 'error');
      return;
    }
    $('#transcript-badge').textContent = 'Saving…';
    showVisitProgress(90, 'Saving the visit', 'Storing the conversation in Visit Reports');
    await savePatientSession();
    showVisitProgress(100, 'Visit saved', 'Opening Visit Reports');
    await sleep(650);
    navigateApp('sessions');
  } catch (error) {
    $('#transcript-badge').textContent = 'Not saved';
    toast(`The visit could not be saved: ${error.message}`, 'error');
  } finally {
    if (patientContext) {
      patientContext.saving = false;
      saveButtons.forEach((button) => { if (button.isConnected) button.disabled = false; });
    }
  }
}

function renderEditableTranscript() {
  const peopleOptions = [...new Set([
    patientContext.visitor?.name || 'Visitor',
    state.settings.patientName,
    ...voiceprints.map((item) => item.name),
    ...patientContext.transcript.map((line) => line.displaySpeaker).filter(Boolean),
    'Caregiver',
    'Other speaker',
  ])];
  $('#transcript-scroll').innerHTML = patientContext.transcript.map((line, index) => `<div class="utterance"><div class="utterance-head"><select data-speaker-index="${index}">${peopleOptions.map((name) => `<option value="${escapeHtml(name)}" ${line.displaySpeaker === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><small>${formatDuration(line.start || 0)}</small></div><p>${escapeHtml(line.text)}</p>${line.translation ? `<small>${escapeHtml(line.translation)}</small>` : ''}</div>`).join('');
  $$('[data-speaker-index]').forEach((select) => select.onchange = () => {
    patientContext.transcript[Number(select.dataset.speakerIndex)].displaySpeaker = select.value;
  });
}

async function generatePatientSummary() {
  if (!patientContext?.transcript.length || patientContext.busy) return;
  patientContext.busy = true;
  $('#generate-summary').disabled = true;
  $('#live-summary').innerHTML = '<div class="empty-state"><p>Meco AI is creating a structured caregiver report…</p></div>';
  try {
    const result = await apiFetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitorName: patientContext.visitor?.name || 'Unrecognized visitor',
        relationship: patientContext.visitor?.relationship || '',
        transcript: patientContext.transcript,
      }),
    });
    patientContext.summary = result;
    $('#live-summary').innerHTML = summaryMarkup(result) + reminderSuggestionsMarkup(patientContext.transcript);
    wireReminderSuggestions($('#live-summary'));
    $('#save-session').disabled = false;
    toast(`Report generated with ${result.provider}.`, 'success');
  } catch (error) {
    $('#live-summary').innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    toast(error.message, 'error');
  } finally {
    patientContext.busy = false;
    $('#generate-summary').disabled = false;
  }
}

async function savePatientSession() {

  if (!patientContext?.transcript.length) throw new Error('There is no transcript to save.');
  const visitor = inferSessionVisitor();
  const session = {
    id: crypto.randomUUID(),
    visitorId: visitor.id,
    visitorName: visitor.name,
    relationship: visitor.relationship,
    participants: sessionSpeakers({ transcript: patientContext.transcript }),
    startedAt: patientContext.startedAt || new Date().toISOString(),
    endedAt: new Date().toISOString(),
    transcript: patientContext.transcript,
    summary: patientContext.summary,
  };
  state.sessions.unshift(session);
  try {
    await persistState(true);
  } catch (error) {
    state.sessions = state.sessions.filter((item) => item.id !== session.id);
    throw error;
  }
  toast(`Visit with ${session.visitorName} saved.`, 'success');
  return session;
}

async function openFaceModal() {
  $('#face-modal').classList.remove('hidden');
  $('#visitor-name').value = '';
  $('#visitor-relationship').value = '';
  $('#visitor-memory').value = '';
  enrollContext = { stream: null, descriptors: {}, thumbnail: '', poseIndex: 0, detection: null, voiceSample: null };

  $('#enroll-consent-check').checked = false;
  $('.face-camera-side').classList.remove('consent-granted');
  $('#start-enroll-camera').disabled = true;
  const voiceButton = $('#capture-voice');
  voiceButton.disabled = true;
  voiceButton.textContent = voiceIdAvailable() ? 'Record voice sample (optional)' : 'Voice recognition server is offline';
  updatePoseUi();
  await loadFaceModels();
}

function wireEnrollConsent() {
  const checkbox = $('#enroll-consent-check');
  const side = $('.face-camera-side');
  checkbox.addEventListener('change', () => {
    side.classList.toggle('consent-granted', checkbox.checked);
    $('#start-enroll-camera').disabled = !checkbox.checked;
    const voiceButton = $('#capture-voice');
    voiceButton.disabled = !checkbox.checked || !voiceIdAvailable();
  });
}

async function captureVoiceSample() {
  const button = $('#capture-voice');
  const message = $('#enroll-camera-message');
  if (button.disabled) return;
  const name = $('#visitor-name').value.trim();
  if (!name) return toast('Add the name first so Meco can label the voiceprint.', 'error');
  button.disabled = true;
  const sentence = voicePromptSentence();
  message.textContent = `Read aloud: “${sentence}”`;
  message.classList.remove('hidden');
  try {
    const sample = await recordVoiceSample(12000, (secondsLeft) => {
      button.textContent = `Listening… ${secondsLeft}s`;
      message.textContent = `Read aloud: “${sentence}” · ${secondsLeft}s left`;
    });
    enrollContext.voiceSample = sample.base64;
    button.textContent = 'Voice sample captured, record again';
    toast('Voice sample captured. It is enrolled when you save this person.', 'success');
  } catch (error) {
    button.textContent = 'Record voice sample (optional)';
    toast(`Voice sample failed: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    message.classList.add('hidden');
    if (!enrollContext.stream) message.textContent = 'Start camera to enroll';
  }
}

function closeFaceModal() {
  $('#face-modal').classList.add('hidden');
  enrollContext.stream?.getTracks?.().forEach((track) => track.stop());
  enrollContext.stream = null;
  $('#enroll-video').srcObject = null;
}

async function startEnrollCamera() {
  if (!faceModelsReady && !(await loadFaceModels())) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 800 }, height: { ideal: 600 } }, audio: false });
    enrollContext.stream = stream;
    const video = $('#enroll-video');
    video.srcObject = stream;
    await video.play();
    $('#enroll-camera-message').classList.add('hidden');
    $('#start-enroll-camera').disabled = true;
    $('#capture-pose').disabled = false;
  } catch (error) {
    toast(`Camera could not start: ${error.message}`, 'error');
  }
}

function makeThumbnail(video, detection) {
  const box = detection.detection.box;
  const source = document.createElement('canvas');
  source.width = video.videoWidth;
  source.height = video.videoHeight;
  source.getContext('2d').drawImage(video, 0, 0);
  const pad = Math.max(box.width, box.height) * .28;
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(source.width - sx, box.width + pad * 2);
  const sh = Math.min(source.height - sy, box.height + pad * 2);
  const canvas = document.createElement('canvas');
  canvas.width = 112;
  canvas.height = 112;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4eee6';
  ctx.fillRect(0, 0, 112, 112);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, 112, 112);
  return canvas.toDataURL('image/jpeg', .62);
}

async function capturePose() {
  const video = $('#enroll-video');
  const pose = poses[enrollContext.poseIndex];
  if (!video?.srcObject || !pose) return;
  $('#capture-pose').disabled = true;
  $('#enroll-camera-message').textContent = `Detecting ${pose} pose…`;
  $('#enroll-camera-message').classList.remove('hidden');
  try {
    const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: .5 })).withFaceLandmarks().withFaceDescriptor();
    if (!detection) throw new Error('No clear face was detected. Face the camera in good light and try again.');
    enrollContext.descriptors[pose] = Array.from(detection.descriptor);
    if (!enrollContext.thumbnail) enrollContext.thumbnail = makeThumbnail(video, detection);
    enrollContext.poseIndex += 1;
    updatePoseUi();
    toast(`${pose[0].toUpperCase() + pose.slice(1)} face angle captured.`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('#enroll-camera-message').classList.add('hidden');
    $('#capture-pose').disabled = enrollContext.poseIndex >= poses.length;
  }
}

function updatePoseUi() {
  $$('[data-pose-status]').forEach((item) => item.classList.toggle('done', Boolean(enrollContext.descriptors[item.dataset.poseStatus])));
  const next = poses[enrollContext.poseIndex];
  $('#capture-pose').textContent = next ? `Capture ${next}` : 'All angles captured';
  $('#save-visitor').disabled = enrollContext.poseIndex < poses.length;
}

async function saveVisitor() {
  const name = $('#visitor-name').value.trim();
  const relationship = $('#visitor-relationship').value.trim();
  const memory = $('#visitor-memory').value.trim();
  if (!name || !relationship || !memory) return toast('Add the name, relationship and memory cue first.', 'error');
  if (poses.some((pose) => !Array.isArray(enrollContext.descriptors[pose]) || enrollContext.descriptors[pose].length !== 128)) return toast('Capture all three real face angles before saving.', 'error');
  const visitor = {
    id: crypto.randomUUID(),
    name: name.slice(0, 80),
    relationship: relationship.slice(0, 80),
    memory: memory.slice(0, 500),
    descriptors: enrollContext.descriptors,
    thumbnail: enrollContext.thumbnail,
    registeredAt: new Date().toISOString(),
  };
  if (enrollContext.voiceSample) {
    try {
      const enrolled = await apiFetch('/api/voice/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: visitor.name, personId: visitor.id, audio: enrollContext.voiceSample }),
      });
      visitor.voiceId = enrolled.id;
      await loadVoiceprints();
    } catch (error) {
      toast(`The face enrollment is saved, but the voiceprint failed: ${error.message}`, 'error');
    }
  }
  state.visitors.unshift(visitor);
  try {
    await persistState(true);
    closeFaceModal();
    navigateApp('people');
  } catch {
    state.visitors.shift();
  }
}

function wireRerenderRequests() {
  window.addEventListener(RERENDER_EVENT, () => {
    if (['visits', 'reminders', 'overview'].includes(currentPage)) renderAppPage(currentPage);
  });
}

const PALETTE_PAGE_GLYPHS = {
  overview: '⌂', visits: '▦', reminders: '◴', people: '◎',
  memory: '▤', graph: '⏱', sessions: '≋', insights: '◈',
  notes: '✒', companion: '❦', journal: '✎', activities: '✳',
  settings: '⚙', patient: '◉',
};

let paletteItems = [];
let paletteActive = 0;
let paletteOpen = false;

function paletteIndex() {
  const items = [];
  $$('.side-nav[data-page]').forEach((button) => {
    const page = button.dataset.page;
    const label = button.textContent.trim().replace(/\s+/g, ' ');
    if (!label) return;
    items.push({
      kind: 'page', glyph: PALETTE_PAGE_GLYPHS[page] || '○',
      label, hint: 'Go to page', run: () => navigateApp(page),
    });
  });
  (state.visitors || []).forEach((visitor) => {
    items.push({
      kind: 'person', glyph: '◎', label: visitor.name || 'Unnamed',
      hint: visitor.relationship || 'Trusted person',
      run: () => { navigateApp('people'); setTimeout(() => openPersonEditor(visitor.id), 60); },
    });
  });
  (state.sessions || []).slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).forEach((session) => {
    items.push({
      kind: 'visit', glyph: '≋', label: sessionTitle(session),
      hint: formatDate(session.startedAt), run: () => openSessionDetail(session.id),
    });
  });
  (state.memories || []).forEach((memory) => {
    items.push({
      kind: 'memory', glyph: '▤', label: memory.title || 'Untitled memory',
      hint: memory.date ? formatDate(memory.date) : 'Memory capsule',
      run: () => { navigateApp('graph'); setTimeout(() => openMemoryDetail(memory.id), 60); },
    });
  });
  (state.places || []).forEach((place) => {
    items.push({ kind: 'place', glyph: '◈', label: place.name || 'Unnamed place',
      hint: 'Place', run: () => navigateApp('graph') });
  });
  return items;
}

function paletteScore(item, query) {
  const hay = (item.label + ' ' + item.hint).toLowerCase();
  const label = item.label.toLowerCase();
  if (!query) return item.kind === 'page' ? 3 : 1;
  if (label.startsWith(query)) return 100 - label.length;
  if (label.includes(query)) return 60 - label.length;
  if (hay.includes(query)) return 30;
  let i = 0;
  for (const ch of label) { if (ch === query[i]) i += 1; if (i === query.length) return 12; }
  return 0;
}

function paletteRender(query) {
  const list = $('#palette-results');
  const count = $('#palette-count');
  if (!list) return;
  const q = query.trim().toLowerCase();
  const ranked = paletteItems
    .map((item) => ({ item, score: paletteScore(item, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((row) => row.item);
  paletteItems.filtered = ranked;
  if (paletteActive >= ranked.length) paletteActive = 0;
  if (count) count.textContent = ranked.length ? `${ranked.length} found` : '';
  if (!ranked.length) {
    list.innerHTML = '<li class="palette-empty">Nothing matches that</li>';
    return;
  }
  list.innerHTML = ranked.map((item, i) => `
    <li role="option" data-palette-index="${i}" aria-selected="${i === paletteActive}">
      <span class="palette-glyph">${item.glyph}</span>
      <span class="palette-label"><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.hint)}</small></span>
      <span class="palette-kind">${item.kind}</span>
    </li>`).join('');
  const active = list.querySelector('[aria-selected="true"]');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function paletteRun(index) {
  const ranked = paletteItems.filtered || [];
  const item = ranked[index];
  if (!item) return;
  closePalette();
  item.run();
}

function openPalette() {
  const backdrop = $('#palette');
  const input = $('#palette-input');
  if (!backdrop || !input || appLoaded === false) return;
  paletteItems = paletteIndex();
  paletteActive = 0;
  paletteOpen = true;
  backdrop.classList.remove('hidden');
  input.value = '';
  paletteRender('');
  input.focus();
}

function closePalette() {
  const backdrop = $('#palette');
  if (!backdrop) return;
  paletteOpen = false;
  backdrop.classList.add('hidden');
}

function initCommandPalette() {
  const backdrop = $('#palette');
  const input = $('#palette-input');
  const list = $('#palette-results');
  if (!backdrop || !input || !list) return;

  input.addEventListener('input', () => { paletteActive = 0; paletteRender(input.value); });
  list.addEventListener('click', (event) => {
    const row = event.target.closest('[data-palette-index]');
    if (row) paletteRun(Number(row.dataset.paletteIndex));
  });
  list.addEventListener('mousemove', (event) => {
    const row = event.target.closest('[data-palette-index]');
    if (!row) return;
    const next = Number(row.dataset.paletteIndex);
    if (next === paletteActive) return;
    paletteActive = next;
    list.querySelectorAll('[data-palette-index]').forEach((el) => {
      el.setAttribute('aria-selected', String(Number(el.dataset.paletteIndex) === paletteActive));
    });
  });
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) closePalette(); });

  document.addEventListener('keydown', (event) => {
    const combo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
    if (combo) {
      event.preventDefault();
      if (paletteOpen) closePalette();
      else if (!$('#app-view').classList.contains('hidden')) openPalette();
      return;
    }
    if (!paletteOpen) return;
    const ranked = paletteItems.filtered || [];
    if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); paletteActive = (paletteActive + 1) % Math.max(1, ranked.length); paletteRender(input.value); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); paletteActive = (paletteActive - 1 + ranked.length) % Math.max(1, ranked.length); paletteRender(input.value); }
    else if (event.key === 'Enter') { event.preventDefault(); paletteRun(paletteActive); }
  });
}

function onThisDayEntry() {
  const now = new Date();
  const today = now.getDate();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const pool = [];
  (state.sessions || []).forEach((session) => {
    if (session.startedAt) pool.push({ when: new Date(session.startedAt), kind: 'visit', title: sessionTitle(session),
      body: session.summary?.summary || (session.transcript || []).map((t) => t.text).filter(Boolean).join(' '),
      open: () => openSessionDetail(session.id) });
  });
  (state.journalEntries || []).forEach((entry) => {
    if (entry.createdAt) pool.push({ when: new Date(entry.createdAt), kind: 'journal', title: 'Journal entry',
      body: (entry.text || '').replace(/\s+/g, ' '), open: () => navigateApp('journal') });
  });
  (state.memories || []).forEach((memory) => {
    const stamp = memory.date || memory.createdAt;
    if (stamp) pool.push({ when: new Date(stamp), kind: 'memory', title: memory.title || 'A memory',
      body: memory.summary || memory.details || '', open: () => { navigateApp('graph'); setTimeout(() => openMemoryDetail(memory.id), 60); } });
  });

  const older = pool.filter((row) => !Number.isNaN(row.when.getTime())
    && !(row.when.getFullYear() === thisYear && row.when.getMonth() === thisMonth && row.when.getDate() === today));
  const sameDayOtherYear = older.filter((row) => row.when.getDate() === today && row.when.getMonth() === thisMonth);
  const sameDateOtherMonth = older.filter((row) => row.when.getDate() === today);
  const pick = (sameDayOtherYear[0] || sameDateOtherMonth[0]);
  if (!pick || !(pick.body || '').trim()) return null;

  const months = Math.max(0, (thisYear - pick.when.getFullYear()) * 12 + (thisMonth - pick.when.getMonth()));
  let ago = 'earlier';
  if (months >= 12) { const y = Math.floor(months / 12); ago = `${y} year${y === 1 ? '' : 's'} ago today`; }
  else if (months >= 1) ago = `${months} month${months === 1 ? '' : 's'} ago today`;
  return { ...pick, ago };
}

function onThisDayMarkup() {
  const entry = onThisDayEntry();
  if (!entry) return '';
  const body = entry.body.length > 190 ? `${entry.body.slice(0, 190).trim()}…` : entry.body;
  return `<article class="onthisday" data-onthisday>
    <div class="onthisday-head">
      <span class="onthisday-kicker">On this day</span>
      <span class="onthisday-when">${escapeHtml(entry.ago)} · ${escapeHtml(formatDate(entry.when.toISOString()))}</span>
    </div>
    <p class="onthisday-body">${escapeHtml(body)}</p>
    <p class="onthisday-meta">${escapeHtml(entry.kind)} · ${escapeHtml(entry.title)}</p>
    <div class="onthisday-actions"><button class="action-button" data-onthisday-open>Open it</button></div>
  </article>`;
}

function wireOnThisDay(content) {
  const button = content.querySelector('[data-onthisday-open]');
  if (!button) return;
  button.addEventListener('click', () => {
    const entry = onThisDayEntry();
    if (entry) entry.open();
  });
}

function wireGlobalEvents() {

  $$('[data-auth]').forEach((button) => button.addEventListener('click', () => {
    if (config.features.localDemo) { history.pushState({}, '', routeUrl('/app')); renderRoute(); return; }
    openAuthModal(button.dataset.auth);
  }));

  const burger = $('#nav-burger-toggle');
  const sheet = $('#nav-mobile-sheet');
  if (burger && sheet) {
    const closeSheet = () => { sheet.classList.add('hidden'); burger.setAttribute('aria-expanded', 'false'); };
    burger.addEventListener('click', () => {
      const isOpen = !sheet.classList.contains('hidden');
      sheet.classList.toggle('hidden', isOpen);
      burger.setAttribute('aria-expanded', String(!isOpen));
    });
    sheet.querySelectorAll('a, button').forEach((el) => el.addEventListener('click', closeSheet));
    document.addEventListener('click', (event) => {
      if (!sheet.classList.contains('hidden') && !sheet.contains(event.target) && event.target !== burger && !burger.contains(event.target)) closeSheet();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSheet(); });
  }
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', closeAuthModal));
  $('#auth-modal').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeAuthModal(); });
  $$('[data-close-face]').forEach((button) => button.addEventListener('click', closeFaceModal));
  $('#face-modal').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeFaceModal(); });
  $('#start-enroll-camera').addEventListener('click', startEnrollCamera);
  $('#capture-pose').addEventListener('click', capturePose);
  $('#capture-voice').addEventListener('click', captureVoiceSample);
  wireEnrollConsent();
  $$('[data-close-person]').forEach((button) => button.addEventListener('click', closePersonEditor));
  $('#person-modal').addEventListener('click', (event) => { if (event.target === event.currentTarget) closePersonEditor(); });
  $('#save-person-details').addEventListener('click', savePersonDetails);
  $('#edit-person-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); savePersonDetails(); } });
  $('#edit-person-relationship').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); savePersonDetails(); } });
  $('#save-visitor').addEventListener('click', saveVisitor);
  $$('[data-close-visit]').forEach((button) => button.addEventListener('click', closeVisitModal));
  $('#visit-modal').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeVisitModal(); });
  $('#save-visit').addEventListener('click', saveVisitModal);
  $('#delete-visit-modal').addEventListener('click', () => editingVisitId && deleteScheduledVisit(editingVisitId));
  $('#visit-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); saveVisitModal(); } });
  $$('[data-close-reminder]').forEach((button) => button.addEventListener('click', closeReminderModal));
  $('#reminder-modal').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeReminderModal(); });
  $('#save-reminder').addEventListener('click', saveReminderModal);
  $('#delete-reminder-modal').addEventListener('click', () => editingReminderId && deleteReminder(editingReminderId));
  $('#reminder-text').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); saveReminderModal(); } });

  $$('.side-nav:not(.patient-entry)').forEach((button) => button.addEventListener('click', () => navigateApp(button.dataset.page)));
  $('.patient-entry').addEventListener('click', (event) => {
    if (event.currentTarget.dataset.page === 'patient') openPatientCameraMode();
    else navigateApp(event.currentTarget.dataset.page);
  });
  $('#patient-mode-top').addEventListener('click', openPatientCameraMode);
  $$('[data-route="landing"]').forEach((button) => button.addEventListener('click', () => { history.pushState({}, '', routeUrl('/')); renderRoute(); }));
  $$('[data-landing-nav]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    const path = link.dataset.landingNav === 'home' ? '/' : `/${link.dataset.landingNav}`;
    if (routePath() !== path) history.pushState({}, '', routeUrl(path));
    showLanding(link.dataset.landingNav);
  }));
  window.addEventListener('popstate', renderRoute);
  window.addEventListener('beforeunload', cleanupMedia);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeAuthModal(); closeFaceModal(); closePersonEditor(); closeVisitModal(); closeReminderModal(); }
  });

  window.addEventListener('scroll', () => {
    if (scrollChromeTicking) return;
    scrollChromeTicking = true;
    requestAnimationFrame(updateScrollChrome);
  }, { passive: true });
  window.addEventListener('resize', updateScrollChrome, { passive: true });
  updateScrollChrome();

  $('.hero-shell')?.addEventListener('mousemove', (event) => {
    const art = $('.hero-art');
    if (!art) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    art.style.transform = `translate(${x * -14}px, ${y * -10}px)`;
  });
  $('.hero-shell')?.addEventListener('mouseleave', () => { const art = $('.hero-art'); if (art) art.style.transform = ''; });

  $$('.style-picker').forEach((picker) => {
    picker.addEventListener('click', (event) => {
      const chip = event.target.closest('.style-chip');
      if (!chip || chip.classList.contains('selected')) return;
      $$('.style-chip', picker).forEach((sibling) => sibling.classList.remove('selected', 'just-selected'));
      chip.classList.add('selected', 'just-selected');
      chip.addEventListener('animationend', () => chip.classList.remove('just-selected'), { once: true });
      const mock = picker.closest('.promo-band')?.querySelector('.promo-mock');
      if (mock && chip.dataset.mock) mock.lastChild.textContent = chip.dataset.mock;
    });
  });
}

function initTiltCards() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;
  const selector = '.deep-card, .teaser-card, .integration-card, .price-card, .care-tile, .organize-card, .metric-card, .showcase-card, .recognition-card';
  $$(selector).forEach((card) => {
    let raf = null;
    card.addEventListener('mousemove', (event) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        card.style.transform = `perspective(900px) rotateX(${(-y * 4).toFixed(2)}deg) rotateY(${(x * 4).toFixed(2)}deg) translateY(-4px) scale(1.015)`;
        raf = null;
      });
    });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  });
}

function initCursorGlow() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;
  const glow = document.createElement('div');
  glow.className = 'cursor-glow';
  document.body.appendChild(glow);
  let raf = null;
  let targetX = 0;
  let targetY = 0;
  const paint = () => {
    glow.style.transform = `translate(${targetX}px, ${targetY}px)`;
    raf = null;
  };
  document.addEventListener('mousemove', (event) => {
    const landing = $('#landing-view');
    if (!landing || landing.classList.contains('hidden')) { glow.classList.remove('active'); return; }
    targetX = event.clientX;
    targetY = event.clientY;
    glow.classList.add('active');
    if (!raf) raf = requestAnimationFrame(paint);
  });
  document.addEventListener('mouseleave', () => glow.classList.remove('active'));
}

async function boot() {
  observeReveals();
  wireGlobalEvents();
  wireRerenderRequests();
  wireThemeSystem();
  initTiltCards();
  initCursorGlow();
  initMagneticButtons();
  initHeroGap();
  initOrbit();
  initPlayground();
  renderEvidencePages();
  initAssistanceLadder();
  initAssistanceSimulation();
  initCommandPalette();
  applyRouteBase();
  try {
    setConfig(await fetch('/api/config').then((response) => response.json()));
  } catch (error) {
    if (!$('#app-view').classList.contains('hidden')) {
      toast('Meco server configuration could not be loaded.', 'error');
    }
  }
  await initClerk();
  await renderRoute();
  startCalendarPolling();
  pullFromCalendar();
}

boot();
