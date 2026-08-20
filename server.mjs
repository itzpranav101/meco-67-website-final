import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as engine from './public/assistance-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
// MECO_DATA_DIR so the smoke test does not wipe the real data dir
const DATA_DIR = process.env.MECO_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'meco-state.json');
const PORT = Number(process.env.PORT || 3000);
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

const env = (name, fallback = '') => process.env[name] || fallback;
const clerkPublishableKey = env('CLERK_PUBLISHABLE_KEY', env('VITE_CLERK_PUBLISHABLE_KEY'));
const decodeClerkFrontendDomain = (publishableKey) => {
  try {
    const encoded = String(publishableKey || '').split('_')[2] || '';
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - normalized.length % 4) % 4);
    return Buffer.from(normalized + padding, 'base64').toString('utf8').replace(/\$$/, '');
  } catch { return ''; }
};
const expectedClerkIssuer = env('CLERK_ISSUER', decodeClerkFrontendDomain(clerkPublishableKey) ? `https://${decodeClerkFrontendDomain(clerkPublishableKey)}` : '');
const normalizeOrigin = (value) => {
  try { return new URL(value).origin; } catch { return String(value || '').replace(/\/$/, ''); }
};
const allowedOrigins = env('CLERK_ALLOWED_ORIGINS', env('PUBLIC_APP_URL', `http://localhost:${PORT}`))
  .split(',').map((value) => normalizeOrigin(value.trim())).filter(Boolean);

const json = (res, status, body, extraHeaders = {}) => {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
};

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > limit) {
      reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const readJson = async (req) => {
  const body = await readBody(req, MAX_JSON_BYTES);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { status: 400 });
  }
};

const b64urlBuffer = (value) => {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(normalized + padding, 'base64');
};

const parseJwt = (token) => {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed session token.');
  const header = JSON.parse(b64urlBuffer(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlBuffer(parts[1]).toString('utf8'));
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64urlBuffer(parts[2]) };
};

const jwksCache = new Map();
const getJwks = async (issuer) => {
  const cached = jwksCache.get(issuer);
  if (cached && cached.expires > Date.now()) return cached.keys;
  const url = `${String(issuer).replace(/\/$/, '')}/.well-known/jwks.json`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Unable to retrieve Clerk JWKS (${response.status}).`);
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error('Clerk JWKS response was invalid.');
  jwksCache.set(issuer, { keys: data.keys, expires: Date.now() + 10 * 60 * 1000 });
  return data.keys;
};

const verifyClerkToken = async (token, req) => {
  if (env('ALLOW_LOCAL_DEMO') === 'true' && token === 'local-demo-token') {
    return { sub: 'local_demo_user', azp: `http://${req.headers.host}` };
  }
  const parsed = parseJwt(token);
  const { header, payload, signingInput, signature } = parsed;
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported Clerk token algorithm.');
  if (!payload.iss || !payload.sub) throw new Error('Clerk token is missing required claims.');
  if (!expectedClerkIssuer || String(payload.iss).replace(/\/$/, '') !== expectedClerkIssuer.replace(/\/$/, '')) {
    throw new Error('Session token issuer does not match this Clerk application.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error('Session token has expired.');
  if (payload.nbf && now < payload.nbf) throw new Error('Session token is not active yet.');
  if (payload.azp && allowedOrigins.length && !allowedOrigins.includes(normalizeOrigin(payload.azp))) {
    throw new Error('Session token was issued for an unauthorized origin.');
  }
  const keys = await getJwks(payload.iss);
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error('No matching Clerk signing key was found.');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify('RSA-SHA256', Buffer.from(signingInput), publicKey, signature);
  if (!valid) throw new Error('Invalid Clerk token signature.');
  return payload;
};

const requireUser = async (req) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  try {
    const payload = await verifyClerkToken(token, req);
    return payload.sub;
  } catch (error) {
    throw Object.assign(new Error(error.message || 'Authentication failed.'), { status: 401 });
  }
};

// ---------- patient accounts ----------
// Not Clerk users. Patients sign in with an id + a numeric passcode.
const patientTokenSecret = () => env('PATIENT_TOKEN_SECRET') || env('CLERK_SECRET_KEY') || 'meco-patient-token-fallback-secret';
const PATIENT_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days: a patient's own device stays signed in long-term

const signPatientToken = (patientId, ownerId) => {
  const expiresAt = Date.now() + PATIENT_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ pid: patientId, oid: ownerId, exp: expiresAt }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', patientTokenSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};

const verifyPatientToken = (token) => {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', patientTokenSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.pid || !data.oid || !data.exp || Date.now() >= data.exp) return null;
    return { patientId: String(data.pid), ownerId: String(data.oid) };
  } catch {
    return null;
  }
};

const requirePatientAuth = async (req) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw Object.assign(new Error('Patient authentication required.'), { status: 401 });
  const verified = verifyPatientToken(token);
  if (!verified) throw Object.assign(new Error('This patient session is invalid or has expired. Please sign in again.'), { status: 401 });
  return verified; // { patientId, ownerId }
};

// For the few endpoints either role can hit (companion chat, etc).
const requireUserOrPatient = async (req) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  const patient = verifyPatientToken(token);
  if (patient) return { ownerId: patient.ownerId, role: 'patient', patientId: patient.patientId };
  const ownerId = await requireUser(req);
  return { ownerId, role: 'caregiver', patientId: null };
};

const generatePatientId = () => crypto.randomBytes(4).toString('hex'); // 8 hex chars, short enough to type, unique enough to not collide
const generatePasscode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const hashPasscode = (passcode, salt) => crypto.scryptSync(passcode, salt, 32).toString('base64url');

// patientId -> owner + passcode hash. Needed before we know whose data to load.
const PATIENT_LOOKUP_FILE = path.join(DATA_DIR, 'meco-patient-accounts.json');
const patientLookupRowId = (patientId) => `patacct_${patientId}`;

const loadPatientLookupFile = async () => {
  try { return JSON.parse(await fsp.readFile(PATIENT_LOOKUP_FILE, 'utf8')); } catch { return {}; }
};
let patientLookupWriteQueue = Promise.resolve();
const savePatientLookupFile = async (patientId, record) => {
  patientLookupWriteQueue = patientLookupWriteQueue.then(async () => {
    await fsp.mkdir(path.dirname(PATIENT_LOOKUP_FILE), { recursive: true });
    const all = await loadPatientLookupFile();
    if (record === null) delete all[patientId];
    else all[patientId] = record;
    const temp = `${PATIENT_LOOKUP_FILE}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(all, null, 2));
    await fsp.rename(temp, PATIENT_LOOKUP_FILE);
  });
  return patientLookupWriteQueue;
};

// Try Appwrite, fall back to the local file, same as loadState.
const savePatientLookup = async (patientId, record) => {
  if (appwriteReady()) {
    try {
      const now = new Date().toISOString();
      await appwriteUpsertRow(patientLookupRowId(patientId), {
        owner_id: record.ownerId,
        entity: 'meco_patient_account',
        payload: JSON.stringify(record),
        created_date: now,
        updated_date: now,
      });
      return;
    } catch (error) {
      console.warn('[Meco] Appwrite patient-lookup save failed; using local fallback:', error.message);
    }
  }
  await savePatientLookupFile(patientId, record);
};

const loadPatientLookup = async (patientId) => {
  if (appwriteReady()) {
    try {
      const row = await appwriteGetRow(patientLookupRowId(patientId));
      return JSON.parse(row.payload || '{}');
    } catch (error) {
      if (error.status === 404) return null;
      console.warn('[Meco] Appwrite patient-lookup load failed; using local fallback:', error.message);
    }
  }
  const all = await loadPatientLookupFile();
  return all[patientId] || null;
};

const deletePatientLookup = async (patientId) => {
  if (appwriteReady()) {
    try {
      await appwriteDeleteRow(patientLookupRowId(patientId));
      return;
    } catch (error) {
      console.warn('[Meco] Appwrite patient-lookup delete failed; using local fallback:', error.message);
    }
  }
  await savePatientLookupFile(patientId, null);
};

// saveState wants the whole state back, so: load, mutate, save.
const mutateOwnerState = async (ownerId, mutator) => {
  const { state } = await loadState(ownerId);
  const next = mutator(state) || state;
  return saveState(ownerId, next);
};

// Only what a patient should see. No care notes, no settings, no other patients.
const patientStateProjection = (state) => ({
  patientName: state.settings?.patientName || 'Meco Member',
  caregiverNote: state.settings?.caregiverNote || '',
  visitors: (state.visitors || []).map((v) => ({
    id: v.id, name: v.name, relationship: v.relationship, memoryCue: v.memoryCue,
    initials: v.initials, tint: v.tint, voiceEnrolled: Boolean(v.voiceEnrolled), lastVisit: v.lastVisit || null,
  })),
  visits: (state.visits || []).map((v) => ({
    id: v.id, visitorID: v.visitorId || v.visitorID, visitorName: v.visitorName,
    date: v.date, note: v.note, repeatsWeekly: Boolean(v.repeatsWeekly),
  })),
  reminders: (state.reminders || []).filter((r) => !r.done).map((r) => ({
    id: r.id, text: r.text, done: Boolean(r.done), place: r.place || null, pinned: Boolean(r.pinned),
  })),
  journalEntries: state.journalEntries || [],
  moodCheckIns: state.moodCheckIns || [],
  memories: state.memories || [],
  sosRequested: (state.sosEvents || []).some((e) => !e.acknowledged),
  companionThread: (state.companionChats || []).slice(-1)[0]?.messages || [],
});

// 6 digits is about a million combos, so throttle logins properly.
const loginAttempts = new Map();
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPT_MAX = 8;
const throttleLoginAttempt = (key) => {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { windowStart: now, count: 1 });
    return;
  }
  entry.count += 1;
  if (entry.count > LOGIN_ATTEMPT_MAX) {
    throw Object.assign(new Error('Too many attempts. Please wait a few minutes and try again.'), { status: 429 });
  }
};

const JOURNAL_MOODS = ['happy', 'calm', 'okay', 'tired', 'anxious', 'sad'];

const defaultState = () => ({
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
  memories: [],
  places: [],
  objects: [],
  patientAccounts: [],
  familyContributions: [],

  // ---- Cognitive Independence Engine ----
  // Observation records the adaptive assistance logic reads.
  routines: [],          // { id, name, steps[], safetyLevel, safetyFloor, safetyCeiling }
  taskAttempts: [],      // { id, taskId, at, assistanceLevel, cueType, outcome, durationMs, caregiverInvolved }
  assistanceEvents: [],  // { id, taskId, at, level, cueType, reason, accepted }
  intentions: [],        // { id, at, goal, destination, sourceText, status }
  questionEvents: [],    // { id, at, text, topic, answeredWith, responseMode }
  behaviourEvents: [],   // { id, at, behaviour, antecedent, contextTags[], intervention, outcome, notes }
  medications: [],       // { id, name, dose, schedule[], instructions, prescriber, addedBy }
  medicationLogs: [],    // { id, at, medicationId, name, status, confirmedBy }
  personhood: null,      // My Story, identity, life chapters, preferences, comfort profile
  supportProfile: 'moderate', // lower | moderate | high, configured by the care team, never inferred
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
    googleCalendarSync: false,
    elderMode: false,
    familyShareSalt: '',
    stimulationLevel: 2,
  },
  updatedAt: new Date().toISOString(),
});

const legacyStateRowId = (ownerId) => `meco_${crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 28)}`;
const stateRowPrefix = (ownerId) => `meco_${crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 20)}`;
const stateManifestId = (ownerId) => `${stateRowPrefix(ownerId)}_meta`;
const stateChunkId = (ownerId, index) => `${stateRowPrefix(ownerId)}_${String(index).padStart(4, '0')}`;
const ownerFileKey = (ownerId) => crypto.createHash('sha256').update(ownerId).digest('hex');
const APPWRITE_PAYLOAD_CHUNK = 18000;
const MAX_ENCODED_STATE_BYTES = 8 * 1024 * 1024;
const encodePayload = (state) => `gz:${zlib.gzipSync(Buffer.from(JSON.stringify(state))).toString('base64')}`;
const decodePayload = (value) => {
  if (!value) return defaultState();
  try {
    if (String(value).startsWith('gz:')) {
      return JSON.parse(zlib.gunzipSync(Buffer.from(String(value).slice(3), 'base64')).toString('utf8'));
    }
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return defaultState();
  }
};

const appwriteConfig = () => ({
  endpoint: env('APPWRITE_ENDPOINT', env('VITE_APPWRITE_ENDPOINT', 'https://sgp.cloud.appwrite.io/v1')).replace(/\/$/, ''),
  projectId: env('APPWRITE_PROJECT_ID', env('VITE_APPWRITE_PROJECT_ID')),
  databaseId: env('APPWRITE_DATABASE_ID', env('VITE_APPWRITE_DATABASE_ID')),
  tableId: env('APPWRITE_TABLE_ID', env('VITE_APPWRITE_TABLE_ID', 'meco_records')),
  apiKey: env('APPWRITE_API_KEY'),
});

const appwriteReady = () => {
  const config = appwriteConfig();
  return Boolean(config.endpoint && config.projectId && config.databaseId && config.tableId && config.apiKey);
};

const appwriteRequest = async (method, route, body) => {
  const config = appwriteConfig();
  const response = await fetch(`${config.endpoint}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Appwrite-Project': config.projectId,
      'X-Appwrite-Key': config.apiKey,
      'X-Appwrite-Response-Format': '1.9.5',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) throw Object.assign(new Error(data.message || `Appwrite request failed (${response.status}).`), { status: response.status, appwrite: true });
  return data;
};

