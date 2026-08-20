/* Tests for the Cognitive Independence Engine.
   Run: node --test test/assistance-engine.test.mjs

   These matter more than typical unit tests: this module decides how much
   help a person living with dementia is offered, and the whole design claim
   is "the smallest assistance that lets them succeed". If the fading rule
   silently broke, the app would quietly over-help forever and nobody would
   see an error. So the adaptive rules, the safety clamps, and the
   never-invent-an-intention guarantee are all pinned down here. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSISTANCE_LADDER,
  ENGINE_RULES,
  functionalSummary,
  cueEffectiveness,
  mostEffectiveCue,
  recommendAssistanceLevel,
  explainCueChoice,
  changeFromBaseline,
  questionSimilarity,
  findRepeatedQuestion,
  behaviourPatterns,
  recallIntention,
  dailyHandoff,
  independenceDashboard,
} from '../public/assistance-engine.mjs';

/* Helper: build an attempt N minutes ago. */
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
const attempt = (over = {}) => ({
  taskId: 'make-tea',
  assistanceLevel: 3,
  cueType: 'visual',
  outcome: 'success',
  at: minutesAgo(10),
  ...over,
});

test('ladder is 0..6 and ordered', () => {
  assert.equal(ASSISTANCE_LADDER.length, 7);
  ASSISTANCE_LADDER.forEach((step, i) => assert.equal(step.level, i));
  assert.equal(ASSISTANCE_LADDER[0].key, 'independent');
  assert.equal(ASSISTANCE_LADDER[6].key, 'human');
});

/* ---- adaptive selection ------------------------------------------------ */

test('with no history it starts mid-ladder and admits it is guessing', () => {
  const rec = recommendAssistanceLevel('make-tea', []);
  assert.equal(rec.level, 3);
  assert.equal(rec.confidence, 'none');
  assert.equal(rec.evidence.observed, 0);
  assert.match(rec.reason, /No attempts recorded/i);
});

test('fades one level after the configured run of successes', () => {
  const history = Array.from({ length: ENGINE_RULES.successesBeforeFading }, (_, i) =>
    attempt({ assistanceLevel: 4, outcome: 'success', at: minutesAgo(i + 1) })
  );
  const rec = recommendAssistanceLevel('make-tea', history);
  assert.equal(rec.changed, 'faded');
  assert.equal(rec.level, 3, 'should offer one level LESS help');
  assert.match(rec.reason, /trying less help/i);
});

test('does not fade before the threshold is met', () => {
  const history = Array.from({ length: ENGINE_RULES.successesBeforeFading - 1 }, (_, i) =>
    attempt({ assistanceLevel: 4, outcome: 'success', at: minutesAgo(i + 1) })
  );
  const rec = recommendAssistanceLevel('make-tea', history);
  assert.equal(rec.changed, 'held');
  assert.equal(rec.level, 4);
});

test('escalates one level after repeated non-success', () => {
  const history = Array.from({ length: ENGINE_RULES.failuresBeforeEscalating }, (_, i) =>
    attempt({ assistanceLevel: 2, outcome: 'failure', at: minutesAgo(i + 1) })
  );
  const rec = recommendAssistanceLevel('make-tea', history);
  assert.equal(rec.changed, 'escalated');
  assert.equal(rec.level, 3);
});

test('"partial" counts as non-success for escalation', () => {
  const history = Array.from({ length: ENGINE_RULES.failuresBeforeEscalating }, (_, i) =>
    attempt({ assistanceLevel: 2, outcome: 'partial', at: minutesAgo(i + 1) })
  );
  assert.equal(recommendAssistanceLevel('make-tea', history).changed, 'escalated');
});

