// Agents know domains, not board tokens. Resolve one into the other so the
// caller never has to know what an ATS is. Results are cached in state:
// resolution costs several fetches, a check costs almost nothing.
import { ADAPTERS, fetchSource } from './adapters.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

const PATTERNS = [
  [/boards\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, 'greenhouse'],
  [/job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/jobs\.lever\.co\/([a-z0-9_-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i, 'ashby'],
  [/https?:\/\/([a-z0-9_-]+)\.teamtailor\.com/i, 'teamtailor'],
  [/careers\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, 'smartrecruiters'],
  [/apply\.workable\.com\/([a-z0-9_-]+)/i, 'workable']
];

async function page(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
    return r.ok ? await r.text() : '';
  } catch { return ''; }
}

export async function resolveDomain(domain) {
  const host = String(domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const slug = host.split('.')[0].replace(/[^a-z0-9-]/gi, '').toLowerCase();

  for (const h of [host, `careers.${host}`, `jobs.${host}`]) {
    for (const path of ['/careers', '/jobs', '']) {
      const body = await page(`https://${h}${path}`);
      if (!body) continue;
      for (const [re, ats] of PATTERNS) {
        const m = body.match(re);
        if (!m || !m[1]) continue;
        if (ats === 'workable' && m[1] === 'j') {
          const short = body.match(/apply\.workable\.com\/j\/([A-Za-z0-9]+)/);
          if (short) {
            try {
              const rr = await fetch(`https://apply.workable.com/j/${short[1]}`, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
              const acc = rr.url.match(/apply\.workable\.com\/([a-z0-9-]+)\//i);
              if (acc && acc[1] !== 'j') return { ats, company: acc[1], method: 'workable-redirect' };
            } catch {}
          }
          continue;
        }
        if (!/^(www|assets|static|cdn|j)$/i.test(m[1])) return { ats, company: m[1], method: 'careers-link' };
      }
    }
  }

  for (const ats of Object.keys(ADAPTERS)) {
    const r = await fetchSource({ ats, company: slug });
    if (!r.error && Array.isArray(r.jobs) && r.jobs.length > 0)
      return { ats, company: slug, method: 'slug-probe' };
  }
  return null;
}