const appwriteRowRoute = (rowId = '') => {
  const config = appwriteConfig();
  return `/tablesdb/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(config.tableId)}/rows${rowId ? `/${encodeURIComponent(rowId)}` : ''}`;
};

const appwriteGetRow = async (rowId) => appwriteRequest('GET', appwriteRowRoute(rowId));
const appwriteUpsertRow = async (rowId, data) => {
  await appwriteRequest('PUT', appwriteRowRoute(rowId), { data, permissions: [] });
};
const appwriteDeleteRow = async (rowId) => {
  try { await appwriteRequest('DELETE', appwriteRowRoute(rowId)); }
  catch (error) { if (error.status !== 404) throw error; }
};
const parseManifest = (row) => {
  try {
    const value = JSON.parse(row?.payload || '{}');
    const chunks = Number(value.chunks || 0);
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > 1000) throw new Error('Invalid chunk count.');
    return { chunks, encoding: value.encoding || 'gzip-base64-v1' };
  } catch { throw new Error('The Appwrite state manifest is invalid.'); }
};

const loadFileStates = async () => {
  try { return JSON.parse(await fsp.readFile(DATA_FILE, 'utf8')); } catch { return {}; }
};

let fileWriteQueue = Promise.resolve();
const saveFileState = async (ownerId, state) => {
  fileWriteQueue = fileWriteQueue.then(async () => {
    await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const all = await loadFileStates();
    all[ownerFileKey(ownerId)] = state;
    const temp = `${DATA_FILE}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(all, null, 2));
    await fsp.rename(temp, DATA_FILE);
  });
  return fileWriteQueue;
};

const loadState = async (ownerId) => {
  if (appwriteReady()) {
    try {
      const manifestRow = await appwriteGetRow(stateManifestId(ownerId));
      const manifest = parseManifest(manifestRow);
      const pieces = [];
      for (let index = 0; index < manifest.chunks; index += 1) {
        const row = await appwriteGetRow(stateChunkId(ownerId, index));
        pieces.push(String(row.payload || ''));
      }
      return { state: decodePayload(pieces.join('')), backend: 'appwrite' };
    } catch (error) {
      if (error.status === 404) {
        try {
          const legacy = await appwriteGetRow(legacyStateRowId(ownerId));
          return { state: decodePayload(legacy.payload), backend: 'appwrite' };
        } catch (legacyError) {
          if (legacyError.status !== 404) console.warn('[Meco] Legacy Appwrite load failed:', legacyError.message);
        }
      } else {
        console.warn('[Meco] Appwrite load failed; using hashed-user local fallback:', error.message);
      }
    }
  }
  const all = await loadFileStates();
  return { state: all[ownerFileKey(ownerId)] || defaultState(), backend: appwriteReady() ? 'local-fallback' : 'local' };
};

const saveState = async (ownerId, incomingValue) => {
  const incoming = incomingValue && typeof incomingValue === 'object' && !Array.isArray(incomingValue) ? incomingValue : {};
  const state = {
    ...defaultState(),
    ...incoming,
    visitors: Array.isArray(incoming.visitors) ? incoming.visitors.slice(0, 200) : [],
    sessions: Array.isArray(incoming.sessions) ? incoming.sessions.slice(0, 300) : [],
    visits: Array.isArray(incoming.visits) ? incoming.visits.slice(0, 500) : [],
    reminders: Array.isArray(incoming.reminders) ? incoming.reminders.slice(0, 500) : [],
    companionChats: Array.isArray(incoming.companionChats)
      ? incoming.companionChats.slice(0, 60).map((chat) => ({
          ...chat,
          title: String(chat.title || '').slice(0, 90),
          messages: Array.isArray(chat.messages) ? chat.messages.slice(-80) : [],
        }))
      : [],
    companionOverview: incoming.companionOverview && typeof incoming.companionOverview === 'object' ? incoming.companionOverview : null,
    journalEntries: Array.isArray(incoming.journalEntries)
      ? incoming.journalEntries.slice(0, 200).map((entry) => ({
          id: String(entry?.id || '').slice(0, 80),
          title: String(entry?.title || '').slice(0, 90),
          mood: JOURNAL_MOODS.includes(entry?.mood) ? entry.mood : 'okay',
          // Client re-sanitizes html on render, so a tampered PUT cannot do much.
          html: String(entry?.html || '').slice(0, 20000),
          text: String(entry?.text || '').slice(0, 4000),
          createdAt: entry?.createdAt ? String(entry.createdAt) : new Date().toISOString(),
        }))
      : [],
    // Memory Graph arrays. Same cap-and-coerce as everything above.
    memories: Array.isArray(incoming.memories) ? incoming.memories.slice(0, 500) : [],
    places: Array.isArray(incoming.places) ? incoming.places.slice(0, 100) : [],
    objects: Array.isArray(incoming.objects) ? incoming.objects.slice(0, 50) : [],
    // Metadata only. The passcode hash lives in the patient-lookup row.
    patientAccounts: Array.isArray(incoming.patientAccounts)
      ? incoming.patientAccounts.slice(0, 20).map((p) => ({
          id: String(p?.id || '').slice(0, 40),
          name: String(p?.name || '').slice(0, 80),
          createdAt: p?.createdAt ? String(p.createdAt) : new Date().toISOString(),
        })).filter((p) => p.id)
      : [],
    familyContributions: Array.isArray(incoming.familyContributions) ? incoming.familyContributions.slice(0, 200) : [],

    // Engine logs. Highest-volume arrays here, so they get bigger caps.
    routines: Array.isArray(incoming.routines) ? incoming.routines.slice(0, 60) : [],
    taskAttempts: Array.isArray(incoming.taskAttempts) ? incoming.taskAttempts.slice(0, 3000) : [],
    assistanceEvents: Array.isArray(incoming.assistanceEvents) ? incoming.assistanceEvents.slice(0, 3000) : [],
    intentions: Array.isArray(incoming.intentions) ? incoming.intentions.slice(0, 200) : [],
    questionEvents: Array.isArray(incoming.questionEvents) ? incoming.questionEvents.slice(0, 1000) : [],
    behaviourEvents: Array.isArray(incoming.behaviourEvents) ? incoming.behaviourEvents.slice(0, 1000) : [],
    medications: Array.isArray(incoming.medications) ? incoming.medications.slice(0, 60) : [],
    medicationLogs: Array.isArray(incoming.medicationLogs) ? incoming.medicationLogs.slice(0, 2000) : [],
    personhood: incoming.personhood && typeof incoming.personhood === 'object' ? incoming.personhood : null,
    supportProfile: ['lower', 'moderate', 'high'].includes(incoming.supportProfile) ? incoming.supportProfile : 'moderate',
    cognitiveAttempts: Array.isArray(incoming.cognitiveAttempts) ? incoming.cognitiveAttempts.slice(0, 500) : [],
    reminiscenceCollections: Array.isArray(incoming.reminiscenceCollections) ? incoming.reminiscenceCollections.slice(0, 50) : [],
    retrievalItems: Array.isArray(incoming.retrievalItems) ? incoming.retrievalItems.slice(0, 200) : [],
    retrievalAttempts: Array.isArray(incoming.retrievalAttempts) ? incoming.retrievalAttempts.slice(0, 1000) : [],
    settings: { ...defaultState().settings, ...(incoming.settings || {}) },
    updatedAt: new Date().toISOString(),
  };
  const payload = encodePayload(state);
  if (Buffer.byteLength(payload, 'utf8') > MAX_ENCODED_STATE_BYTES) {
    throw Object.assign(new Error('This Meco account has exceeded the current 8 MB compressed state limit. Export or remove older recordings and reports.'), { status: 413 });
  }
  if (appwriteReady()) {
    const chunks = [];
    for (let offset = 0; offset < payload.length; offset += APPWRITE_PAYLOAD_CHUNK) chunks.push(payload.slice(offset, offset + APPWRITE_PAYLOAD_CHUNK));
    const now = new Date().toISOString();
    let oldChunkCount = 0;
    try { oldChunkCount = parseManifest(await appwriteGetRow(stateManifestId(ownerId))).chunks; } catch {}
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        await appwriteUpsertRow(stateChunkId(ownerId, index), {
          owner_id: ownerId,
          entity: 'meco_state_chunk',
          payload: chunks[index],
          created_date: now,
          updated_date: now,
        });
      }
      await appwriteUpsertRow(stateManifestId(ownerId), {
        owner_id: ownerId,
        entity: 'meco_state_manifest',
        payload: JSON.stringify({ version: 1, encoding: 'gzip-base64-v1', chunks: chunks.length }),
        created_date: now,
        updated_date: now,
      });
      for (let index = chunks.length; index < oldChunkCount; index += 1) {
        await appwriteDeleteRow(stateChunkId(ownerId, index));
      }
      return { state, backend: 'appwrite' };
    } catch (error) {
      console.warn('[Meco] Appwrite save failed; using local fallback:', error.message);
    }
  }
  await saveFileState(ownerId, state);
  return { state, backend: appwriteReady() ? 'local-fallback' : 'local' };
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = 30000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
};

// One way, Meco -> Google. Meco stays the source of truth.
const clerkBackendRequest = async (route, options = {}) => {
  const secretKey = env('CLERK_SECRET_KEY');
  if (!secretKey) throw Object.assign(new Error('CLERK_SECRET_KEY is not configured.'), { status: 503 });
  const response = await fetchWithTimeout(`https://api.clerk.com/v1${route}`, {
    ...options,
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.errors?.[0]?.message || `Clerk API request failed (${response.status}).`), { status: response.status });
  return data;
};

const getGoogleAccessToken = async (userId) => {
  const result = await clerkBackendRequest(`/users/${encodeURIComponent(userId)}/oauth_access_tokens/oauth_google`);
  const token = Array.isArray(result) ? result[0]?.token : result?.data?.[0]?.token;
  if (!token) throw Object.assign(new Error('Connect Google Calendar in Settings first.'), { status: 409 });
  return token;
};

const REPEAT_DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// Only weekly-on-selected-days is exposed, so that is all we build.
const buildRecurrenceRule = (repeat) => {
  const days = repeat?.freq === 'weekly' ? (repeat.days || []).filter((day) => REPEAT_DAY_CODES.includes(day)) : [];
  return days.length ? [`RRULE:FREQ=WEEKLY;BYDAY=${days.join(',')}`] : [];
};

// Google's all-day end.date is exclusive, hence start + 1 day.
const googleCalendarEventBody = ({ title, description, date, time, endTime, timeZone, repeat }) => {
  const recurrence = buildRecurrenceRule(repeat);
  if (time) {
    const start = new Date(`${date}T${time}:00`);
    const endOfDay = new Date(`${date}T23:59:59`);
    const requestedEnd = endTime ? new Date(`${date}T${endTime}:00`) : endOfDay;
    const end = requestedEnd > start ? requestedEnd : endOfDay;
    return { summary: title, description: description || undefined, start: { dateTime: start.toISOString(), timeZone }, end: { dateTime: end.toISOString(), timeZone }, recurrence };
  }
  const end = new Date(`${date}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return { summary: title, description: description || undefined, start: { date }, end: { date: end.toISOString().slice(0, 10) }, recurrence };
};

const googleCalendarRequest = async (accessToken, method, path, body) => {
  const response = await fetchWithTimeout(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'DELETE') {
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(data.error?.message || `Google Calendar request failed (${response.status}).`), { status: response.status });
    }
    return null;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `Google Calendar request failed (${response.status}).`), { status: response.status });
  return data;
};

const assemblyTranscribe = async (audio, contentType, expectedSpeakers) => {
  const apiKey = env('ASSEMBLYAI_API_KEY');
  if (!apiKey) throw Object.assign(new Error('ASSEMBLYAI_API_KEY is not configured.'), { status: 503 });
  const uploadResponse = await fetchWithTimeout('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': contentType || 'application/octet-stream' },
    body: audio,
  }, 120000);
  const uploadData = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || !uploadData.upload_url) {
    throw new Error(uploadData.error || `AssemblyAI upload failed (${uploadResponse.status}).`);
  }
  const speakers = Math.max(2, Math.min(10, Number(expectedSpeakers || 2)));
  const submitResponse = await fetchWithTimeout('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: uploadData.upload_url,
      speaker_labels: true,
      speakers_expected: speakers,
      speech_models: [env('ASSEMBLYAI_SPEECH_MODEL', 'universal-3-5-pro'), 'universal-2'],
      format_text: true,
      punctuate: true,
      language_detection: true,
      disfluencies: false,
      prompt: 'A warm family or caregiver visit involving a person receiving memory support. Preserve names, family relationships, places, routines, and meaningful memories accurately.',
    }),
  });
  const submitData = await submitResponse.json().catch(() => ({}));
  if (!submitResponse.ok || !submitData.id) {
    throw new Error(submitData.error || `AssemblyAI transcript submission failed (${submitResponse.status}).`);
  }
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const pollResponse = await fetchWithTimeout(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(submitData.id)}`, {
      headers: { Authorization: apiKey },
    }, 30000);
    const result = await pollResponse.json().catch(() => ({}));
    if (!pollResponse.ok) throw new Error(result.error || `AssemblyAI polling failed (${pollResponse.status}).`);
    if (result.status === 'error') throw new Error(result.error || 'AssemblyAI transcription failed.');
    if (result.status === 'completed') {
      const utterances = (result.utterances || []).map((item, index) => ({
        id: `${submitData.id}_${index}`,
        speaker: item.speaker || '?',
        text: item.text || '',
        start: item.start || 0,
        end: item.end || 0,
        confidence: item.confidence ?? null,
      }));
      return {
        provider: 'assemblyai',
        transcriptId: submitData.id,
        text: result.text || utterances.map((item) => item.text).join(' '),
        utterances,
        confidence: result.confidence ?? null,
        languageCode: result.language_code || null,
        speechModel: result.speech_model_used || env('ASSEMBLYAI_SPEECH_MODEL', 'universal-3-5-pro'),
      };
    }
  }
  throw new Error('AssemblyAI transcription timed out after 10 minutes.');
};

const summarySchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    emotionalTone: { type: 'string' },
    engagementScore: { type: 'integer', minimum: 0, maximum: 100 },
    memoryCues: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    topicsDiscussed: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    caregiverInsights: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    followUpPrompt: { type: 'string' },
    safetyNote: { type: 'string' },
  },
  required: ['summary', 'emotionalTone', 'engagementScore', 'memoryCues', 'topicsDiscussed', 'caregiverInsights', 'followUpPrompt', 'safetyNote'],
};

const normalizeTranscriptText = (transcript = []) => {
  if (typeof transcript === 'string') return transcript;
  if (!Array.isArray(transcript)) return '';
  return transcript.map((line) => {
    const speaker = line.displaySpeaker || line.speaker || 'Speaker';
    return `${speaker}: ${line.text || ''}`;
  }).join('\n');
};

const stripFence = (text = '') => String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
const parseModelJson = (text) => JSON.parse(stripFence(text));

const summaryPrompt = ({ visitorName, relationship, transcript }) => `Create a caregiver-friendly visit report for Meco, a memory companion app.
Visitor: ${visitorName || 'Visitor'}
Relationship: ${relationship || 'Not specified'}

Transcript:\n${normalizeTranscriptText(transcript).slice(0, 80000)}

Requirements:
- Describe what happened without diagnosing or making medical claims.
- Highlight moments of recognition, comfort, confusion, interests, names, places, routines, and useful future conversation cues.
- Be compassionate, precise, and brief.
- engagementScore is an observational communication score, not a clinical score.
- safetyNote must state that this report supports caregiver review and is not medical advice.
Return only JSON matching this schema:\n${JSON.stringify(summarySchema)}`;

const normalizeSummaryResult = (value, provider, model) => {
  const result = value && typeof value === 'object' ? value : {};
  const list = (input, limit) => (Array.isArray(input) ? input : []).map((item) => String(item || '').trim()).filter(Boolean).slice(0, limit);
  const score = Number(result.engagementScore);
  return {
    provider,
    model,
    summary: String(result.summary || 'No summary was returned.').trim(),
    emotionalTone: String(result.emotionalTone || 'Not enough information').trim(),
    engagementScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    memoryCues: list(result.memoryCues, 5),
    topicsDiscussed: list(result.topicsDiscussed, 6),
    caregiverInsights: list(result.caregiverInsights, 5),
    followUpPrompt: String(result.followUpPrompt || 'Would you like to look at a familiar photograph together?').trim(),
    safetyNote: String(result.safetyNote || 'This report supports caregiver review and is not medical advice.').trim(),
  };
};

const callGeminiSummary = async (payload) => {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini key is not configured.');
  const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You create factual, compassionate caregiver visit summaries. Never diagnose. Return valid JSON only.' }] },
      contents: [{ role: 'user', parts: [{ text: summaryPrompt(payload) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: summarySchema },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini failed (${response.status}).`);
  const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || '').join('\n');
  return normalizeSummaryResult(parseModelJson(text), 'gemini', model);
};

const callGroqSummary = async (payload) => {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Groq key is not configured.');
  const model = env('GROQ_MODEL', 'llama-3.3-70b-versatile');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You create factual, compassionate caregiver visit summaries. Never diagnose. Return valid JSON only.' },
        { role: 'user', content: summaryPrompt(payload) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Groq failed (${response.status}).`);
  return normalizeSummaryResult(parseModelJson(data.choices?.[0]?.message?.content || '{}'), 'groq', model);
};

const localSummary = ({ visitorName, transcript }) => {
  const lines = Array.isArray(transcript) ? transcript.filter((line) => line.text) : [];
  const words = normalizeTranscriptText(transcript).split(/\s+/).filter(Boolean);
  const snippets = lines.slice(0, 4).map((line) => line.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return {
    provider: 'local-fallback',
    model: 'deterministic-summary',
    summary: `${visitorName || 'The visitor'} and the Meco member shared a ${lines.length ? 'recorded' : 'brief'} conversation. ${snippets.length ? `Key moments included: ${snippets.join(' / ').slice(0, 420)}` : 'No detailed dialogue was available.'}`,
    emotionalTone: 'Warm and attentive',
    engagementScore: Math.max(20, Math.min(92, 45 + Math.round(words.length / 12))),
    memoryCues: snippets.slice(0, 3),
    topicsDiscussed: snippets.slice(0, 4).map((text) => text.split(/[.!?]/)[0].slice(0, 80)),
    caregiverInsights: ['Reuse familiar names and photographs.', 'Keep questions simple and allow time to answer.', 'Review the full transcript before adding notes to the care plan.'],
    followUpPrompt: 'Would you like to look at a familiar photo and tell me who is in it?',
    safetyNote: 'This report supports caregiver review and is not medical advice.',
  };
};

const generateSummary = async (payload) => {
  const order = env('AI_PROVIDER', 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const errors = [];
  for (const provider of order) {
    try {
      if (provider === 'gemini' && env('GEMINI_API_KEY')) return await callGeminiSummary(payload);
      if (provider === 'groq' && env('GROQ_API_KEY')) return await callGroqSummary(payload);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.warn(`[Meco] ${provider} summary failed:`, error.message);
    }
  }
  return { ...localSummary(payload), fallbackReason: errors.join(' | ') || 'No AI key configured.' };
};

// ---------- memory graph: extraction + recall ----------

const memoryExtractSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          details: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          confidence: { type: 'string', enum: ['fact', 'ai-inferred'] },
        },
        required: ['title', 'summary', 'details', 'tags', 'confidence'],
      },
    },
  },
  required: ['candidates'],
};

const memoryExtractPrompt = ({ visitorName, relationship, summary, transcript }) => `From this Meco visit, propose up to 3 distinct, specific autobiographical memories worth keeping as standalone "Memory Capsules" for someone living with memory loss and their family.
Visitor: ${visitorName || 'Visitor'}
Relationship: ${relationship || 'Not specified'}
Visit summary: ${summary || 'Not available'}
Transcript:\n${normalizeTranscriptText(transcript).slice(0, 60000)}

Requirements:
- Each candidate must be a specific, concrete moment or topic actually present in the material above, never invent an event that isn't there.
- title: short, under 8 words. summary: one sentence. details: 1-3 sentences, still grounded in the transcript/summary.
- confidence: "fact" only if the transcript directly states it happened; "ai-inferred" if you are synthesizing or paraphrasing rather than quoting a stated fact.
- tags: short lowercase keywords (people, places, activities, feelings).
- If nothing distinct and specific enough is present, return an empty candidates array rather than inventing one.
Return only JSON matching this schema:\n${JSON.stringify(memoryExtractSchema)}`;

const normalizeMemoryCandidates = (value, provider, model) => {
  const result = value && typeof value === 'object' ? value : {};
  const candidates = (Array.isArray(result.candidates) ? result.candidates : []).slice(0, 3).map((c) => ({
    title: String(c?.title || 'Untitled memory').trim().slice(0, 80),
    summary: String(c?.summary || '').trim().slice(0, 240),
    details: String(c?.details || '').trim().slice(0, 800),
    tags: (Array.isArray(c?.tags) ? c.tags : []).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean).slice(0, 6),
    confidence: c?.confidence === 'fact' ? 'fact' : 'ai-inferred',
  }));
  return { provider, model, candidates };
};

const callGeminiMemoryExtract = async (payload) => {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini key is not configured.');
  const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You extract specific, grounded autobiographical memories from real visit content. Never invent events. Return valid JSON only.' }] },
      contents: [{ role: 'user', parts: [{ text: memoryExtractPrompt(payload) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: memoryExtractSchema },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini failed (${response.status}).`);
  const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || '').join('\n');
  return normalizeMemoryCandidates(parseModelJson(text), 'gemini', model);
};

const callGroqMemoryExtract = async (payload) => {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Groq key is not configured.');
  const model = env('GROQ_MODEL', 'llama-3.3-70b-versatile');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You extract specific, grounded autobiographical memories from real visit content. Never invent events. Return valid JSON only.' },
        { role: 'user', content: memoryExtractPrompt(payload) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Groq failed (${response.status}).`);
  return normalizeMemoryCandidates(parseModelJson(data.choices?.[0]?.message?.content || '{}'), 'groq', model);
};

const generateMemoryExtract = async (payload) => {
  const order = env('AI_PROVIDER', 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const errors = [];
  for (const provider of order) {
    try {
      if (provider === 'gemini' && env('GEMINI_API_KEY')) return await callGeminiMemoryExtract(payload);
      if (provider === 'groq' && env('GROQ_API_KEY')) return await callGroqMemoryExtract(payload);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.warn(`[Meco] ${provider} memory extraction failed:`, error.message);
    }
  }
  // Nothing safe to paraphrase without AI, so return empty instead of guessing.
  return { provider: 'local-fallback', model: 'none', candidates: [], fallbackReason: errors.join(' | ') || 'No AI key configured.' };
};

const recallSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'string', enum: ['fact', 'family-provided', 'ai-inferred', 'insufficient-evidence'] },
    matches: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: { memoryId: { type: 'string' }, why: { type: 'string' } },
        required: ['memoryId', 'why'],
      },
    },
  },
  required: ['answer', 'confidence', 'matches'],
};

const recallPrompt = (query, digestJson) => `You are Meco's Recall Engine, you help someone reconstruct a memory from an incomplete natural-language clue, using ONLY the memories/people/places listed in the JSON below. Never invent a memory that is not in this data.
Query: "${String(query || '').slice(0, 500)}"
Available memory graph (JSON): ${digestJson}

Requirements:
- confidence "fact" only if a listed memory directly and unambiguously matches every detail in the query.
- confidence "family-provided" if the best-matching memory's own confidence field is "family-provided".
- confidence "ai-inferred" if you are piecing together a plausible answer from partial or indirect matches.
- confidence "insufficient-evidence" if nothing in the data meaningfully relates to the query, say so plainly in "answer" rather than guessing.
- matches: cite the specific memoryId(s) you actually used, each with a one-line "why".
- Never present an inferred or uncertain answer as a definite fact.
Return only JSON matching this schema:\n${JSON.stringify(recallSchema)}`;

const normalizeRecallResult = (value, provider, model, validMemoryIds) => {
  const result = value && typeof value === 'object' ? value : {};
  const allowedConfidence = ['fact', 'family-provided', 'ai-inferred', 'insufficient-evidence'];
  const matches = (Array.isArray(result.matches) ? result.matches : [])
    .filter((m) => m && validMemoryIds.has(m.memoryId))
    .slice(0, 5)
    .map((m) => ({ memoryId: m.memoryId, why: String(m.why || '').trim().slice(0, 200) }));
  return {
    provider,
    model,
    answer: String(result.answer || "I couldn't find enough information to answer that.").trim().slice(0, 600),
    confidence: allowedConfidence.includes(result.confidence) ? result.confidence : 'insufficient-evidence',
    matches,
  };
};

const callGeminiRecall = async (query, digest, validMemoryIds) => {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini key is not configured.');
  const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You reconstruct memories strictly from provided data. Never invent an event. Return valid JSON only.' }] },
      contents: [{ role: 'user', parts: [{ text: recallPrompt(query, digest) }] }],
      generationConfig: { temperature: 0.15, responseMimeType: 'application/json', responseJsonSchema: recallSchema },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini failed (${response.status}).`);
  const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || '').join('\n');
  return normalizeRecallResult(parseModelJson(text), 'gemini', model, validMemoryIds);
};

const callGroqRecall = async (query, digest, validMemoryIds) => {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Groq key is not configured.');
  const model = env('GROQ_MODEL', 'llama-3.3-70b-versatile');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You reconstruct memories strictly from provided data. Never invent an event. Return valid JSON only.' },
        { role: 'user', content: recallPrompt(query, digest) },
      ],
      temperature: 0.15,
      response_format: { type: 'json_object' },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Groq failed (${response.status}).`);
  return normalizeRecallResult(parseModelJson(data.choices?.[0]?.message?.content || '{}'), 'groq', model, validMemoryIds);
};

