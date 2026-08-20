/* Meco, Cognitive Independence Engine */

/** The Meco Assistance Ladder. Ordered; index === level. */
export const ASSISTANCE_LADDER = [
  {
    level: 0,
    key: 'independent',
    name: 'Independent',
    description: 'Do nothing. The best intervention is often no intervention.',
    caregiverFacing: 'No help offered',
  },
  {
    level: 1,
    key: 'environmental',
    name: 'Environmental cue',
    description: 'Draw attention, highlight the object, show a familiar photo, display the routine.',
    caregiverFacing: 'A visual nudge',
  },
  {
    level: 2,
    key: 'contextual',
    name: 'Contextual cue',
    description: 'Point at the context without naming the answer. "Think about what you normally do after breakfast."',
    caregiverFacing: 'A gentle reminder of context',
  },
  {
    level: 3,
    key: 'hint',
    name: 'Specific hint',
    description: 'Narrow it down. "It has something to do with your morning medicine."',
    caregiverFacing: 'A specific hint',
  },
  {
    level: 4,
    key: 'nextStep',
    name: 'Next-step prompt',
    description: 'Name only the next action. "Open your pill organiser."',
    caregiverFacing: 'The next step, named',
  },
  {
    level: 5,
    key: 'guided',
    name: 'Full guided assistance',
    description: 'Step-by-step instructions through the whole task.',
    caregiverFacing: 'Step-by-step guidance',
  },
  {
    level: 6,
    key: 'human',
    name: 'Human assistance',
    description: 'Offer or alert an authorised caregiver.',
    caregiverFacing: 'A person helps',
  },
];

export const MAX_LEVEL = 6;
export const MIN_LEVEL = 0;

/** Cue types whose effectiveness we track per person, per task. */
export const CUE_TYPES = ['visual', 'verbal', 'photo', 'familiar-voice', 'written', 'contextual', 'physical', 'none'];

/** Outcome of a single recorded attempt at a task. */
export const OUTCOMES = ['success', 'partial', 'failure', 'abandoned'];

/* Tunables. Exported so the caregiver UI can show the actual thresholds rather than */
export const ENGINE_RULES = {
  /** Consecutive successes at a level before we try offering less help. */
  successesBeforeFading: 3,
  /** Consecutive non-successes at a level before we offer more help. */
  failuresBeforeEscalating: 2,
  /** Attempts needed before we'll claim any pattern at all. */
  minAttemptsForConfidence: 4,
  /** How many recent attempts define "usual" for baseline comparison. */
  baselineWindow: 10,
  /** Attempts that must exist before baseline-change detection runs. */
  minAttemptsForBaseline: 6,
  /** Level jump vs. personal baseline that counts as a notable change. */
  baselineDeviationLevels: 1.5,
  /** Minutes within which two similar questions count as a repeat. */
  repeatQuestionWindowMinutes: 60,
  /** Token overlap ratio at which two questions are treated as the same. */
  questionSimilarityThreshold: 0.5,
};

const clampLevel = (level, ceiling = MAX_LEVEL, floor = MIN_LEVEL) =>
  Math.max(floor, Math.min(ceiling, Math.round(level)));

const isSuccess = (attempt) => attempt?.outcome === 'success';
const isNonSuccess = (attempt) => attempt && attempt.outcome !== 'success';

/** Newest-first, tolerating missing/garbage timestamps. */
const byNewest = (a, b) => new Date(b.at || 0) - new Date(a.at || 0);

const sortedAttempts = (attempts = []) =>
  attempts.filter((a) => a && typeof a === 'object').slice().sort(byNewest);

