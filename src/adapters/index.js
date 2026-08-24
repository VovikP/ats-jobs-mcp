// Each adapter: pure fetch + normalize. No deps, no headless, no proxies.
// Every source must expose a stable id and support conditional requests.
const UA = 'ats-signals/0.1 (+https://apify.com/store; contact via Apify)';

async function getJson(url, etag) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  const t0 = Date.now();
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const ms = Date.now() - t0;
  if (r.status === 304) return { notModified: true, ms, etag, status: 304 };
  if (!r.ok) return { error: `HTTP ${r.status}`, status: r.status, ms };
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch { return { error: 'invalid JSON', status: r.status, ms }; }
  return { json, etag: r.headers.get('etag'), status: r.status, ms, bytes: body.length };
}

// Recruiter names, emails and phones never enter our data. GDPR is not a feature request.
const PII = /(?:[\w.+-]+@[\w-]+\.[\w.]+)|(?:\+?\d[\d\s().-]{7,}\d)/g;
const clean = s => (typeof s === 'string' ? s.replace(PII, '[removed]').slice(0, 500) : undefined);

const job = (o) => ({
  source_job_id: String(o.id),
  title: clean(o.title),
  location: clean(o.location),
  department: clean(o.department),
  employment_type: clean(o.employment_type),
  url: o.url,
  posted_at: o.posted_at || null,
  compensation: clean(o.compensation)
});

export const ADAPTERS = {
  greenhouse: {
    id: 'greenhouse',
    url: c => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c)}/jobs`,
    parse: j => (j.jobs || []).map(x => job({
      id: x.id, title: x.title, location: x.location?.name, url: x.absolute_url,
      posted_at: x.updated_at, department: (x.departments || [])[0]?.name
    }))
  },
  lever: {
    id: 'lever',
    url: c => `https://api.lever.co/v0/postings/${encodeURIComponent(c)}?mode=json`,
    parse: j => (Array.isArray(j) ? j : []).map(x => job({
      id: x.id, title: x.text, location: x.categories?.location, department: x.categories?.team,
      employment_type: x.categories?.commitment, url: x.hostedUrl,
      posted_at: x.createdAt ? new Date(x.createdAt).toISOString() : null
    }))
  },
  ashby: {
    id: 'ashby',
    url: c => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c)}`,
    parse: j => (j.jobs || []).map(x => job({
      id: x.id, title: x.title, location: x.location, department: x.department,
      employment_type: x.employmentType, url: x.jobUrl, posted_at: x.publishedAt,
      compensation: x.compensation?.compensationTierSummary
    }))
  },
  teamtailor: {
    id: 'teamtailor',
    // Teamtailor serves JSON Feed 1.1 — items[], not jobs[]
    url: c => `https://${encodeURIComponent(c)}.teamtailor.com/jobs.json`,
    parse: j => (j.items || []).map(x => job({
      id: x.id, title: x.title, url: x.url, posted_at: x.date_published,
      department: (x.tags || [])[0], location: x.location
    }))
  },
  smartrecruiters: {
    id: 'smartrecruiters',
    url: c => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(c)}/postings?limit=100`,
    parse: j => (j.content || []).map(x => job({
      id: x.id, title: x.name, location: [x.location?.city, x.location?.country].filter(Boolean).join(', '),
      department: x.department?.label, employment_type: x.typeOfEmployment?.label,
      url: x.ref || `https://jobs.smartrecruiters.com/${x.company?.identifier}/${x.id}`,
      posted_at: x.releasedDate
    }))
  },
  // Workable's public widget endpoint. No ETag / Last-Modified, so every check
  // is a full 16 KB fetch — still cheap, but it cannot take the 304 shortcut.
  workable: {
    id: 'workable',
    url: c => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(c)}?details=true`,
    parse: j => (j.jobs || []).map(x => job({
      id: x.shortcode || x.id, title: x.title,
      location: [x.city, x.country].filter(Boolean).join(', ') || (x.telecommuting ? 'Remote' : undefined),
      department: x.department, employment_type: x.employment_type,
      url: x.url || x.shortlink, posted_at: x.published_on || x.created_at || null
    }))
  },
  personio: {
    id: 'personio',
    url: c => `https://${encodeURIComponent(c)}.jobs.personio.de/search.json`,
    parse: j => (Array.isArray(j) ? j : (j.jobs || [])).map(x => job({
      id: x.id, title: x.name ?? x.title, location: x.office, department: x.department,
      employment_type: x.employmentType, url: x.url, posted_at: x.createdAt ?? null
    }))
  }
};

export async function fetchSource({ ats, company }, etag) {
  const a = ADAPTERS[ats];
  if (!a) return { error: `unknown ats: ${ats}` };
  const url = a.url(company);
  const res = await getJson(url, etag);
  if (res.notModified || res.error) return { ...res, url };
  return { ...res, url, jobs: a.parse(res.json) };
}