test('a success streak at a DIFFERENT level does not trigger fading', () => {
  // Succeeding repeatedly with heavy help says nothing about coping with less.
  const history = [
    attempt({ assistanceLevel: 2, outcome: 'success', at: minutesAgo(1) }),
    attempt({ assistanceLevel: 5, outcome: 'success', at: minutesAgo(2) }),
    attempt({ assistanceLevel: 5, outcome: 'success', at: minutesAgo(3) }),
    attempt({ assistanceLevel: 5, outcome: 'success', at: minutesAgo(4) }),
  ];
  const rec = recommendAssistanceLevel('make-tea', history);
  assert.equal(rec.changed, 'held', 'streak is broken by the level change');
  assert.equal(rec.level, 2);
});

test('never escalates past a safety ceiling', () => {
  const history = Array.from({ length: 5 }, (_, i) =>
    attempt({ assistanceLevel: 4, outcome: 'failure', at: minutesAgo(i + 1) })
  );
  const rec = recommendAssistanceLevel('make-tea', history, { safetyCeiling: 4 });
  assert.equal(rec.level, 4, 'clamped to the ceiling');
});

test('never fades below a safety floor (safety-critical tasks)', () => {
  const history = Array.from({ length: 6 }, (_, i) =>
    attempt({ taskId: 'medication', assistanceLevel: 5, outcome: 'success', at: minutesAgo(i + 1) })
  );
  const rec = recommendAssistanceLevel('medication', history, { safetyFloor: 5 });
  assert.equal(rec.level, 5, 'medication keeps its floor even after a success run');
});

test('recommendations are always flagged experimental', () => {
  assert.equal(recommendAssistanceLevel('make-tea', []).experimental, true);
  assert.equal(recommendAssistanceLevel('make-tea', [attempt()]).experimental, true);
});

/* ---- functional model -------------------------------------------------- */

test('functional summary reports counts, not a score', () => {
  const attempts = [
    attempt({ assistanceLevel: 0, outcome: 'success' }),
    attempt({ assistanceLevel: 1, outcome: 'success' }),
    attempt({ assistanceLevel: 4, outcome: 'success' }),
    attempt({ assistanceLevel: 4, outcome: 'failure' }),
  ];
  const s = functionalSummary('make-tea', attempts);
  assert.equal(s.observed, 4);
  // Levels 0 and 1 count as independent; 4 does not.
  assert.equal(s.independentCompletionRate, 50);
  assert.equal(s.successRate, 75);
  assert.match(s.summary, /2 of 4 recorded attempts/);
});

test('functional summary is honest about having no data', () => {
  const s = functionalSummary('unknown-task', []);
  assert.equal(s.hasEnoughData, false);
  assert.equal(s.independentCompletionRate, null);
});

test('only counts attempts for the requested task', () => {
  const s = functionalSummary('make-tea', [
    attempt({ taskId: 'make-tea' }),
    attempt({ taskId: 'get-dressed' }),
  ]);
  assert.equal(s.observed, 1);
});

/* ---- cue effectiveness ------------------------------------------------- */

test('ranks cues by success rate and ignores one-off flukes', () => {
  const attempts = [
    attempt({ cueType: 'photo', outcome: 'success' }),
    attempt({ cueType: 'photo', outcome: 'success' }),
    attempt({ cueType: 'verbal', outcome: 'failure' }),
    attempt({ cueType: 'verbal', outcome: 'failure' }),
    attempt({ cueType: 'written', outcome: 'success' }), // used once only
  ];
  assert.equal(mostEffectiveCue(attempts).cueType, 'photo');
  const written = cueEffectiveness(attempts).find((c) => c.cueType === 'written');
  assert.equal(written.used, 1, 'still reported…');
  assert.notEqual(mostEffectiveCue(attempts).cueType, 'written', '…but not crowned on one sample');
});

test('cue explanation cites real counts', () => {
  const attempts = [
    attempt({ cueType: 'photo', outcome: 'success' }),
    attempt({ cueType: 'photo', outcome: 'success' }),
    attempt({ cueType: 'photo', outcome: 'failure' }),
  ];
  assert.match(explainCueChoice(attempts), /helped in 2 of the last 3/);
});