/* 1. FUNCTIONAL MODEL: what can this person currently do by themselves? */
export function functionalSummary(taskId, attempts = []) {
  const relevant = sortedAttempts(attempts).filter((a) => a.taskId === taskId);
  const total = relevant.length;

  if (!total) {
    return {
      taskId,
      observed: 0,
      hasEnoughData: false,
      independentCompletionRate: null,
      typicalAssistanceLevel: null,
      medianAssistanceLevel: null,
      mostEffectiveCue: null,
      summary: 'No attempts recorded yet.',
    };
  }

  const successes = relevant.filter(isSuccess);
  // "Independent" means succeeded at level 0 or 1: the person did the task,
  // with at most a nudge. Anything from level 2 up is real assistance.
  const independent = successes.filter((a) => (a.assistanceLevel ?? 0) <= 1);

  const levels = relevant.map((a) => a.assistanceLevel ?? 0).sort((x, y) => x - y);
  const median = levels[Math.floor(levels.length / 2)];
  const mean = levels.reduce((sum, l) => sum + l, 0) / levels.length;

  return {
    taskId,
    observed: total,
    hasEnoughData: total >= ENGINE_RULES.minAttemptsForConfidence,
    independentCompletionRate: Math.round((independent.length / total) * 100),
    successRate: Math.round((successes.length / total) * 100),
    typicalAssistanceLevel: median,
    medianAssistanceLevel: median,
    meanAssistanceLevel: Math.round(mean * 10) / 10,
    mostEffectiveCue: mostEffectiveCue(relevant),
    // Phrased as a count of observations, never as a capability verdict.
    summary: `${independent.length} of ${total} recorded attempts were completed with little or no assistance.`,
  };
}

/* 2. ASSISTANCE MODEL, which kind of help actually works for this person? */
export function cueEffectiveness(attempts = []) {
  const table = {};
  for (const attempt of attempts) {
    const cue = attempt?.cueType;
    if (!cue || !CUE_TYPES.includes(cue)) continue;
    table[cue] ??= { cueType: cue, used: 0, succeeded: 0 };
    table[cue].used += 1;
    if (isSuccess(attempt)) table[cue].succeeded += 1;
  }
  return Object.values(table)
    .map((row) => ({
      ...row,
      successRate: row.used ? Math.round((row.succeeded / row.used) * 100) : 0,
    }))
    .sort((a, b) => b.successRate - a.successRate || b.used - a.used);
}

export function mostEffectiveCue(attempts = []) {
  const ranked = cueEffectiveness(attempts).filter(
    (row) => row.used >= 2 && row.cueType !== 'none'
  );
  return ranked.length ? ranked[0] : null;
}

/* 3. ADAPTIVE LEVEL SELECTION: the heart of the engine. */
export function recommendAssistanceLevel(taskId, attempts = [], options = {}) {
  const {
    safetyCeiling = MAX_LEVEL,
    safetyFloor = MIN_LEVEL,
    defaultLevel = 3,
  } = options;

  const history = sortedAttempts(attempts).filter((a) => a.taskId === taskId);

  if (!history.length) {
    const level = clampLevel(defaultLevel, safetyCeiling, safetyFloor);
    return {
      taskId,
      level,
      ladder: ASSISTANCE_LADDER[level],
      confidence: 'none',
      changed: null,
      reason: 'No attempts recorded yet, so Meco starts mid-ladder and adjusts from what happens.',
      evidence: { observed: 0 },
      experimental: true,
    };
  }

  const lastLevel = history[0].assistanceLevel ?? defaultLevel;

  // Count the current streak at the level most recently used.
  let successStreak = 0;
  for (const attempt of history) {
    if ((attempt.assistanceLevel ?? -1) !== lastLevel) break;
    if (isSuccess(attempt)) successStreak += 1; else break;
  }

  let failureStreak = 0;
  for (const attempt of history) {
    if ((attempt.assistanceLevel ?? -1) !== lastLevel) break;
    if (isNonSuccess(attempt)) failureStreak += 1; else break;
  }

  const observed = history.length;
  const confidence =
    observed >= ENGINE_RULES.minAttemptsForConfidence ? 'observed' : 'provisional';

  if (successStreak >= ENGINE_RULES.successesBeforeFading && lastLevel > safetyFloor) {
    const level = clampLevel(lastLevel - 1, safetyCeiling, safetyFloor);
    return {
      taskId,
      level,
      ladder: ASSISTANCE_LADDER[level],
      confidence,
      changed: 'faded',
      reason: `Succeeded ${successStreak} times in a row with ${ASSISTANCE_LADDER[lastLevel].caregiverFacing.toLowerCase()}, so Meco is trying less help this time.`,
      evidence: { observed, successStreak, previousLevel: lastLevel },
      experimental: true,
    };
  }

  if (failureStreak >= ENGINE_RULES.failuresBeforeEscalating && lastLevel < safetyCeiling) {
    const level = clampLevel(lastLevel + 1, safetyCeiling, safetyFloor);
    return {
      taskId,
      level,
      ladder: ASSISTANCE_LADDER[level],
      confidence,
      changed: 'escalated',
      reason: `The last ${failureStreak} attempts at this level didn't finish, so Meco is offering a little more help.`,
      evidence: { observed, failureStreak, previousLevel: lastLevel },
      experimental: true,
    };
  }

  const level = clampLevel(lastLevel, safetyCeiling, safetyFloor);
  return {
    taskId,
    level,
    ladder: ASSISTANCE_LADDER[level],
    confidence,
    changed: 'held',
    reason: `Holding at ${ASSISTANCE_LADDER[level].caregiverFacing.toLowerCase()}. This is the level that has been working.`,
    evidence: { observed, successStreak, failureStreak },
    experimental: true,
  };
}