// Keyword-overlap fallback. Returns nothing rather than a bad guess.
const localRecall = (query, memories) => {
  const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored = memories.map((m) => {
    const hay = `${m.title} ${m.summary} ${(m.tags || []).join(' ')} ${(m.peopleNames || []).join(' ')} ${m.placeName || ''}`.toLowerCase();
    return { memory: m, score: words.reduce((sum, w) => sum + (hay.includes(w) ? 1 : 0), 0) };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) {
    return { provider: 'local-fallback', model: 'keyword-search', answer: "I couldn't find a memory matching that, try mentioning a name, place, or date.", confidence: 'insufficient-evidence', matches: [] };
  }
  const top = scored.slice(0, 3);
  return {
    provider: 'local-fallback',
    model: 'keyword-search',
    answer: `The closest match is "${top[0].memory.title}", ${top[0].memory.summary}`,
    confidence: 'ai-inferred',
    matches: top.map((s) => ({ memoryId: s.memory.id, why: 'Keyword match in title, summary, tags, people, or place.' })),
  };
};

const generateRecall = async (query, memories, digest) => {
  const validMemoryIds = new Set(memories.map((m) => m.id));
  const order = env('AI_PROVIDER', 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const errors = [];
  for (const provider of order) {
    try {
      if (provider === 'gemini' && env('GEMINI_API_KEY')) return await callGeminiRecall(query, digest, validMemoryIds);
      if (provider === 'groq' && env('GROQ_API_KEY')) return await callGroqRecall(query, digest, validMemoryIds);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.warn(`[Meco] ${provider} recall failed:`, error.message);
    }
  }
  return { ...localRecall(query, memories), fallbackReason: errors.join(' | ') || 'No AI key configured.' };
};

// After a summary, surface up to 3 related memories already on file.
const relatedMemoriesSchema = {
  type: 'object',
  properties: {
    related: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: { memoryId: { type: 'string' }, why: { type: 'string' } },
        required: ['memoryId', 'why'],
      },
    },
  },
  required: ['related'],
};

const relatedMemoriesPrompt = (summaryText, digestJson) => `A caregiver just recorded this visit summary for someone living with memory loss:
"${String(summaryText || '').slice(0, 800)}"

Here is their existing saved memory graph (JSON): ${digestJson}

From this list ONLY, pick up to 3 existing memories that are genuinely related to the new visit summary above (same person, place, topic, or theme), not just superficially similar wording. If nothing is genuinely related, return an empty array rather than forcing a match.
Return only JSON matching this schema:\n${JSON.stringify(relatedMemoriesSchema)}`;

const normalizeRelatedResult = (value, provider, model, validMemoryIds) => {
  const result = value && typeof value === 'object' ? value : {};
  const related = (Array.isArray(result.related) ? result.related : [])
    .filter((m) => m && validMemoryIds.has(m.memoryId))
    .slice(0, 3)
    .map((m) => ({ memoryId: m.memoryId, why: String(m.why || '').trim().slice(0, 160) }));
  return { provider, model, related };
};

const callGeminiRelated = async (summaryText, digest, validMemoryIds) => {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini key is not configured.');
  const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You connect a new visit to genuinely related existing memories, strictly from the provided data. Return valid JSON only.' }] },
      contents: [{ role: 'user', parts: [{ text: relatedMemoriesPrompt(summaryText, digest) }] }],
      generationConfig: { temperature: 0.15, responseMimeType: 'application/json', responseJsonSchema: relatedMemoriesSchema },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini failed (${response.status}).`);
  const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || '').join('\n');
  return normalizeRelatedResult(parseModelJson(text), 'gemini', model, validMemoryIds);
};

const callGroqRelated = async (summaryText, digest, validMemoryIds) => {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Groq key is not configured.');
  const model = env('GROQ_MODEL', 'llama-3.3-70b-versatile');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You connect a new visit to genuinely related existing memories, strictly from the provided data. Return valid JSON only.' },
        { role: 'user', content: relatedMemoriesPrompt(summaryText, digest) },
      ],
      temperature: 0.15,
      response_format: { type: 'json_object' },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Groq failed (${response.status}).`);
  return normalizeRelatedResult(parseModelJson(data.choices?.[0]?.message?.content || '{}'), 'groq', model, validMemoryIds);
};

// Local fallback: the same honest keyword-overlap approach as localRecall,
// scored against the new summary text instead of a user query.
const localRelated = (summaryText, memories) => {
  const words = String(summaryText || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const scored = memories.map((m) => {
    const hay = `${m.title} ${m.summary} ${(m.tags || []).join(' ')} ${(m.peopleNames || []).join(' ')} ${m.placeName || ''}`.toLowerCase();
    return { memory: m, score: words.reduce((sum, w) => sum + (hay.includes(w) ? 1 : 0), 0) };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return { provider: 'local-fallback', model: 'keyword-search', related: scored.slice(0, 3).map((s) => ({ memoryId: s.memory.id, why: "Keyword overlap with this visit's summary." })) };
};

const generateRelatedMemories = async (summaryText, memories, digest) => {
  const validMemoryIds = new Set(memories.map((m) => m.id));
  const order = env('AI_PROVIDER', 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const errors = [];
  for (const provider of order) {
    try {
      if (provider === 'gemini' && env('GEMINI_API_KEY')) return await callGeminiRelated(summaryText, digest, validMemoryIds);
      if (provider === 'groq' && env('GROQ_API_KEY')) return await callGroqRelated(summaryText, digest, validMemoryIds);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.warn(`[Meco] ${provider} related-memories failed:`, error.message);
    }
  }
  return { ...localRelated(summaryText, memories), fallbackReason: errors.join(' | ') || 'No AI key configured.' };
};

// ---------- family contributions (share-token inbox) ----------
// Outside Clerk entirely. Auth is possession of a signed token.
const familyShareSecret = () => env('FAMILY_SHARE_SECRET') || env('CLERK_SECRET_KEY') || 'meco-family-share-fallback-secret';

const signFamilyToken = (ownerId, salt) => {
  const payload = Buffer.from(ownerId, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', familyShareSecret()).update(`${payload}:${salt}`).digest('base64url').slice(0, 22);
  return `${payload}.${sig}`;
};

const familyTokenOwnerId = (token) => {
  const [payload] = String(token || '').split('.');
  if (!payload) return null;
  try { return Buffer.from(payload, 'base64url').toString('utf8'); } catch { return null; }
};

const verifyFamilyToken = (token, salt) => {
  const ownerId = familyTokenOwnerId(token);
  if (!ownerId || !salt) return null;
  const expected = signFamilyToken(ownerId, salt);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return ownerId;
};

const escapeHtmlServer = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Standalone page. No Clerk, no shared CSS, cannot touch the signed-in app.
const contributePageHtml = ({ patientName, visitors, token, error }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Share a memory, Meco</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f7f4ef; color:#1c1a17; padding:28px 18px 60px; }
  .wrap { max-width:520px; margin:0 auto; }
  h1 { font-size:26px; margin:0 0 6px; }
  p.sub { color:#605b54; margin:0 0 26px; line-height:1.5; }
  .card { background:#fff; border-radius:18px; padding:22px; box-shadow:0 10px 30px rgba(0,0,0,.06); display:grid; gap:16px; }
  label { display:block; font-size:13px; font-weight:700; margin-bottom:6px; }
  input, select, textarea { width:100%; padding:11px 12px; border:1px solid #ddd8ce; border-radius:11px; font-size:15px; font-family:inherit; background:#fbfaf7; }
  textarea { min-height:90px; resize:vertical; }
  button { appearance:none; border:0; border-radius:999px; padding:14px 20px; font-size:15px; font-weight:700; cursor:pointer; }
  .primary { background:#1c1a17; color:#fff; width:100%; }
  .primary:disabled { opacity:.5; }
  .field-hint { font-size:12px; color:#8a8479; margin-top:4px; }
  .rec-row { display:flex; gap:10px; align-items:center; }
  .rec-btn { background:#eee9df; border-radius:999px; padding:10px 16px; font-size:14px; font-weight:600; border:1px solid #ddd8ce; }
  .rec-btn.recording { background:#f4c9c0; }
  .status { margin-top:16px; padding:14px 16px; border-radius:12px; font-size:14px; display:none; }
  .status.ok { display:block; background:#dff0dc; color:#2f6b3a; }
  .status.error { display:block; background:#fbdcd8; color:#a13a2c; }
  audio { width:100%; }
</style></head>
<body><div class="wrap">
  <h1>Share a memory${patientName ? ` with ${escapeHtmlServer(patientName)}'s care circle` : ''}</h1>
  <p class="sub">A photo, a story, a voice message, or a correction: this goes to a caregiver to review before anything is added.</p>
  ${error ? `<div class="status error" style="display:block">${escapeHtmlServer(error)}</div>` : `
  <form class="card" id="contribute-form">
    <div><label>Your name</label><input id="c-name" required maxlength="80" placeholder="e.g. Maya"></div>
    <div><label>Your relationship</label><input id="c-relation" maxlength="80" placeholder="e.g. Granddaughter"></div>
    <div><label>Who is this about? (optional)</label><select id="c-about"><option value="">Not about one person</option>${visitors.map((v) => `<option value="${escapeHtmlServer(v.id)}">${escapeHtmlServer(v.name)}</option>`).join('')}</select></div>
    <div><label>What kind of contribution?</label><select id="c-type">
      <option value="story">A story or memory</option>
      <option value="photo">A photo</option>
      <option value="event">Something upcoming</option>
      <option value="correction">A correction</option>
      <option value="voice">A short voice message</option>
    </select></div>
    <div><label>Title</label><input id="c-title" required maxlength="80" placeholder="e.g. Our trip to the lake"></div>
    <div><label>Details</label><textarea id="c-text" maxlength="1000" placeholder="Tell the story, describe the photo, or say what should be corrected..."></textarea></div>
    <div id="photo-field"><label>Photo (optional)</label><input id="c-photo" type="file" accept="image/*"><div class="field-hint">Kept small automatically.</div></div>
    <div id="voice-field" style="display:none">
      <label>Voice message (optional)</label>
      <div class="rec-row"><button type="button" id="rec-btn" class="rec-btn">● Record</button><span id="rec-status" class="field-hint"></span></div>
      <audio id="rec-preview" controls style="display:none;margin-top:8px"></audio>
    </div>
    <button type="submit" class="primary" id="submit-btn">Send to the care circle</button>
  </form>
  <div id="form-status" class="status"></div>`}
</div>
<script>
(function(){
  var form = document.getElementById('contribute-form');
  if (!form) return;
  var typeSel = document.getElementById('c-type');
  var photoField = document.getElementById('photo-field');
  var voiceField = document.getElementById('voice-field');
  function syncFields(){
    var t = typeSel.value;
    voiceField.style.display = t === 'voice' ? '' : 'none';
    photoField.style.display = t === 'photo' ? '' : 'none';
  }
  typeSel.onchange = syncFields; syncFields();

  var photoDataUrl = null;
  document.getElementById('c-photo').onchange = function(e){
    var file = e.target.files[0]; if (!file) { photoDataUrl = null; return; }
    var reader = new FileReader();
    reader.onload = function(){ photoDataUrl = reader.result; };
    reader.readAsDataURL(file);
  };

  var mediaRecorder = null, chunks = [], voiceDataUrl = null;
  var recBtn = document.getElementById('rec-btn'), recStatus = document.getElementById('rec-status'), recPreview = document.getElementById('rec-preview');
  recBtn.onclick = async function(){
    if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function(e){ if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = function(){
        stream.getTracks().forEach(function(t){ t.stop(); });
        var blob = new Blob(chunks, { type: 'audio/webm' });
        var reader = new FileReader();
        reader.onload = function(){ voiceDataUrl = reader.result; recPreview.src = voiceDataUrl; recPreview.style.display = ''; };
        reader.readAsDataURL(blob);
        recBtn.textContent = '● Record again'; recBtn.classList.remove('recording'); recStatus.textContent = 'Recorded.';
      };
      mediaRecorder.start();
      recBtn.textContent = '■ Stop'; recBtn.classList.add('recording'); recStatus.textContent = 'Recording…';
    } catch (err) { recStatus.textContent = 'Microphone not available.'; }
  };

  form.onsubmit = async function(e){
    e.preventDefault();
    var statusEl = document.getElementById('form-status');
    var submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = true;
    statusEl.className = 'status'; statusEl.textContent = '';
    try {
      var res = await fetch('/api/contribute/${token}', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: typeSel.value,
          contributorName: document.getElementById('c-name').value,
          contributorRelation: document.getElementById('c-relation').value,
          payload: {
            aboutVisitorId: document.getElementById('c-about').value,
            title: document.getElementById('c-title').value,
            text: document.getElementById('c-text').value,
            photoDataUrl: photoDataUrl,
            voiceDataUrl: voiceDataUrl,
          },
        }),
      });
      var data = await res.json().catch(function(){ return {}; });
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      form.style.display = 'none';
      statusEl.className = 'status ok';
      statusEl.textContent = 'Thank you. This has been sent for review.';
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = err.message;
      submitBtn.disabled = false;
    }
  };
})();
</script>
</body></html>`;

// ---------- companion chat ----------
// Low-stakes companion for patients who are alone between visits.
const companionSystemPrompt = (patientName, historyContext) => `You are Meco, a warm and patient companion inside a memory-care app. You are talking with ${patientName || 'a person'}, who may have memory difficulties and could be feeling lonely. Your only job is to be a good, caring listener, like a kind friend checking in.

Rules:
- Keep every reply short: one to three simple sentences. Never write long paragraphs.
- Ask gentle, open follow-up questions to keep the conversation going, the way a caring friend would.
- Use validation, not correction. If something they say seems confused, mixed up, or doesn't add up, do not argue or correct the facts. Acknowledge the feeling behind what they said and gently continue.
- Never claim to be a real person. If asked, say honestly and warmly that you are Meco, an AI companion, not a real person.
- Never give medical, legal or medication advice. If asked, gently suggest they mention it to their caregiver or doctor.
- If they express sadness, fear, loneliness or distress, lead with warmth and comfort before anything else.
- Keep language simple. No jargon, no complicated words.${historyContext ? `
- You have some background on their recent life below, past visits, journal entries, reminders and earlier chats with you. Use it only when it's actually relevant (e.g. they ask who visited, or mention someone/something from it) so you can answer specifically and warmly. Never recite it unprompted or turn the conversation into a recap. If what they say doesn't match it, don't correct them with it, validation still comes first.
- The people-they-know list includes a memory cue for each person. If the conversation has a natural opening (a lull, or they mention that person) you may gently invite them to reminisce about it ("What do you remember about...?") rather than only waiting to be asked. This is a real, gentle dementia-care technique, not smalltalk filler, so use it sparingly and warmly, never back-to-back and never if they seem tired or distressed.

Background (for context only):
${historyContext}` : ''}`;

const callGeminiChat = async (patientName, messages, historyContext) => {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini key is not configured.');
  const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: companionSystemPrompt(patientName, historyContext) }] },
      contents: messages.map((item) => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.text }] })),
      generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
    }),
  }, 30000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini failed (${response.status}).`);
  const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || '').join('\n').trim();
  if (!text) throw new Error('Gemini returned an empty reply.');
  return { text, provider: 'gemini', model };
};

const callGroqChat = async (patientName, messages, historyContext) => {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Groq key is not configured.');
  const model = env('GROQ_MODEL', 'llama-3.3-70b-versatile');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: companionSystemPrompt(patientName, historyContext) },
        ...messages.map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.text })),
      ],
      temperature: 0.7,
      max_tokens: 200,
    }),
  }, 30000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Groq failed (${response.status}).`);
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Groq returned an empty reply.');
  return { text, provider: 'groq', model };
};

const localCompanionReply = () => ({
  text: "I'm here, and I'm listening. Would you like to tell me more?",
  provider: 'local-fallback',
  model: 'deterministic-reply',
});

const generateCompanionReply = async (patientName, messages, historyContext) => {
  const order = env('AI_PROVIDER', 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const errors = [];
  for (const provider of order) {
    try {
      if (provider === 'gemini' && env('GEMINI_API_KEY')) return await callGeminiChat(patientName, messages, historyContext);
      if (provider === 'groq' && env('GROQ_API_KEY')) return await callGroqChat(patientName, messages, historyContext);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.warn(`[Meco] ${provider} companion chat failed:`, error.message);
    }
  }
  return { ...localCompanionReply(), fallbackReason: errors.join(' | ') || 'No AI key configured.' };
};

// Per-conversation wellbeing signal. Explicitly not a diagnosis.
const companionAnalysisSchema = {
  type: 'object',
  properties: {
    note: { type: 'string' },
    moodWords: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    wellbeingScore: { type: 'integer', minimum: 0, maximum: 100 },
    flagged: { type: 'boolean' },
    flagReason: { type: 'string' },
    safetyNote: { type: 'string' },
  },
  required: ['note', 'moodWords', 'wellbeingScore', 'flagged', 'flagReason', 'safetyNote'],
};

const companionAnalysisPrompt = (patientName, messages) => `Review this single casual conversation between ${patientName || 'a Meco member'} (who may have memory difficulties) and Meco, an AI companion. This is one chat, not a clinical interview.

Conversation:
${messages.map((item) => `${item.role === 'assistant' ? 'Meco' : (patientName || 'Patient')}: ${item.text}`).join('\n').slice(0, 40000)}

Requirements:
- note: one or two warm, plain-language sentences describing the mood and topics of this conversation only.
- moodWords: up to 4 short words or phrases describing the tone you noticed (e.g. "calm", "a little confused", "cheerful").
- wellbeingScore: a 0-100 rough indicator of conversational engagement and mood in THIS CHAT ONLY, based purely on language patterns. This is not a clinical or diagnostic score.
- flagged: true only if the conversation contains real signs of distress, sadness, hopelessness, fear, confusion well beyond normal, or any safety concern a caregiver should look at directly.
- flagReason: one short plain sentence explaining why, if flagged. Empty string if not.
- safetyNote: always plainly state that this is an informal, non-clinical observation and is not a substitute for professional evaluation.
Return only JSON matching this schema:\n${JSON.stringify(companionAnalysisSchema)}`;

const normalizeCompanionAnalysis = (value, provider, model) => {
  const result = value && typeof value === 'object' ? value : {};
  const score = Number(result.wellbeingScore);
  return {
    provider,
    model,
    note: String(result.note || 'No observation was returned.').trim(),
    moodWords: (Array.isArray(result.moodWords) ? result.moodWords : []).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 4),
    wellbeingScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    flagged: Boolean(result.flagged),
    flagReason: String(result.flagReason || '').trim(),
    safetyNote: String(result.safetyNote || 'This is an informal, non-clinical observation and is not a substitute for professional evaluation.').trim(),
  };
};

const callGeminiAnalysis = async (patientName, messages) => {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini key is not configured.');
  const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You produce brief, compassionate, non-clinical observations about casual conversations. Never diagnose. Return valid JSON only.' }] },
      contents: [{ role: 'user', parts: [{ text: companionAnalysisPrompt(patientName, messages) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: companionAnalysisSchema },
    }),
  }, 45000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini failed (${response.status}).`);
  const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || '').join('\n');
  return normalizeCompanionAnalysis(parseModelJson(text), 'gemini', model);
};

