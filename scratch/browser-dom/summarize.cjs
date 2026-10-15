const fs = require('fs');
const [,, bf, af] = process.argv;
const B = JSON.parse(fs.readFileSync(bf, 'utf8')).results, A = JSON.parse(fs.readFileSync(af, 'utf8')).results;
const ids = [...new Set(B.map((r) => r.id))];
const avg = (rows, k) => Math.round(rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length);
console.log('| scenario | before | after | before errors | ms b/a | calls b/a |');
console.log('|---|---|---|---|---|---|');
let tb = 0, ta = 0;
for (const id of ids) {
  const b = B.filter((r) => r.id === id), a = A.filter((r) => r.id === id);
  const pb = b.filter((r) => r.ok).length, pa = a.filter((r) => r.ok).length; tb += pb; ta += pa;
  const errs = [...new Set(b.filter((r) => r.error).map((r) => r.error.split(':')[0]))].join(', ') || '-';
  console.log(`| ${id} ${b[0].name.slice(0, 58)} | ${pb}/${b.length} | ${pa}/${a.length} | ${errs} | ${avg(b, 'ms')}/${avg(a, 'ms')} | ${avg(b, 'toolCalls')}/${avg(a, 'toolCalls')} |`);
}
console.log(`| **TOTAL** | **${tb}/${B.length}** | **${ta}/${A.length}** | | | |`);
