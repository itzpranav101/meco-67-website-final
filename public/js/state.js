/* The one shared object every caregiver-console screen reads from. */

export const defaultState = () => ({
  version: 2,
  visitors: [],
  sessions: [],
  visits: [],
  reminders: [],
  companionChats: [],
  companionOverview: null,
  journalEntries: [],
  careNotes: [],
  sosEvents: [],
  moodCheckIns: [],
  sampleDataActive: false,
  // ---- Memory Graph platform ----
  // The "graph" itself is never stored as an edge list
  memories: [],              // Memory Capsules, Phase 1
  places: [],                 // Phase 1
  objects: [],                 // Object memory, Phase 2
  familyContributions: [],      // Family contributions inbox, Phase 3
  cognitiveAttempts: [],          // Cognitive Stimulation Mode log, Phase 4
  reminiscenceCollections: [],     // Curated reminiscence sets, Phase 4
  retrievalItems: [],               // Spaced-retrieval + errorless-cueing items, Phase 5
  retrievalAttempts: [],              // Phase 5
  settings: {
    patientName: 'Meco Member',
    caregiverName: 'Caregiver',
    ttsRate: 0.82,
    ttsPitch: 1.04,
    voiceGender: 'female',
    caregiverNote: 'You are safe. Take your time and enjoy this visit.',
    faceThreshold: 0.70,
    expectedSpeakers: 2,
    transcriptionMode: 'live',
    voiceThreshold: 0.62,
    conversationLanguage: 'en',
    translationLanguage: 'en',
    googleCalendarSync: false,
    elderMode: false,
    familyShareSalt: '',       // Phase 3, regenerating this invalidates every link signed with the old value
    stimulationLevel: 2,        // Phase 4, 1-5, nudged by recent accuracy
  },
  updatedAt: new Date().toISOString(),
});

export let state = defaultState();

/* Replace the whole state object, after a load from the server, or on sign-out. */
export function setState(next) {
  state = next;
}

/* Reset to an empty account. Used on sign-out and whenever a load fails, so
   one user's data can never be left on screen under another user's session. */
export function resetState() {
  state = defaultState();
}