const callGroqAnalysis = async (patientName, messages) => {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Groq key is not configured.');
  const model = env('GROQ_MODEL', 'llama-3.3-70b-versatile');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You produce brief, compassionate, non-clinical observations about casual conversations. Never diagnose. Return valid JSON only.' },
        { role: 'user', content: companionAnalysisPrompt(patientName, messages) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  }, 45000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Groq failed (${response.status}).`);
  return normalizeCompanionAnalysis(parseModelJson(data.choices?.[0]?.message?.content || '{}'), 'groq', model);
};

const localCompanionAnalysis = (messages) => {
  const patientWords = messages.filter((item) => item.role !== 'assistant').map((item) => item.text).join(' ').split(/\s+/).filter(Boolean);
  return {
    provider: 'local-fallback',
    model: 'deterministic-analysis',
    note: 'A conversation was recorded. Connect an AI provider (Gemini or Groq) for a mood observation.',
    moodWords: [],
    wellbeingScore: Math.max(20, Math.min(85, 40 + Math.round(patientWords.length / 4))),
    flagged: false,
    flagReason: '',
    safetyNote: 'This is an informal, non-clinical observation and is not a substitute for professional evaluation.',
  };
};

const generateCompanionAnalysis = async (patientName, messages) => {
  const order = env('AI_PROVIDER', 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const errors = [];
  for (const provider of order) {
    try {
      if (provider === 'gemini' && env('GEMINI_API_KEY')) return await callGeminiAnalysis(patientName, messages);
      if (provider === 'groq' && env('GROQ_API_KEY')) return await callGroqAnalysis(patientName, messages);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.warn(`[Meco] ${provider} companion analysis failed:`, error.message);
    }
  }
  return { ...localCompanionAnalysis(messages), fallbackReason: errors.join(' | ') || 'No AI key configured.' };
};

// Overall signal from the per-chat analyses already on file.
const companionOverviewSchema = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    trend: { type: 'string' },
    summary: { type: 'string' },
    safetyNote: { type: 'string' },
  },
  required: ['score', 'trend', 'summary', 'safetyNote'],
};

const companionOverviewPrompt = (patientName, chats) => `You are looking across a short history of casual companion-chat conversations between ${patientName || 'a Meco member'} (who may have memory difficulties) and Meco, an AI companion. Each conversation already has its own informal wellbeing signal. Look at the pattern across all of them together.

Conversations, oldest first:
${chats.map((chat, index) => `${index + 1}. ${chat.startedAt}: signal ${chat.wellbeingScore}/100, mood: ${(chat.moodWords || []).join(', ') || 'not noted'}${chat.flagged ? ' [FLAGGED FOR REVIEW]' : ''}, ${chat.note}`).join('\n').slice(0, 20000)}

Requirements:
- score: a 0-100 overall rough indicator, weighing more recent conversations more heavily. This is not a clinical or diagnostic score.
- trend: one short phrase describing the pattern over time (e.g. "Fairly steady", "Seems to be brightening recently", "A few harder days recently").
- summary: one or two warm, plain-language sentences describing the overall pattern noticed across these conversations.
- safetyNote: always plainly state this is an informal, non-clinical overview of casual conversation and not a substitute for professional evaluation.
Return only JSON matching this schema:\n${JSON.stringify(companionOverviewSchema)}`;

const normalizeCompanionOverview = (value, provider, model) => {
  const result = value && typeof value === 'object' ? value : {};
  const score = Number(result.score);
  return {
    provider,
    model,
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    trend: String(result.trend || 'Not enough conversations yet').trim(),
    summary: String(result.summary || 'No overview was returned.').trim(),
    safetyNote: String(result.safetyNote || 'This is an informal, non-clinical overview of casual conversation and not a substitute for professional evaluation.').trim(),
    computedAt: new Date().toISOString(),
  };
};

const callGeminiOverview = async (patientName, chats) => {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('Gemini key is not configured.');
  const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You produce brief, compassionate, non-clinical overviews of conversation patterns over time. Never diagnose. Return valid JSON only.' }] },
      contents: [{ role: 'user', parts: [{ text: companionOverviewPrompt(patientName, chats) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: companionOverviewSchema },
    }),
  }, 45000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini failed (${response.status}).`);
  const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || '').join('\n');
  return normalizeCompanionOverview(parseModelJson(text), 'gemini', model);
};

const callGroqOverview = async (patientName, chats) => {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Groq key is not configured.');
  const model = env('GROQ_MODEL', 'llama-3.3-70b-versatile');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You produce brief, compassionate, non-clinical overviews of conversation patterns over time. Never diagnose. Return valid JSON only.' },
        { role: 'user', content: companionOverviewPrompt(patientName, chats) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  }, 45000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Groq failed (${response.status}).`);
  return normalizeCompanionOverview(parseModelJson(data.choices?.[0]?.message?.content || '{}'), 'groq', model);
};

const localCompanionOverview = (chats) => {
  const avg = chats.length ? Math.round(chats.reduce((sum, chat) => sum + (Number(chat.wellbeingScore) || 0), 0) / chats.length) : 0;
  return {
    provider: 'local-fallback',
    model: 'deterministic-overview',
    score: avg,
    trend: 'Not enough information',
    summary: 'Connect an AI provider (Gemini or Groq) for an overall pattern overview.',
    safetyNote: 'This is an informal, non-clinical overview of casual conversation and not a substitute for professional evaluation.',
    computedAt: new Date().toISOString(),
  };
};

const generateCompanionOverview = async (patientName, chats) => {
  const order = env('AI_PROVIDER', 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const errors = [];
  for (const provider of order) {
    try {
      if (provider === 'gemini' && env('GEMINI_API_KEY')) return await callGeminiOverview(patientName, chats);
      if (provider === 'groq' && env('GROQ_API_KEY')) return await callGroqOverview(patientName, chats);
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.warn(`[Meco] ${provider} companion overview failed:`, error.message);
    }
  }
  return { ...localCompanionOverview(chats), fallbackReason: errors.join(' | ') || 'No AI key configured.' };
};

// ---------- transcript tidy-up ----------
// Live speech comes out in fragments. Group them back into turns.
const refineSchema = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sourceIndexes: { type: 'array', items: { type: 'integer' } },
          text: { type: 'string' },
        },
        required: ['sourceIndexes', 'text'],
      },
    },
  },
  required: ['turns'],
};

const refinePrompt = (lines) => `A live transcript of a caregiver visit was captured in small fragments. Group the fragments into the complete turns each person actually spoke.

Fragments (index, speaker, text):
${lines.map((line, index) => `${index}. [${line.speaker}] ${line.text}`).join('\n')}

Rules:
- Merge consecutive fragments from the same speaker that form one continuous utterance.
- Never merge fragments from different speakers, and never reorder fragments.
- Every index must appear exactly once, in ascending order, across all groups.
- Repair obvious speech-recognition errors, punctuation and capitalisation so the turn reads as the person meant it.
- Remove stutters, repeated false starts and filler that adds nothing.
- Do not add facts, names or sentences that were not spoken.
Return only JSON matching this schema:\n${JSON.stringify(refineSchema)}`;

const applyRefinedGroups = (lines, groups) => {
  const used = new Set();
  const refined = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const indexes = (Array.isArray(group.sourceIndexes) ? group.sourceIndexes : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value < lines.length && !used.has(value))
      .sort((a, b) => a - b);
    if (!indexes.length) continue;
    const text = String(group.text || '').trim();
    if (!text) continue;
    // A group may only cover fragments from one speaker.
    const first = lines[indexes[0]];
    const sameSpeaker = indexes.filter((index) => lines[index].speaker === first.speaker);
    if (!sameSpeaker.length) continue;
    sameSpeaker.forEach((index) => used.add(index));
    const last = lines[sameSpeaker[sameSpeaker.length - 1]];
    refined.push({ ...first, text, end: last.end ?? first.end, mergedFrom: sameSpeaker.length });
  }
  // Anything the model dropped is kept verbatim rather than lost.
  lines.forEach((line, index) => { if (!used.has(index)) refined.push({ ...line, start: line.start ?? 0 }); });
  return refined.sort((a, b) => (a.start || 0) - (b.start || 0));
};

const localRefine = (lines) => {
  const merged = [];
  for (const line of lines) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === line.speaker && ((line.start || 0) - (last.end || last.start || 0)) < 3000) {
      last.text = `${last.text} ${line.text}`.replace(/\s+/g, ' ').trim();
      last.end = line.end ?? last.end;
      last.mergedFrom = (last.mergedFrom || 1) + 1;
      continue;
    }
    merged.push({ ...line });
  }
  return merged;
};

const callRefineProvider = async (provider, lines) => {
  if (provider === 'gemini') {
    const key = env('GEMINI_API_KEY');
    if (!key) throw new Error('Gemini key is not configured.');
    const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
    const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You clean up live speech transcripts. You never invent content. Return valid JSON only.' }] },
        contents: [{ role: 'user', parts: [{ text: refinePrompt(lines) }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseJsonSchema: refineSchema },
      }),
    }, 60000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `Gemini failed (${response.status}).`);
    const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || '').join('\n');
    return parseModelJson(text).turns;
  }
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Groq key is not configured.');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: env('GROQ_MODEL', 'llama-3.3-70b-versatile'),
      messages: [
        { role: 'system', content: 'You clean up live speech transcripts. You never invent content. Return valid JSON only.' },
        { role: 'user', content: refinePrompt(lines) },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  }, 60000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Groq failed (${response.status}).`);
  return parseModelJson(data.choices?.[0]?.message?.content || '{}').turns;
};

