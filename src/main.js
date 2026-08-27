import { Actor, log } from 'apify';
import { fetchSource } from './adapters/index.js';
import { resolveDomain } from './resolve.js';
import { diffJobs, deriveSignals, hashOf, fnOf } from './diff.js';

const SCHEMA_VERSION = '0.1';
const TRUNCATION_LIMIT = { smartrecruiters: 100 };

await Actor.init();

const input = await Actor.getInput() || {};
const sources = (input.sources || []).slice(0, input.maxSources || 200);
const domains = (input.domains || []).slice(0, input.maxSources || 200);
const wantSignals = input.deriveSignals !== false;
const wantEvidence = input.includeEvidence === true;
const tally = { sources: 0, unchanged: 0, indexed: 0, changes: 0, signals: 0, unresolved: 0, errors: 0 };

// State must live in a store owned by THIS Actor: a store created by another
// Actor is outside a limited-permission token's scope and returns 403.
const stateStoreName = `ats-state-${(Actor.getEnv().actorId || 'local').toLowerCase()}`;
let store;
let statePersistent = true;
try {
  store = await Actor.openKeyValueStore(stateStoreName);
} catch (e) {
  log.warning(`Named state store unavailable (${e.message}). Falling back to the run's default store.`);
  store = await Actor.openKeyValueStore();
  statePersistent = false;
}
// Agents know domains, not board tokens. Resolve one into the other and cache
// the answer: a company does not change its ATS twice a week.
if (domains.length) {
  const map = (await store.getValue('domain-map')) || {};
  for (const d of domains) {
    const host = String(d).replace(/^https?:[/][/]/, '').replace(/[/].*$/, '').replace(/^www[.]/, '');
    if (!map[host]) {
      const r = await resolveDomain(host);
      map[host] = r || { ats: null };
      log.info(r ? `resolved ${host} -> ${r.ats}/${r.company} (${r.method})` : `could not resolve ${host}`);
    }
    const m = map[host];
    if (m && m.ats && !sources.some(x => x.ats === m.ats && x.company === m.company))
      sources.push({ ats: m.ats, company: m.company, label: host });
    if (!m || !m.ats)
      tally.unresolved++,
      await Actor.pushData({ schema_version: SCHEMA_VERSION, type: 'source_unresolved', type_family: 'meta',
        domain: host, observed_at: new Date().toISOString(),
        hint: 'Jobs are on an unsupported ATS or rendered with JavaScript.' });
  }
  await store.setValue('domain-map', map);
}

let stop = false;

const charge = async (eventName, count = 1) => {
  if (stop || count <= 0) return false;
  const r = await Actor.charge({ eventName, count });
  if (r?.eventChargeLimitReached) { stop = true; log.warning(`Charge limit reached at ${eventName}`); }
  return true;
};

for (const s of sources) {
  if (stop) break;
  const key = `state__${s.ats}__${String(s.company).replace(/[^a-z0-9_-]/gi, '_')}`;
  const state = (await store.getValue(key)) || { jobs: {}, history: [], functions: {} };

  tally.sources++;
  await charge('source-checked');
  const res = await fetchSource(s, state.etag);

  if (res.notModified) {
    tally.unchanged++;
    log.info(`${s.ats}/${s.company}: 304 not modified (${res.ms}ms)`);
    continue;
  }
  if (res.error) {
    tally.errors++;
    await Actor.pushData({ schema_version: SCHEMA_VERSION, type: 'source_error', type_family: 'meta',
      source: s, error: res.error, observed_at: new Date().toISOString() });
    continue;
  }

  const jobs = res.jobs || [];
  const limit = TRUNCATION_LIMIT[s.ats];
  const truncated = Boolean(limit && jobs.length >= limit);
  const baseline = Object.keys(state.jobs).length === 0;
  const observed_at = new Date().toISOString();
  const evidence = { source_url: res.url, http_status: res.status, etag: res.etag,
    fetch_ms: res.ms, job_count: jobs.length, truncated };

  let events = [];
  if (baseline) {
    events = jobs.map(j => ({ type: 'job_indexed', type_family: 'supply', job: j }));
    // Functions that already exist at baseline are not new hires. Without this,
    // the first real diff reports every function as a first-ever role.
    for (const j of jobs) { const f = fnOf(j); if (f !== 'other') state.functions[f] = observed_at; }
  } else {
    events = diffJobs(state.jobs, jobs, { truncated });
  }

  // month history
  const month = observed_at.slice(0, 7);
  let mh = state.history.find(h => h.month === month);
  if (!mh) { mh = { month, posted: 0, total: 0 }; state.history.push(mh); }
  mh.posted += events.filter(e => e.type === 'job_posted').length;
  mh.total = jobs.length;
  state.history = state.history.slice(-24);

  const signals = (!baseline && wantSignals) ? deriveSignals(state.history, events, state) : [];
  for (const e of events) if (e.type === 'job_posted') { const f = fnOf(e.job); if (f !== 'other') state.functions[f] = observed_at; }
  if (signals.length) {
    state.signalsEmitted = state.signalsEmitted || {};
    const mk = observed_at.slice(0, 7);
    state.signalsEmitted[mk] = [...new Set([...(state.signalsEmitted[mk] || []),
      ...signals.filter(x => x.type !== 'first_role_in_function').map(x => x.type)])];
  }

  const emit = async (e, chargeEvent) => {
    await Actor.pushData({
      schema_version: SCHEMA_VERSION, observed_at,
      company: s.company, ats: s.ats, label: s.label || null,
      ...e,
      confidence: truncated ? 0.6 : 0.99,
      evidence: wantEvidence ? evidence : { source_url: evidence.source_url, truncated }
    });
  };

  if (baseline) {
    for (const e of events) await emit(e);
    tally.indexed += events.length;
    // Without durable state every run is a fresh baseline. Charging for it would
    // bill the caller for the same catalogue over and over, so we take the loss.
    if (statePersistent) await charge('job-indexed', events.length);
    else log.warning('State is not persistent — baseline delivered free of charge.');
    log.info(`${s.ats}/${s.company}: baseline ${events.length} jobs`);
  } else {
    for (const e of events) await emit(e);
    tally.changes += events.length;
    if (events.length) await charge('change-detected', events.length);
    for (const e of signals) await emit(e);
    tally.signals += signals.length;
    if (signals.length) await charge('signal-derived', signals.length);
    log.info(`${s.ats}/${s.company}: ${events.length} changes, ${signals.length} signals`);
  }
  if (wantEvidence && (events.length || signals.length)) await charge('evidence-full');

  state.etag = res.etag;
  state.jobs = Object.fromEntries(jobs.map(j => [j.source_job_id, { h: hashOf(j), title: j.title,
    location: j.location, department: j.department, employment_type: j.employment_type,
    compensation: j.compensation, url: j.url }]));
  await store.setValue(key, state);
}

// A run that found nothing is a valid answer, not a failure. Emit it explicitly:
// an empty dataset would look like a broken Actor to both the caller and to
// Apify's daily health check.
await Actor.pushData({
  schema_version: SCHEMA_VERSION,
  type: 'run_summary',
  type_family: 'meta',
  observed_at: new Date().toISOString(),
  sources_checked: tally.sources,
  sources_unchanged: tally.unchanged,
  jobs_indexed: tally.indexed,
  changes_detected: tally.changes,
  signals_derived: tally.signals,
  sources_unresolved: tally.unresolved,
  source_errors: tally.errors
});
log.info(`run summary: ${tally.sources} sources, ${tally.unchanged} unchanged, ${tally.changes} changes, ${tally.signals} signals`);

await Actor.exit();
