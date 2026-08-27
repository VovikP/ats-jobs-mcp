#!/usr/bin/env node
// ats-jobs-mcp — job data and hiring change detection for AI agents.
//
// Talks to source ATS APIs directly. No account, no key, no browser.
// Snapshots live in a local file, so change detection works offline
// between runs on the caller's own machine.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { fetchSource } from './lib/adapters.js';

// Only systems verified to answer for third-party callers. Personio has an
// adapter but blocks non-browser clients with 429, so it is not advertised.
const SUPPORTED = ['greenhouse', 'lever', 'ashby', 'workable', 'teamtailor', 'smartrecruiters'];
import { resolveDomain } from './lib/resolve.js';
import { diffJobs, hashOf, fnOf } from './lib/diff.js';

const STATE_FILE = process.env.ATS_MCP_STATE || join(homedir(), '.ats-jobs-mcp', 'state.json');

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return { domains: {}, snapshots: {} }; }
}
async function saveState(s) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(s));
}

// Resolve once, remember forever: a company does not change its ATS twice a week.
async function resolve(state, domain) {
  const host = String(domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!state.domains[host]) {
    const r = await resolveDomain(host);
    state.domains[host] = r || { ats: null };
  }
  return { host, ...state.domains[host] };
}

const TOOLS = [
  {
    name: 'find_job_board',
    description:
      'Given a company website, find which applicant tracking system it uses and the board token needed to read its jobs. ' +
      'Supports Greenhouse, Lever, Ashby, Workable, Teamtailor and SmartRecruiters. Use this when you know a company by its domain but not by its job board.',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'Company website, e.g. "stripe.com"' } },
      required: ['domain']
    }
  },
  {
    name: 'list_jobs',
    description:
      'List all currently open roles at a company. Accepts a plain company website — the job board is detected automatically. ' +
      'Returns title, location, department, employment type and a direct link for every open position.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Company website, e.g. "stripe.com"' },
        limit: { type: 'number', description: 'Maximum roles to return. Default 100.' }
      },
      required: ['domain']
    }
  },
  {
    name: 'detect_changes',
    description:
      'Report what changed in a company hiring since the last time this tool looked at it: roles opened, roles closed, titles or locations changed, compensation changed. ' +
      'The first call for a company records a baseline and reports no changes; every call after that returns only the difference. ' +
      'Use this to monitor competitors, track expansion, or detect hiring freezes.',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'Company website, e.g. "stripe.com"' } },
      required: ['domain']
    }
  },
  {
    name: 'hiring_summary',
    description:
      'Summarise what a company is hiring for right now: how many open roles, which functions they fall into (engineering, sales, AI/ML, security, data...), and where they are located. ' +
      'Useful for answering "what is this company building" or "are they expanding" without reading every posting.',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'Company website, e.g. "stripe.com"' } },
      required: ['domain']
    }
  }
];

const server = new Server({ name: 'ats-jobs-mcp', version: '0.1.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });

// An agent that forgot the argument must be told exactly that. Answering
// "this company is not supported" would send the model looking for another
// company instead of fixing its own call — and burn a dozen requests doing it.
const badDomain = (d) => {
  if (d === undefined || d === null || String(d).trim() === '')
    return 'Missing required argument "domain". Pass a company website, e.g. "stripe.com".';
  const host = String(d).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').trim();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host))
    return `"${d}" is not a domain name. Pass a company website, e.g. "stripe.com".`;
  return null;
};

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const invalid = badDomain(args.domain);
  if (invalid) return text({ error: invalid, tool: name });
  const state = await loadState();

  const unresolved = (host) => text({
    domain: host, found: false,
    reason: 'This company is not on a supported ATS, or its careers page renders jobs with JavaScript.',
    supported: SUPPORTED
  });

  if (name === 'find_job_board') {
    const r = await resolve(state, args.domain);
    await saveState(state);
    return r.ats ? text({ domain: r.host, ats: r.ats, board_token: r.company, detected_via: r.method })
                 : unresolved(r.host);
  }

  if (name === 'list_jobs') {
    const r = await resolve(state, args.domain);
    if (!r.ats) { await saveState(state); return unresolved(r.host); }
    const res = await fetchSource({ ats: r.ats, company: r.company });
    await saveState(state);
    if (res.error) return text({ domain: r.host, error: res.error });
    const jobs = (res.jobs || []).slice(0, args.limit || 100);
    return text({ domain: r.host, ats: r.ats, open_roles: jobs.length, source_url: res.url, jobs });
  }

  if (name === 'detect_changes') {
    const r = await resolve(state, args.domain);
    if (!r.ats) { await saveState(state); return unresolved(r.host); }
    const res = await fetchSource({ ats: r.ats, company: r.company });
    if (res.error) { await saveState(state); return text({ domain: r.host, error: res.error }); }

    const jobs = res.jobs || [];
    const key = `${r.ats}:${r.company}`;
    const prev = state.snapshots[key];
    const snapshot = Object.fromEntries(jobs.map(j => [j.source_job_id, {
      h: hashOf(j), title: j.title, location: j.location, department: j.department,
      employment_type: j.employment_type, compensation: j.compensation, url: j.url
    }]));
    state.snapshots[key] = snapshot;
    await saveState(state);

    if (!prev) return text({
      domain: r.host, baseline: true, open_roles: jobs.length,
      note: 'Baseline recorded. Call this tool again later to see what changed.'
    });

    const events = diffJobs(prev, jobs, { truncated: false });
    return text({
      domain: r.host, baseline: false, open_roles: jobs.length,
      changes: events.length,
      events: events.map(e => ({ type: e.type, title: e.job?.title, url: e.job?.url,
        changed_fields: e.changed_fields, previous: e.prev }))
    });
  }

  if (name === 'hiring_summary') {
    const r = await resolve(state, args.domain);
    if (!r.ats) { await saveState(state); return unresolved(r.host); }
    const res = await fetchSource({ ats: r.ats, company: r.company });
    await saveState(state);
    if (res.error) return text({ domain: r.host, error: res.error });
    const jobs = res.jobs || [];
    const by = (fn) => jobs.reduce((acc, j) => { const k = fn(j) || 'unspecified'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    return text({
      domain: r.host, ats: r.ats, open_roles: jobs.length,
      by_function: by(fnOf),
      by_location: by(j => j.location),
      by_department: by(j => j.department)
    });
  }

  return text({ error: `Unknown tool: ${name}` });
});

await server.connect(new StdioServerTransport());