const refineTranscript = async (transcript) => {
  const lines = (Array.isArray(transcript) ? transcript : [])
    .map((line) => ({ ...line, text: String(line.text || '').trim() }))
    .filter((line) => line.text);
  if (lines.length < 2) return { provider: 'unchanged', transcript: lines };
  const order = env('AI_PROVIDER', 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  for (const provider of order) {
    if (provider === 'gemini' && !env('GEMINI_API_KEY')) continue;
    if (provider === 'groq' && !env('GROQ_API_KEY')) continue;
    try {
      const groups = await callRefineProvider(provider, lines);
      const refined = applyRefinedGroups(lines, groups);
      if (refined.length) return { provider, transcript: refined };
    } catch (error) {
      console.warn(`[Meco] ${provider} transcript tidy-up failed:`, error.message);
    }
  }
  return { provider: 'local-merge', transcript: localRefine(lines) };
};

const voiceIdServer = () => env('VOICE_ID_SERVER', '').replace(/\/$/, '');
const voiceIdReady = () => Boolean(voiceIdServer());
const voiceIdSecret = () => env('VOICE_ID_SECRET', '');

const voiceIdRequest = async (method, route, body) => {
  const base = voiceIdServer();
  if (!base) throw Object.assign(new Error('The local voice-recognition server is not configured.'), { status: 503 });
  const secret = voiceIdSecret();
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (secret) headers['X-Voice-Id-Secret'] = secret;
  let response;
  try {
    response = await fetchWithTimeout(`${base}${route}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }, 60000);
  } catch {
    throw Object.assign(new Error('Meco could not reach the local voice-recognition server. Run "npm run voice:server" and try again.'), { status: 503 });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Voice recognition failed (${response.status}).`), { status: response.status });
  return data;
};

const translateText = async (text, sourceLanguage, targetLanguage) => {
  const token = env('APIFY_API_TOKEN');
  if (!token) throw Object.assign(new Error('Translation is not configured.'), { status: 503 });
  const response = await fetchWithTimeout(`https://api.apify.com/v2/acts/maged120~google-translate-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch_items: [{ text, source_lang: sourceLanguage, target_lang: targetLanguage }] }),
  }, 45000);
  if (!response.ok) throw Object.assign(new Error(`Translation service returned ${response.status}.`), { status: 502 });
  const results = await response.json().catch(() => []);
  const item = Array.isArray(results) ? results[0] : null;
  if (!item?.success || !item.translated_text) throw Object.assign(new Error('The translation service returned no translation.'), { status: 502 });
  return String(item.translated_text);
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  // .mjs needs a JS mime type or strict MIME checking kills the module graph.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// Marketing pages are client-rendered from the same shell, so a hard refresh
// or a shared link on any of these paths still needs to resolve to index.html.
const LANDING_ROUTES = ['/', '/app', '/sign-in', '/sign-up', '/product', '/recognize', '/companion', '/caregiver', '/privacy', '/pricing', '/clinicians', '/science', '/impact', '/privacy-policy', '/terms', '/cookies'];
const serveFile = async (res, requestPath) => {
  let clean = decodeURIComponent(requestPath.split('?')[0]);
  if (LANDING_ROUTES.includes(clean)) clean = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, clean));
  if (!target.startsWith(PUBLIC_DIR)) return false;
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return false;
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // App code is revalidated on every load so an updated build is never
      // shadowed by an hour-old cached copy in the caregiver's browser.
      'Cache-Control': ['.html', '.js', '.mjs', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    fs.createReadStream(target).pipe(res);
    return true;
  } catch { return false; }
};

const handleApi = async (req, res, url) => {
  if (url.pathname === '/api/config' && req.method === 'GET') {
    json(res, 200, {
      clerkPublishableKey,
      publicAppUrl: env('PUBLIC_APP_URL', `http://localhost:${PORT}`),
      features: {
        clerk: Boolean(clerkPublishableKey),
        appwrite: appwriteReady(),
        assemblyai: Boolean(env('ASSEMBLYAI_API_KEY')),
        liveTranscription: Boolean(env('DEEPGRAM_API_KEY')),
        voiceId: voiceIdReady(),
        translation: Boolean(env('APIFY_API_TOKEN')),
        gemini: Boolean(env('GEMINI_API_KEY')),
        groq: Boolean(env('GROQ_API_KEY')),
        localDemo: env('ALLOW_LOCAL_DEMO') === 'true',
        googleCalendar: Boolean(env('CLERK_SECRET_KEY')),
      },
    });
    return true;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      name: 'Meco Memory Companion',
      version: '1.0.0',
      node: process.version,
      backend: appwriteReady() ? 'appwrite-configured' : 'local-file',
      transcription: env('ASSEMBLYAI_API_KEY') ? 'configured' : 'missing-key',
      liveTranscription: env('DEEPGRAM_API_KEY') ? 'configured' : 'missing-key',
      voiceRecognition: voiceIdReady() ? voiceIdServer() : 'disabled',
      aiSummary: env('GEMINI_API_KEY') ? 'gemini' : env('GROQ_API_KEY') ? 'groq' : 'local-fallback',
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const ownerId = await requireUser(req);
    const result = await loadState(ownerId);
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/state' && req.method === 'PUT') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    const result = await saveState(ownerId, body.state || body);
    json(res, 200, result);
    return true;
  }

  // Mirrors one visit or reminder to Google. Does not touch our own state.
  if (url.pathname === '/api/calendar/sync' && req.method === 'POST') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    const accessToken = await getGoogleAccessToken(ownerId);
    const eventBody = googleCalendarEventBody(body);
    const event = body.googleEventId
      ? await googleCalendarRequest(accessToken, 'PATCH', `/calendars/primary/events/${encodeURIComponent(body.googleEventId)}`, eventBody)
      : await googleCalendarRequest(accessToken, 'POST', '/calendars/primary/events', eventBody);
    json(res, 200, { googleEventId: event.id });
    return true;
  }

  if (url.pathname === '/api/calendar/unsync' && req.method === 'POST') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    if (body.googleEventId) {
      const accessToken = await getGoogleAccessToken(ownerId);
      await googleCalendarRequest(accessToken, 'DELETE', `/calendars/primary/events/${encodeURIComponent(body.googleEventId)}`);
    }
    json(res, 200, { ok: true });
    return true;
  }

  // Pulls synced events back so edits made in Google reach Meco.
  if (url.pathname === '/api/calendar/pull' && req.method === 'POST') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    const eventIds = Array.isArray(body.eventIds) ? body.eventIds.filter(Boolean).slice(0, 200) : [];
    if (!eventIds.length) { json(res, 200, { events: [] }); return true; }
    const accessToken = await getGoogleAccessToken(ownerId);
    const events = await Promise.all(eventIds.map(async (googleEventId) => {
      try {
        const event = await googleCalendarRequest(accessToken, 'GET', `/calendars/primary/events/${encodeURIComponent(googleEventId)}`);
        if (event.status === 'cancelled') return { googleEventId, deleted: true };
        return { googleEventId, deleted: false, summary: event.summary || '', description: event.description || '', start: event.start, end: event.end, recurrence: event.recurrence || [] };
      } catch (error) {
        if (error.status === 404 || error.status === 410) return { googleEventId, deleted: true };
        return { googleEventId, deleted: false, unchanged: true };
      }
    }));
    json(res, 200, { events });
    return true;
  }

  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    await requireUser(req);
    const audio = await readBody(req, MAX_AUDIO_BYTES);
    if (!audio.length) throw Object.assign(new Error('No audio was received.'), { status: 400 });
    const result = await assemblyTranscribe(audio, req.headers['content-type'], req.headers['x-speakers-expected']);
    json(res, 200, result);
    return true;
  }

  // Deepgram key for the browser socket. Needs a Clerk session.
  if (url.pathname === '/api/live-key' && req.method === 'GET') {
    await requireUser(req);
    const key = env('DEEPGRAM_API_KEY');
    if (!key) throw Object.assign(new Error('Live transcription is not configured.'), { status: 503 });
    json(res, 200, { key, model: env('DEEPGRAM_MODEL', 'nova-2') });
    return true;
  }

  if (url.pathname === '/api/voice/speakers' && req.method === 'GET') {
    const ownerId = await requireUser(req);
    const result = await voiceIdRequest('GET', `/speakers?owner=${encodeURIComponent(ownerId)}`);
    json(res, 200, { speakers: Array.isArray(result) ? result : [] });
    return true;
  }

  if (url.pathname === '/api/voice/enroll' && req.method === 'POST') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    if (!body.audio) throw Object.assign(new Error('A voice sample is required.'), { status: 400 });
    const result = await voiceIdRequest('POST', '/enroll', {
      owner: ownerId,
      name: String(body.name || '').slice(0, 80),
      personId: body.personId ? String(body.personId).slice(0, 80) : '',
      audio: body.audio,
    });
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/voice/identify' && req.method === 'POST') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    if (!body.audio) throw Object.assign(new Error('Audio is required to identify a speaker.'), { status: 400 });
    const result = await voiceIdRequest('POST', '/identify', { owner: ownerId, audio: body.audio });
    json(res, 200, result);
    return true;
  }

  const voiceSpeakerMatch = url.pathname.match(/^\/api\/voice\/speakers\/(\d+)(\/enabled)?$/);
  if (voiceSpeakerMatch && (req.method === 'DELETE' || req.method === 'POST')) {
    const ownerId = await requireUser(req);
    const speakerId = voiceSpeakerMatch[1];
    if (req.method === 'DELETE') {
      const result = await voiceIdRequest('DELETE', `/speakers/${speakerId}?owner=${encodeURIComponent(ownerId)}`);
      json(res, 200, result);
      return true;
    }
    const body = await readJson(req);
    const result = await voiceIdRequest('POST', `/speakers/${speakerId}/enabled`, { owner: ownerId, enabled: body.enabled !== false });
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/translate' && req.method === 'POST') {
    await requireUser(req);
    const body = await readJson(req);
    const text = String(body.text || '').slice(0, 4000).trim();
    const source = String(body.source || 'en').slice(0, 12).trim() || 'en';
    const target = String(body.target || '').slice(0, 12).trim();
    if (!text) throw Object.assign(new Error('Text is required.'), { status: 400 });
    if (!target || target === source) { json(res, 200, { text, target: target || source }); return true; }
    const translated = await translateText(text, source, target);
    json(res, 200, { text: translated, target });
    return true;
  }

  if (url.pathname === '/api/refine-transcript' && req.method === 'POST') {
    await requireUser(req);
    const body = await readJson(req);
    const result = await refineTranscript(body.transcript);
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/summarize' && req.method === 'POST') {
    await requireUser(req);
    const body = await readJson(req);
    if (!normalizeTranscriptText(body.transcript).trim()) throw Object.assign(new Error('A transcript is required before generating a summary.'), { status: 400 });
    const result = await generateSummary(body);
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/memories/extract' && req.method === 'POST') {
    await requireUser(req);
    const body = await readJson(req);
    if (!normalizeTranscriptText(body.transcript).trim()) throw Object.assign(new Error('A transcript is required before proposing memories.'), { status: 400 });
    const result = await generateMemoryExtract(body);
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/recall' && req.method === 'POST') {
    await requireUser(req);
    const body = await readJson(req);
    const query = String(body.query || '').trim();
    if (!query) throw Object.assign(new Error('A question is required.'), { status: 400 });
    const memories = (Array.isArray(body.memories) ? body.memories : []).slice(0, 500).map((m) => ({
      id: String(m?.id || ''),
      title: String(m?.title || '').slice(0, 80),
      summary: String(m?.summary || '').slice(0, 240),
      tags: Array.isArray(m?.tags) ? m.tags.slice(0, 6) : [],
      date: m?.date || null,
      peopleNames: Array.isArray(m?.peopleNames) ? m.peopleNames.slice(0, 10) : [],
      placeName: m?.placeName || null,
      confidence: m?.confidence || 'ai-inferred',
    })).filter((m) => m.id);
    const digest = JSON.stringify({ memories }).slice(0, 60000);
    const result = await generateRecall(query, memories, digest);
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/memories/related' && req.method === 'POST') {
    await requireUser(req);
    const body = await readJson(req);
    const summaryText = String(body.summary || '').trim();
    if (!summaryText) throw Object.assign(new Error('A visit summary is required.'), { status: 400 });
    const memories = (Array.isArray(body.memories) ? body.memories : []).slice(0, 500).map((m) => ({
      id: String(m?.id || ''),
      title: String(m?.title || '').slice(0, 80),
      summary: String(m?.summary || '').slice(0, 240),
      tags: Array.isArray(m?.tags) ? m.tags.slice(0, 6) : [],
      date: m?.date || null,
      peopleNames: Array.isArray(m?.peopleNames) ? m.peopleNames.slice(0, 10) : [],
      placeName: m?.placeName || null,
      confidence: m?.confidence || 'ai-inferred',
    })).filter((m) => m.id);
    if (!memories.length) { json(res, 200, { provider: 'local-fallback', model: 'none', related: [] }); return true; }
    const digest = JSON.stringify({ memories }).slice(0, 60000);
    const result = await generateRelatedMemories(summaryText, memories, digest);
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/family/link' && req.method === 'POST') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    const { state } = await loadState(ownerId);
    let salt = state.settings?.familyShareSalt || '';
    if (!salt || body.regenerate) {
      salt = crypto.randomBytes(9).toString('base64url');
      await saveState(ownerId, { ...state, settings: { ...state.settings, familyShareSalt: salt } });
    }
    const token = signFamilyToken(ownerId, salt);
    const origin = env('PUBLIC_APP_URL') || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    json(res, 200, { url: `${origin.replace(/\/$/, '')}/contribute/${token}` });
    return true;
  }

  // No requireUser here. Auth is the signed family token, see signFamilyToken.
  if (url.pathname.startsWith('/api/contribute/') && req.method === 'POST') {
    const token = decodeURIComponent(url.pathname.slice('/api/contribute/'.length));
    const ownerId = familyTokenOwnerId(token);
    if (!ownerId) throw Object.assign(new Error('This link is not valid.'), { status: 404 });
    const { state } = await loadState(ownerId);
    const verifiedOwner = verifyFamilyToken(token, state.settings?.familyShareSalt || '');
    if (!verifiedOwner) throw Object.assign(new Error('This link is no longer active.'), { status: 404 });
    const body = await readJson(req);
    const allowedTypes = ['photo', 'story', 'correction', 'voice', 'event'];
    const type = allowedTypes.includes(body.type) ? body.type : 'story';
    const contributorName = String(body.contributorName || '').trim().slice(0, 80);
    if (!contributorName) throw Object.assign(new Error('Your name is required.'), { status: 400 });
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const photoDataUrl = typeof payload.photoDataUrl === 'string' && payload.photoDataUrl.startsWith('data:image/') ? payload.photoDataUrl.slice(0, 2_200_000) : null;
    const voiceDataUrl = typeof payload.voiceDataUrl === 'string' && payload.voiceDataUrl.startsWith('data:audio/') ? payload.voiceDataUrl.slice(0, 3_200_000) : null;
    const contribution = {
      id: crypto.randomUUID(),
      type,
      contributorName,
      contributorRelation: String(body.contributorRelation || '').trim().slice(0, 80),
      aboutVisitorId: (state.visitors || []).some((v) => v.id === payload.aboutVisitorId) ? payload.aboutVisitorId : null,
      title: String(payload.title || '').trim().slice(0, 80) || 'Untitled contribution',
      text: String(payload.text || '').trim().slice(0, 1000),
      photoDataUrl,
      voiceDataUrl,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const nextContributions = [contribution, ...(state.familyContributions || [])].slice(0, 200);
    await saveState(ownerId, { ...state, familyContributions: nextContributions });
    json(res, 200, { ok: true });
    return true;
  }

  /* ---------- Cognitive Independence Engine ----------------------------
     Reachable by either role: a patient's own device records attempts and
     asks what help to offer; a caregiver reads the resulting patterns. */

  // What level of help should this person get for this task, right now?
  if (url.pathname === '/api/assist/recommend' && req.method === 'POST') {
    const { ownerId } = await requireUserOrPatient(req);
    const body = await readJson(req);
    const taskId = String(body.taskId || '').trim();
    if (!taskId) throw Object.assign(new Error('A taskId is required.'), { status: 400 });
    const { state } = await loadState(ownerId);
    const routine = (state.routines || []).find((r) => r.id === taskId);
    const recommendation = engine.recommendAssistanceLevel(taskId, state.taskAttempts || [], {
      // Safety-critical routines can pin a floor so the engine may never
      // fade below caregiver supervision, however well the person is doing.
      safetyFloor: Number.isInteger(routine?.safetyFloor) ? routine.safetyFloor : 0,
      safetyCeiling: Number.isInteger(routine?.safetyCeiling) ? routine.safetyCeiling : 6,
    });
    json(res, 200, {
      ...recommendation,
      cueRationale: engine.explainCueChoice((state.taskAttempts || []).filter((a) => a.taskId === taskId)),
      functional: engine.functionalSummary(taskId, state.taskAttempts || []),
    });
    return true;
  }

  // Record what actually happened. This is the only way the engine learns.
  if (url.pathname === '/api/assist/attempt' && req.method === 'POST') {
    const { ownerId, role } = await requireUserOrPatient(req);
    const body = await readJson(req);
    const taskId = String(body.taskId || '').trim();
    if (!taskId) throw Object.assign(new Error('A taskId is required.'), { status: 400 });
    if (!engine.OUTCOMES.includes(body.outcome)) {
      throw Object.assign(new Error(`outcome must be one of ${engine.OUTCOMES.join(', ')}.`), { status: 400 });
    }
    const attempt = {
      id: crypto.randomUUID(),
      taskId,
      at: new Date().toISOString(),
      assistanceLevel: Math.max(0, Math.min(6, Number(body.assistanceLevel) || 0)),
      cueType: engine.CUE_TYPES.includes(body.cueType) ? body.cueType : 'none',
      outcome: body.outcome,
      durationMs: Number.isFinite(body.durationMs) ? Math.max(0, Math.round(body.durationMs)) : null,
      caregiverInvolved: Boolean(body.caregiverInvolved),
      recordedBy: role,
    };
    await mutateOwnerState(ownerId, (state) => ({
      ...state,
      taskAttempts: [attempt, ...(state.taskAttempts || [])].slice(0, 3000),
    }));
    json(res, 200, { attempt });
    return true;
  }

  // Everything the caregiver Independence dashboard needs, in one read.
  if (url.pathname === '/api/assist/independence' && req.method === 'GET') {
    const ownerId = await requireUser(req);
    const { state } = await loadState(ownerId);
    const attempts = state.taskAttempts || [];
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
    const taskIds = [...new Set(attempts.map((a) => a.taskId))];
    json(res, 200, {
      dashboard: engine.independenceDashboard(attempts, { days }),
      perTask: taskIds.map((taskId) => ({
        taskId,
        functional: engine.functionalSummary(taskId, attempts),
        baseline: engine.changeFromBaseline(taskId, attempts),
      })),
      rules: engine.ENGINE_RULES,
      ladder: engine.ASSISTANCE_LADDER,
    });
    return true;
  }

  // Intention buffer, store an explicit intention, or recover one.
  if (url.pathname === '/api/assist/intention' && req.method === 'POST') {
    const { ownerId } = await requireUserOrPatient(req);
    const body = await readJson(req);
    const goal = String(body.goal || '').trim().slice(0, 200);
    if (!goal) throw Object.assign(new Error('A goal is required.'), { status: 400 });
    const intention = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      goal,
      destination: String(body.destination || '').trim().slice(0, 80) || null,
      // Kept verbatim so the recall answer can quote what was actually said
      // rather than paraphrasing it back as if it were a fresh fact.
      sourceText: String(body.sourceText || '').trim().slice(0, 400) || null,
      status: 'active',
    };
    await mutateOwnerState(ownerId, (state) => ({
      ...state,
      intentions: [intention, ...(state.intentions || [])].slice(0, 200),
    }));
    json(res, 200, { intention });
    return true;
  }

  if (url.pathname === '/api/assist/intention' && req.method === 'GET') {
    const { ownerId } = await requireUserOrPatient(req);
    const { state } = await loadState(ownerId);
    json(res, 200, engine.recallIntention(state.intentions || []));
    return true;
  }

  // Repeated-question handling: log the question, get back HOW to answer it.
  if (url.pathname === '/api/assist/question' && req.method === 'POST') {
    const { ownerId } = await requireUserOrPatient(req);
    const body = await readJson(req);
    const text = String(body.text || '').trim().slice(0, 300);
    if (!text) throw Object.assign(new Error('Question text is required.'), { status: 400 });
    const { state } = await loadState(ownerId);
    const analysis = engine.findRepeatedQuestion(text, state.questionEvents || []);
    const record = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      text,
      topic: String(body.topic || '').trim().slice(0, 60) || null,
      responseMode: analysis.suggestedResponseMode,
    };
    await mutateOwnerState(ownerId, (state) => ({
      ...state,
      questionEvents: [record, ...(state.questionEvents || [])].slice(0, 1000),
    }));
    json(res, 200, { ...analysis, record });
    return true;
  }

  // ABC-style behaviour logging + the co-occurrence patterns it produces.
  if (url.pathname === '/api/assist/behaviour' && req.method === 'POST') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    const behaviour = String(body.behaviour || '').trim().slice(0, 120);
    if (!behaviour) throw Object.assign(new Error('A behaviour description is required.'), { status: 400 });
    const event = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      behaviour,
      antecedent: String(body.antecedent || '').trim().slice(0, 400) || null,
      contextTags: (Array.isArray(body.contextTags) ? body.contextTags : [])
        .map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 10),
      intervention: String(body.intervention || '').trim().slice(0, 200) || null,
      outcome: ['helped', 'partially-helped', 'no-change', 'worsened'].includes(body.outcome) ? body.outcome : null,
      notes: String(body.notes || '').trim().slice(0, 1000) || null,
    };
    await mutateOwnerState(ownerId, (state) => ({
      ...state,
      behaviourEvents: [event, ...(state.behaviourEvents || [])].slice(0, 1000),
    }));
    json(res, 200, { event });
    return true;
  }

  if (url.pathname === '/api/assist/behaviour' && req.method === 'GET') {
    const ownerId = await requireUser(req);
    const { state } = await loadState(ownerId);
    json(res, 200, {
      events: (state.behaviourEvents || []).slice(0, 100),
      patterns: engine.behaviourPatterns(state.behaviourEvents || []),
    });
    return true;
  }

  // Daily handoff for the next caregiver on shift.
  if (url.pathname === '/api/assist/handoff' && req.method === 'GET') {
    const ownerId = await requireUser(req);
    const { state } = await loadState(ownerId);
    json(res, 200, engine.dailyHandoff({
      attempts: state.taskAttempts || [],
      questions: state.questionEvents || [],
      behaviours: state.behaviourEvents || [],
      medicationLogs: state.medicationLogs || [],
    }));
    return true;
  }

  // ---------- patient accounts ----------

  if (url.pathname === '/api/patient-accounts' && req.method === 'POST') {
    const ownerId = await requireUser(req);
    const body = await readJson(req);
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('A name is required to create a patient account.'), { status: 400 });
    const { state } = await loadState(ownerId);
    if ((state.patientAccounts || []).length >= 20) {
      throw Object.assign(new Error('You have reached the limit of 20 patient accounts.'), { status: 400 });
    }
    const patientId = generatePatientId();
    const passcode = generatePasscode();
    const passcodeSalt = crypto.randomBytes(16).toString('base64url');
    await savePatientLookup(patientId, {
      ownerId,
      name,
      passcodeSalt,
      passcodeHash: hashPasscode(passcode, passcodeSalt),
      createdAt: new Date().toISOString(),
    });
    const entry = { id: patientId, name, createdAt: new Date().toISOString() };
    await saveState(ownerId, { ...state, patientAccounts: [...(state.patientAccounts || []), entry] });
    // passcode is returned exactly once, in plaintext, right here: the
    // server never stores or re-displays it after this response.
    json(res, 200, { id: patientId, name, passcode });
    return true;
  }

  if (url.pathname === '/api/patient-accounts' && req.method === 'GET') {
    const ownerId = await requireUser(req);
    const { state } = await loadState(ownerId);
    json(res, 200, { patientAccounts: state.patientAccounts || [] });
    return true;
  }

  const patientAccountDeleteMatch = url.pathname.match(/^\/api\/patient-accounts\/([a-zA-Z0-9_-]+)$/);
  if (patientAccountDeleteMatch && req.method === 'DELETE') {
    const ownerId = await requireUser(req);
    const patientId = patientAccountDeleteMatch[1];
    const { state } = await loadState(ownerId);
    const next = (state.patientAccounts || []).filter((p) => p.id !== patientId);
    await saveState(ownerId, { ...state, patientAccounts: next });
    await deletePatientLookup(patientId).catch(() => {});
    json(res, 200, { ok: true });
    return true;
  }

  // No requireUser. Patients use patientId + passcode, throttled above.
  if (url.pathname === '/api/patient-auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    const patientId = String(body.patientId || '').trim().toLowerCase();
    const passcode = String(body.passcode || '').trim();
    if (!patientId || !passcode) throw Object.assign(new Error('Patient ID and passcode are required.'), { status: 400 });
    throttleLoginAttempt(patientId);
    const record = await loadPatientLookup(patientId);
    if (!record) throw Object.assign(new Error('That Patient ID was not found.'), { status: 404 });
    const attemptedHash = hashPasscode(passcode, record.passcodeSalt);
    const a = Buffer.from(attemptedHash);
    const b = Buffer.from(record.passcodeHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw Object.assign(new Error('That passcode is incorrect.'), { status: 401 });
    }
    const token = signPatientToken(patientId, record.ownerId);
    json(res, 200, { token, patientId, name: record.name });
    return true;
  }

  if (url.pathname === '/api/patient/state' && req.method === 'GET') {
    const { ownerId } = await requirePatientAuth(req);
    const { state } = await loadState(ownerId);
    json(res, 200, patientStateProjection(state));
    return true;
  }

  if (url.pathname === '/api/patient/journal' && req.method === 'POST') {
    const { ownerId } = await requirePatientAuth(req);
    const body = await readJson(req);
    const mood = JOURNAL_MOODS.includes(body.mood) ? body.mood : 'okay';
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) throw Object.assign(new Error('An entry needs some text.'), { status: 400 });
    const entry = {
      id: crypto.randomUUID(), title: '', mood,
      html: `<p>${escapeHtmlServer(text)}</p>`, text,
      createdAt: new Date().toISOString(),
    };
    await mutateOwnerState(ownerId, (state) => ({
      ...state, journalEntries: [entry, ...(state.journalEntries || [])].slice(0, 200),
    }));
    json(res, 200, { entry });
    return true;
  }

  if (url.pathname === '/api/patient/mood' && req.method === 'POST') {
    const { ownerId } = await requirePatientAuth(req);
    const body = await readJson(req);
    if (!JOURNAL_MOODS.includes(body.mood)) throw Object.assign(new Error('Unrecognized mood.'), { status: 400 });
    const entry = { id: crypto.randomUUID(), mood: body.mood, createdAt: new Date().toISOString() };
    await mutateOwnerState(ownerId, (state) => ({
      ...state, moodCheckIns: [entry, ...(state.moodCheckIns || [])].slice(0, 200),
    }));
    json(res, 200, { entry });
    return true;
  }

  if (url.pathname === '/api/patient/sos' && req.method === 'POST') {
    const { ownerId } = await requirePatientAuth(req);
    const event = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), acknowledged: false };
    await mutateOwnerState(ownerId, (state) => ({
      ...state, sosEvents: [event, ...(state.sosEvents || [])].slice(0, 50),
    }));
    json(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/companion/chat' && req.method === 'POST') {
    await requireUserOrPatient(req);
    const body = await readJson(req);
    const patientName = String(body.patientName || '').slice(0, 80);
    const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-20)
      .map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', text: String(item.text || '').slice(0, 2000) }))
      .filter((item) => item.text);
    if (!messages.length) throw Object.assign(new Error('At least one message is required.'), { status: 400 });
    const historyContext = String(body.history || '').slice(0, 14000);
    const result = await generateCompanionReply(patientName, messages, historyContext);
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/companion/analyze' && req.method === 'POST') {
    await requireUser(req);
    const body = await readJson(req);
    const patientName = String(body.patientName || '').slice(0, 80);
    const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-80)
      .map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', text: String(item.text || '').slice(0, 2000) }))
      .filter((item) => item.text);
    if (!messages.length) throw Object.assign(new Error('A conversation is required before analysis.'), { status: 400 });
    const result = await generateCompanionAnalysis(patientName, messages);
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/companion/overview' && req.method === 'POST') {
    await requireUser(req);
    const body = await readJson(req);
    const patientName = String(body.patientName || '').slice(0, 80);
    const chats = (Array.isArray(body.chats) ? body.chats : []).slice(-30).map((chat) => ({
      startedAt: String(chat.startedAt || ''),
      note: String(chat.note || '').slice(0, 500),
      moodWords: (Array.isArray(chat.moodWords) ? chat.moodWords : []).map((word) => String(word || '').slice(0, 40)).slice(0, 4),
      wellbeingScore: Number.isFinite(Number(chat.wellbeingScore)) ? Math.max(0, Math.min(100, Math.round(Number(chat.wellbeingScore)))) : 0,
      flagged: Boolean(chat.flagged),
    }));
    if (!chats.length) throw Object.assign(new Error('At least one reviewed conversation is required.'), { status: 400 });
    const result = await generateCompanionOverview(patientName, chats);
    json(res, 200, result);
    return true;
  }

  return false;
};

