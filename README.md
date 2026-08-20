# Meco Memory Companion

Meco is a complete Node 22 web application with an editorial, colour-panelled public website based on the supplied layout references and a private caregiver/patient workspace.

The project uses original **Meco** branding, copy, interface components and visual assets. No legacy product content remains in the deliverable.

## What is included

- Responsive Meco marketing website with the supplied visual composition: floating glass navigation, large rounded colour panels, serif headlines, layered interface mockups, editorial feature rows, privacy section, pricing and footer.
- Clerk sign-in and registration. Successful authentication opens `/app`.
- Protected caregiver workspace:
  - Overview
  - Trusted people
  - Memory Book
  - Visit Reports
  - Visits & Reminders, with weekly-repeat scheduling
  - Companion: an AI chatbot for the patient between visits, with a wellbeing-trend chart, reminiscence prompts drawn from each person's memory cue, optional voice conversation (speech in, spoken replies out), and a caregiver alert when a conversation shows signs worth a closer look
  - Journal: a rich-text journal the patient can write in, with mood tracking and a mood-over-time view
  - Settings, including an elder-friendly display mode (larger text and touch targets on patient-facing screens)
  - Patient mode
- Appwrite TablesDB persistence isolated by verified Clerk user ID.
- Real face enrollment using three detected 128-value descriptors: front, slight left and slight right.
- On-device visitor matching with an adjustable threshold and repeated-frame confirmation.
- Spoken visitor introductions using browser speech synthesis.
- Browser microphone recording with `MediaRecorder`.
- Live conversation transcription: the visit is transcribed and speaker-split while it happens, streamed through the Meco server so the speech key stays server-side.
- Voiceprint speaker recognition: a local Resemblyzer server matches each finished turn against enrolled voices, so trusted people appear by name in the transcript.
- Optional live transcript translation into Mandarin, Tamil or Hindi.
- AssemblyAI prerecorded-audio upload with multi-speaker diarisation and editable speaker labels, used as the fallback when live transcription is unavailable.
- Gemini structured caregiver summaries, with Groq as an optional fallback.
- Deterministic local report fallback when AI providers are unavailable.
- Two-way Google Calendar sync for visits and reminders, including weekly-repeat rules, edits made in Meco or directly in Google Calendar reach the other side.
- Server-only API keys. Secret provider values are never returned to browser JavaScript.
- No runtime package dependencies and no build step.

## Project structure

Every file that runs is in this repository, and every one of them is the file
that actually runs. There is no build step, no bundler, no transpiler and no
generated output: the browser loads `public/` exactly as it is committed, and
`node server.mjs` runs `server.mjs` exactly as it is committed. That is why
`package.json` has no `dependencies` block and no `build` script.

```
server.mjs                 HTTP + WebSocket server, all API routes, Clerk token
                           verification, Appwrite persistence, AI provider calls.
                           Zero runtime npm dependencies, Node built-ins only.

public/
  index.html               Both documents in one file: the marketing site and the
                           signed-in console shell. The router swaps which is shown.
  styles.css               All styling, including the theme token system.
  app.js                   The signed-in application: the caregiver console's
                           screens and patient mode.
  assistance-engine.mjs    The Cognitive Independence Engine. Pure functions, no
                           Node and no browser APIs, which is why the server and
                           the browser can import this same file rather than
                           keeping two copies of the rules in sync.
  evidence.js              Sourced statistics and citation rendering.
  js/
    utils.js               Shared DOM and formatting helpers.
    state.js               The account state object, exported as a live binding.
    core.js                Session plumbing: toasts, authenticated fetch, load/save.
    calendar.js            Two-way Google Calendar sync and repeat-rule helpers.
    landing/               The public marketing site's interactive pieces:
      hero.js                hero gap measurement + CTA pointer-follow
      orbit.js               the rotating "how it works" ring on /product
      ladder.js              the L0-L6 assistance ladder explorer
      simulation.js          the live engine demo (imports assistance-engine.mjs)
      evidence-pages.js      renders /science and /impact from evidence.js

test/assistance-engine.test.mjs   33 tests pinning the engine's rules.
scripts/                          Setup, validation and smoke-test utilities.
voice-id/server.py                Optional local Resemblyzer voiceprint service.
```

### How the browser code fits together

The import graph runs strictly one way, so there are no cycles:

```
app.js  ──>  js/calendar.js  ──>  js/core.js  ──>  js/state.js
   │                │                  │              │
   └──> js/landing/*┴──────────────────┴──> js/utils.js
                    └──> assistance-engine.mjs
```

`state.js` exports `state` as a live ES-module binding, which is what lets the
console be split across files at all, every module reads the current account
object without it having to be threaded through function arguments. Only
`state.js` may replace it (`setState` / `resetState`).

Code that changes data behind the current screen's back: the background
calendar pull, for instance, cannot call the router directly without creating
an import cycle, so it fires `core.js`'s rerender event and `app.js` listens.

## Start Meco

Node.js 22 or later is required.

```bash
cd meco-memory-companion
npm run dev
```

Open:

```text
http://localhost:3000
```

No `npm install` is required.

Voiceprint speaker recognition additionally needs the local Python backend running in a second terminal:

```bash
npm run voice:server
```

It requires `flask`, `numpy` and `resemblyzer` (`pip install flask numpy resemblyzer`), listens on `http://127.0.0.1:8765`, and stores voiceprints in `voice-id/voiceprints.json`. Meco still runs without it, live transcription then falls back to automatic speaker splitting instead of names.

## Verification commands