test('cue explanation refuses to guess with no data', () => {
  assert.match(explainCueChoice([]), /Not enough recorded attempts/i);
});

/* ---- baseline change --------------------------------------------------- */

test('needs history before claiming anything is unusual', () => {
  const r = changeFromBaseline('make-tea', [attempt(), attempt()]);
  assert.equal(r.hasBaseline, false);
  assert.equal(r.changed, false);
});

test('flags a jump in required help without naming a cause', () => {
  const history = [
    ...Array.from({ length: 3 }, (_, i) => attempt({ assistanceLevel: 5, at: minutesAgo(i + 1) })),
    ...Array.from({ length: 8 }, (_, i) => attempt({ assistanceLevel: 1, at: minutesAgo(i + 100) })),
  ];
  const r = changeFromBaseline('make-tea', history);
  assert.equal(r.changed, true);
  assert.equal(r.direction, 'more-assistance');
  assert.match(r.note, /healthcare team/i, 'suggests escalation to clinicians');
  // The critical guarantee: no diagnostic language anywhere.
  assert.doesNotMatch(r.note, /dementia|decline|worsen|deteriorat|progress/i);
});

test('does not flag steady performance', () => {
  const history = Array.from({ length: 10 }, (_, i) => attempt({ assistanceLevel: 2, at: minutesAgo(i + 1) }));
  assert.equal(changeFromBaseline('make-tea', history).changed, false);
});

/* ---- repeated questions ------------------------------------------------ */

test('recognises the same question asked differently', () => {
  const sim = questionSimilarity('When is Meena coming?', 'What time will Meena be here?');
  assert.ok(sim >= ENGINE_RULES.questionSimilarityThreshold, `similarity was ${sim}`);
});

test('does not conflate unrelated questions', () => {
  const sim = questionSimilarity('When is Meena coming?', 'Where are my glasses?');
  assert.ok(sim < ENGINE_RULES.questionSimilarityThreshold, `similarity was ${sim}`);
});

test('escalates HOW it answers as a question repeats', () => {
  const history = [];
  const first = findRepeatedQuestion('When is Meena coming?', history);
  assert.equal(first.isRepeat, false);
  assert.equal(first.suggestedResponseMode, 'plain');

  history.push({ text: 'When is Meena coming?', at: minutesAgo(5) });
  const second = findRepeatedQuestion('What time will Meena be here?', history);
  assert.equal(second.isRepeat, true);
  assert.equal(second.suggestedResponseMode, 'answer-with-visual');

  history.push({ text: 'What time will Meena be here?', at: minutesAgo(2) });
  const third = findRepeatedQuestion('Is Meena coming today?', history);
  assert.equal(third.suggestedResponseMode, 'persistent-orientation-card');
  assert.match(third.caregiverNote, /visible reminder/i);
});

test('ignores similar questions outside the time window', () => {
  const old = [{ text: 'When is Meena coming?', at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() }];
  assert.equal(findRepeatedQuestion('When is Meena coming?', old).isRepeat, false);
});

test('repeat notes never imply progression', () => {
  const history = [
    { text: 'When is Meena coming?', at: minutesAgo(9) },
    { text: 'What time is Meena here?', at: minutesAgo(4) },
  ];
  const r = findRepeatedQuestion('Is Meena coming?', history);
  assert.doesNotMatch(r.caregiverNote || '', /decline|worsen|dementia|progress/i);
});

/* ---- behaviour patterns ------------------------------------------------ */

