import { fetchSource } from './src/adapters/index.js';
const T = [
  { ats:'greenhouse', company:'stripe' }, { ats:'lever', company:'spotify' },
  { ats:'ashby', company:'ramp' }, { ats:'teamtailor', company:'oneflow' },
  { ats:'smartrecruiters', company:'Visa' }, { ats:'personio', company:'pleo' }
];
for (const t of T) {
  const r = await fetchSource(t);
  const j = r.jobs || [];
  console.log(String(r.status||'ERR').padStart(4), (t.ats+'/'+t.company).padEnd(28),
    r.error ? r.error : `${j.length} jobs, ${r.ms}ms, etag:${r.etag?'yes':'no'}`);
  if (j[0]) console.log('       sample:', JSON.stringify(j[0]).slice(0,150));
}
