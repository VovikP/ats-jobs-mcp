// Deterministic diff. The rule that saves us from mass false positives:
// never emit job_closed when the source response might be truncated.
// Order matters: the first pattern that matches wins. Specific disciplines are
// checked before the generic "engineer", otherwise a first security or ML hire
// is filed as plain engineering and the signal is lost.
const FUNCTIONS = {
  ai_ml: /machine learning|ml|ai|data scien|llm|nlp|applied scien|deep learning/i,
  security: /security|infosec|appsec|compliance|grc|trust & safety/i,
  data: /data engineer|data platform|analytics|data analyst|bi|warehouse/i,
  sales: /sales|account executive|business development|revenue|sdr|bdr|solutions engineer/i,
  marketing: /marketing|growth|demand gen|content|seo|brand|communications/i,
  product: /product manager|product owner|pm|designer|design|ux|ui/i,
  support: /support|customer success|onboarding|solutions architect/i,
  finance: /finance|account(ing|ant)|controller|fp&a|treasury/i,
  people: /recruit|people|talent|hr|workplace/i,
  engineering: /engineer|developer|architect|sre|devops|backend|frontend|full.?stack|mobile|qa/i
};

export const fnOf = j => {
  const s = `${j.title || ''} ${j.department || ''}`;
  for (const [k, re] of Object.entries(FUNCTIONS)) if (re.test(s)) return k;
  return 'other';
};

export const hashOf = j =>
  [j.title, j.location, j.department, j.employment_type, j.compensation].map(x => x || '').join('|');

export function diffJobs(prev, jobs, { truncated }) {
  const now = new Map(jobs.map(j => [j.source_job_id, j]));
  const events = [];
  for (const [id, j] of now) {
    const p = prev[id];
    if (!p) { events.push({ type: 'job_posted', type_family: 'supply', job: j }); continue; }
    const h = hashOf(j);
    if (p.h !== h) {
      const changed = ['title', 'location', 'department', 'employment_type', 'compensation']
        .filter(f => (p[f] || '') !== (j[f] || ''));
      events.push({ type: changed.includes('compensation') ? 'salary_changed' : 'job_changed',
        type_family: 'supply', job: j, changed_fields: changed,
        prev: Object.fromEntries(changed.map(f => [f, p[f] || null])) });
    }
  }
  if (!truncated) {
    for (const id of Object.keys(prev)) {
      if (!now.has(id)) events.push({ type: 'job_closed', type_family: 'supply',
        job: { source_job_id: id, title: prev[id].title, url: prev[id].url } });
    }
  }
  return events;
}

// Derived signals — this is the part an agent cannot compute from one page view.
export function deriveSignals(history, events, state) {
  const out = [];
  const month = new Date().toISOString().slice(0, 7);
  const posted = events.filter(e => e.type === 'job_posted');
  const hist = history.filter(h => h.month !== month);
  const prevAvg = hist.length ? hist.slice(-3).reduce((a, h) => a + h.posted, 0) / Math.min(hist.length, 3) : 0;
  const cur = (history.find(h => h.month === month)?.posted || 0);

  if (cur >= 3 && prevAvg > 0 && cur >= prevAvg * 2)
    out.push({ type: 'hiring_accelerating', type_family: 'signal',
      magnitude_pct: Math.round((cur / prevAvg - 1) * 100),
      detail: { current_month: cur, prior_avg: +prevAvg.toFixed(1) } });

  // Mark functions as seen while iterating, otherwise ten sales roles posted in
  // one run each look like "the first sales hire" and the caller is charged ten
  // times for one fact.
  const seen = { ...(state.functions || {}) };
  for (const e of posted) {
    const f = fnOf(e.job);
    if (f !== 'other' && !seen[f]) {
      seen[f] = true;
      out.push({ type: 'first_role_in_function', type_family: 'signal', function: f,
        detail: { title: e.job.title, url: e.job.url } });
    }
  }

  if (cur === 0 && prevAvg >= 3)
    out.push({ type: 'hiring_freeze', type_family: 'signal',
      detail: { current_month: 0, prior_avg: +prevAvg.toFixed(1) } });

  return out;
}
