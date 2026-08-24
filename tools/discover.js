#!/usr/bin/env node
// Company domain -> which ATS it uses + the board token.
// Two strategies: read the careers page for an ATS link (reliable),
// then fall back to probing API endpoints with a slug guessed from the domain.
import { ADAPTERS, fetchSource } from '../src/adapters/index.js';
import { renderDom, BROWSER } from './render.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const PATTERNS = [
  [/boards\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, 'greenhouse'],
  [/job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/jobs\.lever\.co\/([a-z0-9_-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i, 'ashby'],
  [/https?:\/\/([a-z0-9_-]+)\.teamtailor\.com/i, 'teamtailor'],
  [/careers\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, 'smartrecruiters'],
  [/([a-z0-9_-]+)\.jobs\.personio\.(?:de|com)/i, 'personio'],
  [/apply\.workable\.com\/([a-z0-9_-]+)/i, 'workable'],
  [/([a-z0-9_-]+)\.recruitee\.com/i, 'recruitee']
];

async function html(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    return r.ok ? await r.text() : '';
  } catch { return ''; }
}

export async function discover(domain) {
  const host = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const slug = host.split('.')[0].replace(/[^a-z0-9-]/gi, '').toLowerCase();

  // 1. look for an ATS link on the site's career pages, including the
  // careers.* / jobs.* subdomains where most companies actually park them
  const bare = host.replace(/^www\./, '');
  const urls = [];
  for (const h of [host, `careers.${bare}`, `jobs.${bare}`])
    for (const path of ['', '/careers', '/jobs', '/career', '/about/careers', '/company/careers'])
      urls.push(`https://${h}${path}`);
  for (const url of urls) {
    const body = await html(url);
    if (!body) continue;
    for (const [re, ats] of PATTERNS) {
      const m = body.match(re);
      if (!m || !m[1]) continue;
      // apply.workable.com/j/<code> hides the account behind a redirect
      if (ats === 'workable' && m[1] === 'j') {
        const short = body.match(/apply\.workable\.com\/j\/([A-Za-z0-9]+)/);
        if (short) {
          try {
            const rr = await fetch(`https://apply.workable.com/j/${short[1]}`, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
            const acc = rr.url.match(/apply\.workable\.com\/([a-z0-9-]+)\//i);
            if (acc && acc[1] !== 'j') return { domain: host, ats, company: acc[1], method: 'workable-redirect', evidence: rr.url };
          } catch {}
        }
        continue;
      }
      if (!/^(www|assets|static|cdn|j)$/i.test(m[1]))
        return { domain: host, ats, company: m[1], method: 'careers-link', evidence: url };
    }
  }

  // 2. probe the APIs with the slug guessed from the domain
  for (const ats of Object.keys(ADAPTERS)) {
    const r = await fetchSource({ ats, company: slug });
    if (!r.error && Array.isArray(r.jobs) && r.jobs.length > 0)
      return { domain: host, ats, company: slug, method: 'slug-probe', jobs: r.jobs.length, evidence: r.url };
  }
  // 2.5 many career pages load their board with JavaScript. Rendering is fine
  // here: this tool runs once per company on our machine, never per check.
  if (BROWSER) {
    for (const url of [`https://${bare}/careers`, `https://careers.${bare}`, `https://${bare}/jobs`]) {
      const dom = await renderDom(url, 22000);
      if (dom.length < 2000) continue;
      for (const [re, ats] of PATTERNS) {
        const m = dom.match(re);
        if (m && m[1] && !/^(www|assets|static|cdn|j)$/i.test(m[1]))
          return { domain: host, ats, company: m[1], method: 'rendered', evidence: url };
      }
    }
  }

  // 3. last resort: some companies keep the board under a slug that differs
  // from the domain root - try the common variants
  const base = host.replace(/^www\./, '').split('.')[0];
  const variants = [...new Set([base, base.replace(/-/g, ''), base + 'hq', base + 'inc'])];
  for (const ats of ['greenhouse', 'lever', 'ashby', 'workable']) {
    for (const v of variants) {
      if (v === slug) continue;
      const r = await fetchSource({ ats, company: v });
      if (!r.error && Array.isArray(r.jobs) && r.jobs.length > 0)
        return { domain: host, ats, company: v, method: 'slug-variant', jobs: r.jobs.length, evidence: r.url };
    }
  }
  return { domain: host, ats: null, company: null, method: 'not-found' };
}

const SUPPORTED = new Set(['greenhouse', 'lever', 'ashby', 'teamtailor', 'smartrecruiters', 'workable']);

const args = process.argv.slice(2);
if (args.length) {
  const found = [];
  for (const d of args) {
    const r = await discover(d);
    found.push(r);
    console.log(r.ats
      ? `  + ${r.domain.padEnd(20)} ${r.ats.padEnd(16)} ${String(r.company).padEnd(20)} (${r.method})`
      : `  - ${r.domain.padEnd(20)} not found`);
  }
  const hits = found.filter(f => f.ats && SUPPORTED.has(f.ats));
  const later = found.filter(f => f.ats && !SUPPORTED.has(f.ats));
  console.log(`\n${hits.length}/${found.length} usable now`);
  if (later.length) console.log('found but not supported yet: ' + later.map(u => u.domain + ' (' + u.ats + ')').join(', '));
  console.log('\n--- ready-to-paste Actor input ---');
  console.log(JSON.stringify({ sources: hits.map(h => ({ ats: h.ats, company: h.company, label: h.domain })), deriveSignals: true }, null, 2));
}
