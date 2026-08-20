import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 3197;
const base = `http://127.0.0.1:${port}`;

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meco-smoke-'));
const child = spawn(process.execPath, ['--env-file=.env', 'server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    PUBLIC_APP_URL: base,
    CLERK_ALLOWED_ORIGINS: base,
    ALLOW_LOCAL_DEMO: 'true',
    MECO_DATA_DIR: dataDir,
    APPWRITE_API_KEY: '',
    ASSEMBLYAI_API_KEY: '',
    GEMINI_API_KEY: '',
    GROQ_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });
const fail = (message) => { throw new Error(`${message}\n${logs}`); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, options = {}) {
  const response = await fetch(`${base}${url}`, options);
  const body = await response.text();
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch {}
  return { response, body, json };
}

try {
  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    try {
      const result = await request('/api/health');
      if (result.response.ok) { ready = true; break; }
    } catch {}
    await wait(150);
  }
  if (!ready) fail('Server did not become ready.');

  const landing = await fetch(`${base}/`).then((response) => response.text());
  if (!landing.includes('Adaptive Cognitive Support for Dementia')) fail('Landing page did not load.');

  const unauth = await request('/api/state');
  if (unauth.response.status !== 401) fail('Protected state route accepted an unauthenticated request.');

  const auth = { Authorization: 'Bearer local-demo-token' };
  const state = {
    visitors: [],
    sessions: [],
    settings: { patientName: 'Smoke Test Member', expectedSpeakers: 2 },
  };
  const saved = await request('/api/state', {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!saved.response.ok || saved.json.state?.settings?.patientName !== 'Smoke Test Member') fail('State save failed.');

  const loaded = await request('/api/state', { headers: auth });
  if (!loaded.response.ok || loaded.json.state?.settings?.patientName !== 'Smoke Test Member') fail('State load failed.');

  const summary = await request('/api/summarize', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visitorName: 'Sarah',
      relationship: 'Daughter',
      transcript: [
        { displaySpeaker: 'Sarah', text: 'We looked through the garden album.' },
        { displaySpeaker: 'Smoke Test Member', text: 'I remember the roses.' },
      ],
    }),
  });
  if (!summary.response.ok || summary.json.provider !== 'local-fallback' || !summary.json.summary) fail('Summary fallback failed.');

  const transcript = await request('/api/transcribe', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'audio/webm' },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  if (transcript.response.status !== 503) fail('Missing AssemblyAI configuration was not handled safely.');

  const config = await request('/api/config');
  const configText = JSON.stringify(config.json);
  for (const secretName of ['CLERK_SECRET_KEY', 'APPWRITE_API_KEY', 'ASSEMBLYAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY']) {
    const secret = process.env[secretName];
    if (secret && configText.includes(secret)) fail(`${secretName} leaked through /api/config.`);
  }

  console.log('Meco smoke test passed: landing, auth boundary, state save/load, summary fallback, transcription error handling, and secret isolation.');
} finally {
  child.kill('SIGTERM');
  await wait(100);
  await fs.rm(dataDir, { recursive: true, force: true });
}