/** Human-readable justification for a cue choice, e.g. for a "Why?" popover. */
export function explainCueChoice(attempts = []) {
  const best = mostEffectiveCue(attempts);
  if (!best) {
    return 'Not enough recorded attempts yet to tell which kind of cue works best.';
  }
  return `A ${best.cueType} cue was suggested because it helped in ${best.succeeded} of the last ${best.used} attempts.`;
}

/* 4. CHANGE FROM PERSONAL BASELINE */
export function changeFromBaseline(taskId, attempts = []) {
  const history = sortedAttempts(attempts).filter((a) => a.taskId === taskId);

  if (history.length < ENGINE_RULES.minAttemptsForBaseline) {
    return {
      taskId,
      hasBaseline: false,
      changed: false,
      note: 'Not enough history yet to know what is usual for this task.',
    };
  }

  const recent = history.slice(0, 3);
  const baseline = history.slice(3, 3 + ENGINE_RULES.baselineWindow);
  if (!baseline.length) {
    return { taskId, hasBaseline: false, changed: false, note: 'Not enough history yet.' };
  }

  const avg = (rows) =>
    rows.reduce((sum, r) => sum + (r.assistanceLevel ?? 0), 0) / rows.length;

  const recentAvg = avg(recent);
  const baselineAvg = avg(baseline);
  const delta = recentAvg - baselineAvg;
  const changed = Math.abs(delta) >= ENGINE_RULES.baselineDeviationLevels;

  return {
    taskId,
    hasBaseline: true,
    changed,
    direction: delta > 0 ? 'more-assistance' : delta < 0 ? 'less-assistance' : 'same',
    recentAverageLevel: Math.round(recentAvg * 10) / 10,
    baselineAverageLevel: Math.round(baselineAvg * 10) / 10,
    // Strictly an observation plus a care-coordination suggestion. No cause.
    note: changed
      ? delta > 0
        ? `Recent attempts have needed more help than usual (about level ${Math.round(recentAvg * 10) / 10} versus a usual level ${Math.round(baselineAvg * 10) / 10}). Changes like this can have many everyday or medical explanations, it may be worth mentioning to their healthcare team.`
        : `Recent attempts have needed less help than usual (about level ${Math.round(recentAvg * 10) / 10} versus a usual level ${Math.round(baselineAvg * 10) / 10}).`
      : 'In line with what is usual for this task.',
    experimental: true,
  };
}

/* 5. REPEATED QUESTION INTELLIGENCE */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could',
  'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'my', 'me', 'i',
  'it', 'this', 'that', 'what', 'when', 'where', 'who', 'why', 'how',
  'again', 'now', 'today', 'time', 'tell',
]);

export function questionTokens(text = '') {
  return [...new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
  )];
}

/* Overlap coefficient of content words, shared / size-of-smaller-question. */
export function questionSimilarity(a, b) {
  const left = questionTokens(a);
  const right = questionTokens(b);
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const shared = left.filter((token) => rightSet.has(token)).length;
  if (!shared) return 0;
  return shared / Math.min(left.length, right.length);
}