test('surfaces co-occurrence and what helped, with a disclaimer', () => {
  const events = Array.from({ length: 5 }, (_, i) => ({
    at: minutesAgo(i * 60),
    behaviour: 'Restlessness',
    contextTags: i < 4 ? ['lunch-delayed'] : ['visitor'],
    intervention: 'Offered food and drink',
    outcome: i < 3 ? 'helped' : 'no-change',
  }));
  const [pattern] = behaviourPatterns(events);
  assert.equal(pattern.occurrences, 5);
  assert.equal(pattern.commonContext.tag, 'lunch-delayed');
  assert.equal(pattern.commonContext.count, 4);
  assert.equal(pattern.bestIntervention.helped, 3);
  assert.match(pattern.disclaimer, /not a medical conclusion/i);
  // Must describe co-occurrence, never assert causation.
  assert.doesNotMatch(pattern.statement, /because|caused|due to/i);
});

test('will not claim a pattern from too few events', () => {
  const events = [{ at: minutesAgo(5), behaviour: 'Restlessness', contextTags: ['noise'] }];
  assert.equal(behaviourPatterns(events).length, 0);
});

/* ---- intention buffer -------------------------------------------------- */

test('recalls a stored intention with its provenance', () => {
  const r = recallIntention([{
    status: 'active',
    goal: 'get your glasses',
    destination: 'upstairs',
    sourceText: "I'm going upstairs for my glasses",
    at: minutesAgo(3),
  }]);
  assert.equal(r.found, true);
  assert.match(r.answer, /get your glasses/);
  assert.match(r.provenance.statement, /you said/i);
  assert.match(r.provenance.statement, /I'm going upstairs/);
});

test('NEVER invents an intention when nothing was recorded', () => {
  const r = recallIntention([]);
  assert.equal(r.found, false);
  assert.equal(r.provenance, null);
  assert.match(r.answer, /don't have anything recorded/i);
});

test('ignores stale intentions rather than answering from them', () => {
  const stale = [{
    status: 'active',
    goal: 'get your glasses',
    at: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
  }];
  assert.equal(recallIntention(stale).found, false);
});

test('ignores completed intentions', () => {
  const done = [{ status: 'completed', goal: 'get your glasses', at: minutesAgo(2) }];
  assert.equal(recallIntention(done).found, false);
});

/* ---- handoff + dashboard ---------------------------------------------- */

test('handoff rolls up today only, grouping repeated questions', () => {
  const h = dailyHandoff({
    attempts: [
      attempt({ taskId: 'get-dressed', assistanceLevel: 2, outcome: 'success', at: minutesAgo(60) }),
      attempt({ taskId: 'get-dressed', assistanceLevel: 4, outcome: 'failure', at: minutesAgo(50) }),
    ],
    questions: [
      { text: 'When is Meena coming?', topic: 'meena', at: minutesAgo(30) },
      { text: 'Is Meena here?', topic: 'meena', at: minutesAgo(20) },
      { text: 'Where are my glasses?', topic: 'glasses', at: minutesAgo(10) },
    ],
    behaviours: [{ at: minutesAgo(15), behaviour: 'Restlessness', intervention: 'Music', outcome: 'helped' }],
  });
  assert.equal(h.totals.taskAttempts, 2);
  assert.equal(h.totals.tasksCompleted, 1);
  const dressed = h.tasks.find((t) => t.taskId === 'get-dressed');
  assert.equal(dressed.maxLevel, 4);
  assert.deepEqual(h.repeatedQuestions.map((q) => q.topic), ['meena']);
  assert.equal(h.behaviourEvents.length, 1);
});

test('dashboard carries the not-a-severity-measure disclaimer', () => {
  const d = independenceDashboard([
    attempt({ assistanceLevel: 0, outcome: 'success' }),
    attempt({ assistanceLevel: 4, outcome: 'success' }),
  ]);
  assert.equal(d.hasData, true);
  assert.equal(d.independentCompletionRate, 50);
  assert.match(d.disclaimer, /not a measure of dementia severity/i);
});

test('dashboard is honest when the period is empty', () => {
  const old = [attempt({ at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() })];
  assert.equal(independenceDashboard(old, { days: 7 }).hasData, false);
});
