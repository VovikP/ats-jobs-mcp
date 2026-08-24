// Render a page with the locally installed Chrome and return the DOM.
// This lives ONLY in the discovery tool: it runs once per company on our own
// machine. The Actor itself must never touch a browser — that is what keeps
// a check at $0.00003 instead of $0.0004.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];

import { existsSync } from 'node:fs';
export const BROWSER = CANDIDATES.find(p => existsSync(p)) || null;

export async function renderDom(url, timeoutMs = 25000) {
  if (!BROWSER) return '';
  try {
    const { stdout } = await run(BROWSER, [
      '--headless', '--disable-gpu', '--no-sandbox', '--dump-dom',
      '--virtual-time-budget=9000', '--run-all-compositor-stages-before-draw',
      url
    ], { timeout: timeoutMs, maxBuffer: 40 * 1024 * 1024, windowsHide: true });
    return stdout || '';
  } catch (e) {
    return (e.stdout && e.stdout.length > 500) ? e.stdout : '';
  }
}