export function findRepeatedQuestion(newQuestion, history = [], now = new Date()) {
  const windowMs = ENGINE_RULES.repeatQuestionWindowMinutes * 60 * 1000;
  const nowMs = new Date(now).getTime();

  const matches = history
    .filter((entry) => {
      const t = new Date(entry.at || 0).getTime();
      return Number.isFinite(t) && nowMs - t <= windowMs && nowMs - t >= 0;
    })
    .map((entry) => ({ entry, similarity: questionSimilarity(newQuestion, entry.text) }))
    .filter((row) => row.similarity >= ENGINE_RULES.questionSimilarityThreshold)
    .sort((a, b) => b.similarity - a.similarity);

  const repeatCount = matches.length;

  return {
    isRepeat: repeatCount > 0,
    repeatCount,
    // 1st ask: answer plainly. 2nd: answer + a visual. 3rd+: leave a
    // persistent card up so the answer stops depending on asking again.
    suggestedResponseMode:
      repeatCount === 0 ? 'plain'
      : repeatCount === 1 ? 'answer-with-visual'
      : 'persistent-orientation-card',
    closestMatch: matches[0]?.entry ?? null,
    similarity: matches[0]?.similarity ?? 0,
    // Deliberately descriptive. Repetition is a communication signal, not a
    // progression marker, and must never be presented as one.
    caregiverNote: repeatCount >= 2
      ? `This question has come up ${repeatCount + 1} times in the last ${ENGINE_RULES.repeatQuestionWindowMinutes} minutes. A visible reminder may help more than answering again.`
      : null,
  };
}