// ---------- live transcription relay ----------
// Browser streams PCM here, we relay to Deepgram so the key stays server-side.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const WS_SUBPROTOCOL = 'meco-live';

const wsFrame = (opcode, payload = Buffer.alloc(0)) => {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
};

const wsSendText = (socket, value) => {
  if (!socket.destroyed) socket.write(wsFrame(0x1, Buffer.from(String(value))));
};

const wsSendClose = (socket, code = 1000, reason = '') => {
  if (socket.destroyed) return;
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  socket.write(wsFrame(0x8, payload));
  socket.end();
};

// Minimal RFC 6455 reader: browser frames are always masked, and Meco only cares
// about binary audio, text control messages, ping and close.
const createWsReader = ({ onMessage, onPing, onClose }) => {
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = 0;
  let fragments = [];
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) === 0x80;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) === 0x80;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(WS_MAX_MESSAGE_BYTES)) { onClose(1009, 'Message too large.'); return; }
        length = Number(big);
        offset += 8;
      }
      if (length > WS_MAX_MESSAGE_BYTES) { onClose(1009, 'Message too large.'); return; }
      const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];

      if (opcode === 0x8) { onClose(1000, ''); return; }
      if (opcode === 0x9) { onPing(payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) { onMessage(fragmentOpcode, Buffer.concat(fragments)); fragments = []; fragmentOpcode = 0; }
        continue;
      }
      if (!fin) { fragmentOpcode = opcode; fragments = [payload]; continue; }
      onMessage(opcode, payload);
    }
  };
};