```bash
npm run validate
npm run smoke
```

`validate` checks the required files and integrations. `smoke` starts an isolated local server and checks the landing page, authentication boundary, state save/load, summary fallback, safe transcription error handling and secret isolation.

## Environment

No `.env` file is included, copy `.env.example` to `.env` and fill in your own credentials before starting the server:

- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `APPWRITE_ENDPOINT`
- `APPWRITE_PROJECT_ID`
- `APPWRITE_DATABASE_ID`
- `APPWRITE_TABLE_ID`
- `APPWRITE_API_KEY`
- `ASSEMBLYAI_API_KEY`
- `DEEPGRAM_API_KEY` (live conversation transcription)
- `VOICE_ID_SERVER` (defaults to `http://127.0.0.1:8765`; leave blank to disable voiceprint matching)
- `GEMINI_API_KEY`
- Optional `GROQ_API_KEY`
- Optional `APIFY_API_TOKEN` (transcript translation)

Set production URLs before deployment:

```env
PUBLIC_APP_URL=https://your-domain.example
CLERK_ALLOWED_ORIGINS=https://your-domain.example
```

Add that same domain to the Clerk application’s permitted redirect/origin settings.

## Appwrite setup

Meco stores a gzip-compressed account state in encrypted chunks, avoiding the size limitation of one short text row. Each Clerk account receives a private manifest row and one or more private data rows.

Required table columns:

| Column | Type | Minimum size | Notes |
|---|---|---:|---|
| `owner_id` | string | 128 | Clerk user ID |
| `entity` | string | 64 | Manifest or chunk type |
| `payload` | string | 20,000 | Enable encryption |
| `created_date` | string | 64 | ISO timestamp |
| `updated_date` | string | 64 | ISO timestamp |

Create the private table when it does not exist:

```bash
npm run setup:appwrite
```

The setup script creates the table with no public permissions and an encrypted payload column. Reads and writes pass through the Clerk-protected Meco server rather than directly from the browser.

## Face recognition flow

1. A caregiver opens **Trusted people** and enters the visitor’s name, relationship and approved memory cue.
2. Meco loads face models in the browser.
3. The caregiver captures front, slight-left and slight-right views.
4. Each capture must contain a real detected face and a 128-value descriptor.
5. Patient mode compares live descriptors against the enrolled descriptors locally in the browser.
6. A match must pass the configured threshold in repeated frames before Meco speaks the introduction.

The numerical descriptors are biometric data. Obtain informed consent and define retention/deletion rules before real-world use.

## Voice enrollment flow

1. A caregiver records an optional 12-second voice sample while enrolling a trusted person, or uses **Add voice** on the People page later.
2. The sample is sent as WAV audio to `/api/voice/enroll` with a Clerk session token.
3. Meco forwards it to the local voice-recognition server, which stores a single neural voice embedding for that person, scoped to the Clerk account.
4. The voiceprint is linked to the trusted person’s record, so a voice match resolves to that person’s name and memory cues.

Voice embeddings are biometric data. Obtain informed consent and define retention/deletion rules before real-world use.

## Live conversation flow

1. Patient mode records the visit with `MediaRecorder` and, at the same time, streams raw PCM to Meco over a WebSocket at `/api/live-transcribe`.
2. The connection is authenticated with the Clerk session token carried in the WebSocket subprotocol and is refused for unknown origins.
3. The Meco server relays the audio to the streaming speech provider. `DEEPGRAM_API_KEY` never reaches browser JavaScript.
4. Interim text appears as people speak; each finished turn is added to the Conversation panel with a speaker label.
5. Every finished turn is checked against the enrolled voiceprints. A match above the configured strictness renames that turn to the trusted person; otherwise Meco keeps the automatic speaker split.
6. When the conversation language is not English, each turn is translated through `/api/translate` and shown under the original text.
7. **Stop & transcribe** finalizes the live transcript, which then flows into the existing editable speaker labels, AI report and saved visit.

## Multi-speaker transcription flow (fallback)

Used when live transcription is switched off in Settings, not configured, or no live speech was captured.

1. Patient mode records microphone audio in the browser.
2. The binary recording is sent to `/api/transcribe` with a Clerk session token.
3. The server uploads it to AssemblyAI.
4. AssemblyAI runs Universal-3.5 Pro routing with `speaker_labels: true` and the configured expected speaker count.
5. Meco receives speaker-labelled utterances.
6. The caregiver can correct each speaker’s displayed name before generating or saving a report.

## AI summary flow

1. Meco requires a non-empty transcript.
2. The server requests structured JSON from Gemini.
3. If Gemini fails and Groq is configured, the same report is retried through Groq.
4. Returned fields are normalized and bounded before display.
5. The report includes summary, observed tone, observational engagement score, memory cues, topics, caregiver insights, a follow-up prompt and a non-medical-use note.

## Production checklist

- Deploy behind HTTPS; camera and microphone access require a secure context outside localhost.
- Keep `.env` out of source control.
- Restrict the Appwrite API key to only the required database/table/row scopes.
- Keep the Appwrite table private and enable payload encryption.
- Set exact Clerk authorized origins and redirect URLs.
- Define consent, access, retention, export and deletion policies for biometric descriptors, voice embeddings, audio, transcripts and visit reports.
- The voice-recognition backend binds to `127.0.0.1` only. Run it on the same host as the Meco server, and keep `voice-id/voiceprints.json` out of source control.
- Live transcription needs `wss://` behind HTTPS; make sure any reverse proxy forwards WebSocket upgrade requests to `/api/live-transcribe`.