/* 6. BEHAVIOUR PATTERNS (ABC-style) */
export function behaviourPatterns(events = [], { minOccurrences = 3 } = {}) {
  const byBehaviour = {};

  for (const event of events) {
    if (!event?.behaviour) continue;
    const key = String(event.behaviour).toLowerCase().trim();
    byBehaviour[key] ??= { behaviour: event.behaviour, occurrences: 0, contexts: {}, interventions: {} };
    const bucket = byBehaviour[key];
    bucket.occurrences += 1;

    for (const tag of event.contextTags || []) {
      bucket.contexts[tag] ??= 0;
      bucket.contexts[tag] += 1;
    }

    if (event.intervention) {
      const name = event.intervention;
      bucket.interventions[name] ??= { intervention: name, tried: 0, helped: 0 };
      bucket.interventions[name].tried += 1;
      if (event.outcome === 'helped' || event.outcome === 'partially-helped') {
        bucket.interventions[name].helped += 1;
      }
    }
  }

  return Object.values(byBehaviour)
    .filter((row) => row.occurrences >= minOccurrences)
    .map((row) => {
      const topContext = Object.entries(row.contexts).sort((a, b) => b[1] - a[1])[0];
      const topIntervention = Object.values(row.interventions).sort((a, b) => b.helped - a.helped)[0];
      return {
        behaviour: row.behaviour,
        occurrences: row.occurrences,
        commonContext: topContext ? { tag: topContext[0], count: topContext[1] } : null,
        bestIntervention: topIntervention?.helped ? topIntervention : null,
        // The wording here is load-bearing, not decoration.
        statement: topContext
          ? `${row.behaviour} was recorded ${row.occurrences} times. ${topContext[1]} of those also had "${topContext[0]}" recorded.`
          : `${row.behaviour} was recorded ${row.occurrences} times.`,
        helpStatement: topIntervention?.helped
          ? `"${topIntervention.intervention}" was recorded as helping in ${topIntervention.helped} of ${topIntervention.tried} attempts.`
          : null,
        disclaimer: 'Possible pattern based on recorded observations, not a medical conclusion. Consider unmet needs and follow the existing care plan.',
        experimental: true,
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences);
}

/* 7. INTENTION BUFFER */
export function recallIntention(intentions = [], { now = new Date(), maxAgeMinutes = 120 } = {}) {
  const nowMs = new Date(now).getTime();
  const active = intentions
    .filter((i) => i?.status === 'active')
    .filter((i) => {
      const t = new Date(i.at || 0).getTime();
      return Number.isFinite(t) && nowMs - t <= maxAgeMinutes * 60 * 1000;
    })
    .sort(byNewest);

  if (!active.length) {
    return {
      found: false,
      answer: "I don't have anything recorded about that yet.",
      provenance: null,
    };
  }

  const latest = active[0];
  const minutesAgo = Math.max(0, Math.round((nowMs - new Date(latest.at).getTime()) / 60000));

  return {
    found: true,
    intention: latest,
    answer: latest.goal
      ? `You were going to ${latest.goal}${latest.destination ? `, you said you were heading to the ${latest.destination}` : ''}.`
      : 'You had something in mind, but the details were not recorded.',
    // Shown behind a "Why Meco thinks this" control. Every reconstructed
    // answer must be traceable to the utterance it came from.
    provenance: {
      recordedAt: latest.at,
      minutesAgo,
      sourceText: latest.sourceText || null,
      statement: latest.sourceText
        ? `${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago you said: "${latest.sourceText}"`
        : `Recorded ${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago.`,
    },
  };
}

/* 8. DAILY HANDOFF */
export function dailyHandoff({ attempts = [], questions = [], behaviours = [], medicationLogs = [] } = {}, day = new Date()) {
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const inDay = (row) => {
    const t = new Date(row?.at || 0).getTime();
    return t >= dayStart.getTime() && t < dayEnd.getTime();
  };

  const todaysAttempts = attempts.filter(inDay);
  const todaysQuestions = questions.filter(inDay);
  const todaysBehaviours = behaviours.filter(inDay);
  const todaysMeds = medicationLogs.filter(inDay);

  const byTask = {};
  for (const attempt of todaysAttempts) {
    byTask[attempt.taskId] ??= { taskId: attempt.taskId, attempts: 0, maxLevel: 0, completed: 0 };
    byTask[attempt.taskId].attempts += 1;
    byTask[attempt.taskId].maxLevel = Math.max(byTask[attempt.taskId].maxLevel, attempt.assistanceLevel ?? 0);
    if (isSuccess(attempt)) byTask[attempt.taskId].completed += 1;
  }

  // Questions grouped by topic so the summary reads "asked about Meena 4
  // times" rather than listing four near-identical sentences.
  const questionTopics = {};
  for (const q of todaysQuestions) {
    const key = (q.topic || questionTokens(q.text)[0] || 'other').toLowerCase();
    questionTopics[key] ??= { topic: key, count: 0 };
    questionTopics[key].count += 1;
  }

  return {
    date: dayStart.toISOString().slice(0, 10),
    tasks: Object.values(byTask).sort((a, b) => b.attempts - a.attempts),
    repeatedQuestions: Object.values(questionTopics)
      .filter((t) => t.count > 1)
      .sort((a, b) => b.count - a.count),
    behaviourEvents: todaysBehaviours.map((b) => ({
      at: b.at,
      behaviour: b.behaviour,
      intervention: b.intervention || null,
      outcome: b.outcome || null,
    })),
    medication: todaysMeds.map((m) => ({
      at: m.at,
      name: m.name,
      status: m.status,
      confirmedBy: m.confirmedBy || null,
    })),
    totals: {
      taskAttempts: todaysAttempts.length,
      tasksCompleted: todaysAttempts.filter(isSuccess).length,
      questionsAsked: todaysQuestions.length,
      behaviourEvents: todaysBehaviours.length,
    },
  };
}

/* 9. INDEPENDENCE DASHBOARD ROLL-UP */
export function independenceDashboard(attempts = [], { days = 7 } = {}, now = new Date()) {
  const cutoff = new Date(now).getTime() - days * 24 * 60 * 60 * 1000;
  const window = attempts.filter((a) => new Date(a?.at || 0).getTime() >= cutoff);

  if (!window.length) {
    return {
      periodDays: days,
      hasData: false,
      note: 'No task attempts recorded in this period.',
    };
  }

  const successes = window.filter(isSuccess);
  const independent = successes.filter((a) => (a.assistanceLevel ?? 0) <= 1);
  const levels = window.map((a) => a.assistanceLevel ?? 0);
  const meanLevel = levels.reduce((s, l) => s + l, 0) / levels.length;

  return {
    periodDays: days,
    hasData: true,
    independentCompletionRate: Math.round((independent.length / window.length) * 100),
    averageAssistanceLevel: Math.round(meanLevel * 10) / 10,
    attemptsRecorded: window.length,
    tasksCompleted: successes.length,
    caregiverInterventions: window.filter((a) => (a.assistanceLevel ?? 0) >= 6).length,
    cueEffectiveness: cueEffectiveness(window),
    // Guards against the single most dangerous misreading of this screen.
    disclaimer: 'These figures describe performance on specific recorded routines. They are not a measure of dementia severity or cognitive decline.',
  };
}