const deepgramStreamUrl = (params) => {
  const query = new URLSearchParams({
    model: env('DEEPGRAM_MODEL', 'nova-2'),
    language: params.language || 'en-US',
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    interim_results: 'true',
    encoding: 'linear16',
    sample_rate: String(params.sampleRate),
    channels: '1',
  });
  return `wss://api.deepgram.com/v1/listen?${query.toString()}`;
};

const handleLiveTranscribeUpgrade = async (req, socket, url) => {
  const key = env('DEEPGRAM_API_KEY');
  if (!key) throw new Error('Live transcription is not configured on this server.');

  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
  if (offered[0] !== WS_SUBPROTOCOL || !offered[1]) throw new Error('A Meco session token is required.');
  await verifyClerkToken(offered[1], req);

  const origin = req.headers.origin ? normalizeOrigin(req.headers.origin) : '';
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) throw new Error('Unauthorized origin.');

  const websocketKey = req.headers['sec-websocket-key'];
  if (!websocketKey) throw new Error('Malformed WebSocket handshake.');
  const accept = crypto.createHash('sha1').update(websocketKey + WS_GUID).digest('base64');

  const sampleRate = Math.max(8000, Math.min(48000, Number(url.searchParams.get('rate')) || 16000));
  const language = /^[a-zA-Z-]{2,12}$/.test(url.searchParams.get('language') || '') ? url.searchParams.get('language') : 'en-US';

  socket.setNoDelay(true);
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    `Sec-WebSocket-Protocol: ${WS_SUBPROTOCOL}`,
    '\r\n',
  ].join('\r\n'));

  const upstream = new WebSocket(deepgramStreamUrl({ sampleRate, language }), ['token', key]);
  const queued = [];
  let closed = false;

  const shutdown = (code, reason) => {
    if (closed) return;
    closed = true;
    try { if (upstream.readyState === WebSocket.OPEN) upstream.close(); } catch {}
    wsSendClose(socket, code, reason);
  };

  upstream.addEventListener('open', () => {
    while (queued.length) {
      const item = queued.shift();
      try { upstream.send(item); } catch {}
    }
    wsSendText(socket, JSON.stringify({ type: 'MecoReady', sampleRate }));
  });
  upstream.addEventListener('message', (event) => {
    if (closed) return;
    if (typeof event.data === 'string') wsSendText(socket, event.data);
  });
  upstream.addEventListener('error', () => {
    wsSendText(socket, JSON.stringify({ type: 'MecoError', error: 'The live transcription service could not be reached.' }));
    shutdown(1011, 'Upstream error.');
  });
  upstream.addEventListener('close', (event) => shutdown(1000, `Upstream closed (${event.code || 0}).`));

  const send = (payload) => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      if (queued.length < 400) queued.push(payload);
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.send(payload); } catch {}
    }
  };

  const read = createWsReader({
    onMessage: (opcode, payload) => {
      if (opcode === 0x2) send(payload);
      else if (opcode === 0x1) send(payload.toString('utf8'));
    },
    onPing: (payload) => { if (!socket.destroyed) socket.write(wsFrame(0xa, payload)); },
    onClose: () => shutdown(1000, 'Client closed.'),
  });

  socket.on('data', (chunk) => { try { read(chunk); } catch { shutdown(1011, 'Protocol error.'); } });
  socket.on('error', () => shutdown(1011, 'Socket error.'));
  socket.on('close', () => {
    closed = true;
    try { if (upstream.readyState <= WebSocket.OPEN) upstream.close(); } catch {}
  });
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) json(res, 404, { error: 'API route not found.' });
      return;
    }
    // The family-contribution page: a standalone, unauthenticated page,
    // never routed through the SPA's index.html or Clerk.
    if (url.pathname.startsWith('/contribute/') && req.method === 'GET') {
      const token = decodeURIComponent(url.pathname.slice('/contribute/'.length));
      const ownerId = familyTokenOwnerId(token);
      let html;
      if (!ownerId) {
        html = contributePageHtml({ patientName: '', visitors: [], token, error: 'This link is not valid.' });
      } else {
        const { state } = await loadState(ownerId);
        const verifiedOwner = verifyFamilyToken(token, state.settings?.familyShareSalt || '');
        if (!verifiedOwner) {
          html = contributePageHtml({ patientName: '', visitors: [], token, error: 'This link is no longer active, ask for a fresh one.' });
        } else {
          const visitors = (state.visitors || []).map((v) => ({ id: v.id, name: v.name })).slice(0, 100);
          html = contributePageHtml({ patientName: state.settings?.patientName || '', visitors, token });
        }
      }
      const payload = Buffer.from(html);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
      res.end(payload);
      return;
    }
    if (await serveFile(res, url.pathname)) return;
    if (req.method === 'GET' && await serveFile(res, '/index.html')) return;
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error('[Meco]', error);
    json(res, error.status || 500, { error: error.message || 'Unexpected server error.' });
  }
});

server.on('upgrade', async (req, socket) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname !== '/api/live-transcribe') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    await handleLiveTranscribeUpgrade(req, socket, url);
  } catch (error) {
    console.warn('[Meco] live transcription refused:', error.message);
    socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n${error.message || 'Unauthorized.'}`);
  }
});

server.listen(PORT, () => {
  console.log(`Meco is running at http://localhost:${PORT}`);
  console.log(`Backend: ${appwriteReady() ? 'Appwrite configured' : 'local file fallback'}`);
  console.log(`AssemblyAI: ${env('ASSEMBLYAI_API_KEY') ? 'configured' : 'missing key'}`);
  console.log(`Live transcription: ${env('DEEPGRAM_API_KEY') ? 'Deepgram configured' : 'missing key'}`);
  console.log(`Voice recognition: ${voiceIdReady() ? voiceIdServer() : 'disabled'}`);
  console.log(`AI summaries: ${env('GEMINI_API_KEY') ? 'Gemini' : env('GROQ_API_KEY') ? 'Groq' : 'local fallback'}`);
});
