const fs = require('fs');
const [,, bf, af] = process.argv;
const B = JSON.parse(fs.readFileSync(bf, 'utf8')).results, A = JSON.parse(fs.readFileSync(af, 'utf8')).results;
const ids = [...new Set(B.map((r) => r.id))];
const desc = (rows) => { const r = rows[0]; const kinds = [...new Set(rows.map((x) => x.kind + (x.verdict ? '/' + x.verdict : '') + (x.reason ? ':' + x.reason.split(':').slice(0, 2).join(':') : '')))].join(' | '); return kinds; };
const avg = (rows, k) => Math.round(rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length);
console.log('| scenario | before | after | steps b/a | ms b/a |');
console.log('|---|---|---|---|---|');
for (const id of ids) {
  const b = B.filter((r) => r.id === id), a = A.filter((r) => r.id === id);
  console.log(`| ${id} ${b[0].name.slice(0, 52)} | ${desc(b)} | ${desc(a)} | ${avg(b, 'steps')}/${avg(a, 'steps')} | ${avg(b, 'ms')}/${avg(a, 'ms')} |`);
}
const tot = (rows, k) => rows.filter((r) => r[k]).length;
console.log('\nTOTAL runs:', B.length);
for (const k of ['falseSuccess', 'falseFailure', 'verifiedSuccess', 'claimWithoutEvidence']) console.log(k.padEnd(22), 'before', tot(B, k), 'after', tot(A, k));
const sum = (rows, id, k) => rows.filter((r) => r.id === id).reduce((s, r) => s + r[k], 0);
console.log('D06 steps spent per run: before', avg(B.filter((r) => r.id === 'D06'), 'steps'), 'after', avg(A.filter((r) => r.id === 'D06'), 'steps'));
console.log('orders D09/D10 (expected 3 each over 3 reps): before', sum(B, 'D09', 'orders'), sum(B, 'D10', 'orders'), 'after', sum(A, 'D09', 'orders'), sum(A, 'D10', 'orders'));
const ok = (rows) => rows.filter((r) => r.achieved === true && r.kind === 'COMPLETED');
console.log('mean ms of achievable tasks: before', avg(ok(B), 'ms'), 'after', avg(ok(A), 'ms'), '| mean steps', avg(ok(B), 'steps'), avg(ok(A), 'steps'));
