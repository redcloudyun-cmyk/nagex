const fs = require('fs');
const [,, beforeFile, afterFile] = process.argv;
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).results;
const b = load(beforeFile), a = load(afterFile);
const ids = [...new Set(b.map((r) => r.id))].sort();
const agg = (rows) => ({ n: rows.length, pass: rows.filter((r) => r.ok).length, ms: Math.round(rows.reduce((x, r) => x + r.ms, 0) / rows.length), calls: +(rows.reduce((x, r) => x + r.toolCalls, 0) / rows.length).toFixed(1), errors: [...new Set(rows.filter((r) => r.error).map((r) => r.error.split(':')[0].replace(/^Error$/, 'PlaywrightError')))] });
const lines = [];
lines.push('| scenario | before pass | after pass | before ms | after ms | before calls | after calls | before errors |');
lines.push('|---|---|---|---|---|---|---|---|');
let tb = 0, ta = 0, nb = 0, na = 0;
for (const id of ids) {
  const rb = agg(b.filter((r) => r.id === id)), ra = agg(a.filter((r) => r.id === id));
  tb += rb.pass; nb += rb.n; ta += ra.pass; na += ra.n;
  const name = b.find((r) => r.id === id).name;
  lines.push(`| ${id} ${name.slice(0, 60)} | ${rb.pass}/${rb.n} | ${ra.pass}/${ra.n} | ${rb.ms} | ${ra.ms} | ${rb.calls} | ${ra.calls} | ${rb.errors.join(', ') || '-'} |`);
}
lines.push(`| **TOTAL** | **${tb}/${nb}** | **${ta}/${na}** | | | | | |`);
const fixture = (rows) => rows.filter((r) => !r.live);
const f = (rows) => { const x = agg(fixture(rows)); return `${x.pass}/${x.n} pass, mean ${x.ms} ms, ${x.calls} tool calls per scenario`; };
console.log(lines.join('\n'));
console.log('\nFIXTURE before:', f(b)); console.log('FIXTURE after :', f(a));
const okRows = (rows) => fixture(rows).filter((r) => r.ok);
console.log('Passing-only mean ms: before', agg(okRows(b)).ms, 'after', agg(okRows(a)).ms, '| calls before', agg(okRows(b)).calls, 'after', agg(okRows(a)).calls);
const common = ids.filter((id) => !b.find((r) => r.id === id).live && b.filter((r) => r.id === id).every((r) => r.ok) && a.filter((r) => r.id === id).every((r) => r.ok));
console.log('Scenarios passing in BOTH builds (like-for-like cost):', common.join(','), '| before ms/calls', agg(b.filter((r) => common.includes(r.id))).ms, agg(b.filter((r) => common.includes(r.id))).calls, '| after ms/calls', agg(a.filter((r) => common.includes(r.id))).ms, agg(a.filter((r) => common.includes(r.id))).calls);
