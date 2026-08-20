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

  memories: [],
  places: [],
  objects: [],
  familyContributions: [],
  cognitiveAttempts: [],
  reminiscenceCollections: [],
  retrievalItems: [],
  retrievalAttempts: [],
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
    familyShareSalt: '',
    stimulationLevel: 2,
  },
  updatedAt: new Date().toISOString(),
});

export let state = defaultState();

export function setState(next) {
  state = next;
}

export function resetState() {
  state = defaultState();
}
