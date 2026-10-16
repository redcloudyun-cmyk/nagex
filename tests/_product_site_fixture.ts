// TEST-ONLY (not a test file): what a model would answer for "a responsive customer management website with customer records, search and a dashboard" - the plan, the design, the checks and the files.
// These are STAND-INS for model output, used by the local AI world so the production Product Builder can be driven end to end without any network or credential. A pass with them proves NAgex's own chain
// (gates, bindings, isolated build and test, preview, deployment and verification), never that a real model wrote anything.
import type { DesignSpec, ProductPlan, SiteCheck } from '../src/product-builder/product-builder.types.js';

export const SITE_REQUEST_EN = 'Build me a responsive customer management website with customer records, search and a dashboard, and put it online.';
export const SITE_REQUEST_KO = '고객 레코드, 검색, 대시보드가 있는 반응형 고객 관리 웹사이트를 만들어서 온라인에 올려줘.';

export function productPlan(korean: boolean): ProductPlan {
  return korean ? {
    summary: '고객 레코드, 검색, 대시보드를 갖춘 반응형 고객 관리 웹사이트',
    audience: '고객 정보를 간단히 관리하는 1인 사업자',
    pages: [{ id: 'customers', title: '고객 목록', purpose: '고객 레코드를 보고 이름으로 검색합니다' }, { id: 'dashboard', title: '대시보드', purpose: '고객 수와 최근 활동을 한눈에 봅니다' }],
    features: [{ id: 'records', title: '고객 레코드', detail: '이름, 이메일, 상태를 표로 보여주고 새 고객을 추가합니다' }, { id: 'search', title: '검색', detail: '이름으로 목록을 즉시 좁힙니다' }, { id: 'dashboard', title: '대시보드', detail: '전체 고객 수와 상태별 수를 보여줍니다' }],
    dataModel: [{ entity: '고객', fields: ['이름', '이메일', '상태'] }],
    nonGoals: ['로그인과 여러 사용자', '서버나 데이터베이스(데이터는 브라우저에만 저장됩니다)', '결제'],
    assumptions: ['샘플 고객 데이터로 시작합니다'],
    openQuestions: [],
  } : {
    summary: 'A responsive customer management website with customer records, search and a dashboard',
    audience: 'a one-person business that keeps its customers in one place',
    pages: [{ id: 'customers', title: 'Customers', purpose: 'Browse the customer records and search them by name' }, { id: 'dashboard', title: 'Dashboard', purpose: 'See totals and status counts at a glance' }],
    features: [{ id: 'records', title: 'Customer records', detail: 'A table of name, email and status, with a form to add a customer' }, { id: 'search', title: 'Search', detail: 'Narrow the list by name as you type' }, { id: 'dashboard', title: 'Dashboard', detail: 'Total customers and a count per status' }],
    dataModel: [{ entity: 'Customer', fields: ['name', 'email', 'status'] }],
    nonGoals: ['Sign-in and multiple users', 'A server or database (data stays in the browser)', 'Payments'],
    assumptions: ['It starts with sample customers'],
    openQuestions: [],
  };
}

export const PRODUCT_DESIGN: DesignSpec = {
  layout: 'A top bar with the name, a dashboard strip of summary cards, then a searchable customer table',
  typography: { heading: 'system-ui bold', body: 'system-ui regular', scale: '14 / 16 / 22 / 30' },
  colors: { primary: '#2563eb', background: '#f8fafc', text: '#0f172a', accent: '#16a34a' },
  components: ['summary cards', 'search box', 'customer table', 'add-customer form'],
  navigation: 'One page with two anchored sections: Dashboard and Customers',
  responsive: { breakpoints: ['390', '768', '1280'], notes: 'The summary cards wrap; the table scrolls inside its own container on narrow screens' },
  states: ['empty list', 'no search results'],
};

export const PRODUCT_CHECKS: SiteCheck[] = [
  { id: 'customer-table', description: 'The customer table is shown', kind: 'ELEMENT_PRESENT', selector: '#customer-table' },
  { id: 'dashboard', description: 'The dashboard is shown with the total number of customers', kind: 'TEXT_PRESENT', text: 'Total customers' },
  { id: 'search', description: 'Searching by name narrows the list', kind: 'SEARCH_FILTERS', inputSelector: '#search', query: 'han', expectText: 'Hanbit Trading', hideText: 'Daon Studio' },
];

export const PRODUCT_BUILD_STEPS = ['Write the page with a dashboard strip and a customer table', 'Add the search box and the add-customer form', 'Seed believable sample customers', 'Check the layout at phone, tablet and desktop widths'];

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Customer Hub</title>
<link rel="stylesheet" href="css/site.css">
</head>
<body>
<header class="bar"><h1>Customer Hub</h1><a href="#customers">Customers</a></header>
<main>
<section id="dashboard" aria-label="Dashboard">
<div class="card"><span>Total customers</span><strong id="stat-total">0</strong></div>
<div class="card"><span>Active</span><strong id="stat-active">0</strong></div>
<div class="card"><span>Prospects</span><strong id="stat-prospect">0</strong></div>
</section>
<section id="customers" aria-label="Customers">
<label for="search">Search customers</label>
<input id="search" type="search" placeholder="Search by name" autocomplete="off">
<div class="scroll"><table id="customer-table"><thead><tr><th>Name</th><th>Email</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div>
<p id="empty" hidden>No customers match your search.</p>
<form id="add" autocomplete="off"><h2>Add a customer</h2>
<label for="f-name">Name</label><input id="f-name" required>
<label for="f-email">Email</label><input id="f-email" type="email" required>
<label for="f-status">Status</label><select id="f-status"><option>Active</option><option>Prospect</option></select>
<button type="submit">Add</button></form>
</section>
</main>
<script src="js/app.js"></script>
</body>
</html>`;

const CSS = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a}
.bar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#2563eb;color:#fff}.bar h1{margin:0;font-size:1.2rem}.bar a{color:#fff}
main{max-width:960px;margin:0 auto;padding:16px}
#dashboard{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}.card{flex:1 1 140px;background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)}.card span{display:block;font-size:.85rem;color:#475569}.card strong{font-size:1.6rem}
label{display:block;margin:8px 0 4px;font-size:.9rem}input,select{width:100%;max-width:420px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font:inherit}
.scroll{overflow-x:auto;margin-top:12px;background:#fff;border-radius:10px}table{width:100%;border-collapse:collapse}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #e2e8f0}
button{margin-top:12px;padding:10px 16px;border:0;border-radius:6px;background:#16a34a;color:#fff;font:inherit;cursor:pointer}
#add{margin-top:24px;background:#fff;padding:12px;border-radius:10px;max-width:460px}#add h2{margin:0 0 8px;font-size:1.1rem}`;

const JS = `(function(){
var KEY='customer-hub-v1';
var seed=[{name:'Hanbit Trading',email:'hello@hanbit.example',status:'Active'},{name:'Daon Studio',email:'team@daon.example',status:'Prospect'},{name:'Miso Bakery',email:'order@miso.example',status:'Active'}];
var memory=null;
function load(){try{var raw=window.localStorage.getItem(KEY);if(raw){return JSON.parse(raw);}}catch(e){}return memory||seed.slice();}
function save(list){memory=list;try{window.localStorage.setItem(KEY,JSON.stringify(list));}catch(e){}}
var customers=load();
var rows=document.getElementById('rows'),search=document.getElementById('search'),empty=document.getElementById('empty');
function render(){
var q=search.value.trim().toLowerCase();
rows.textContent='';
var shown=0;
customers.forEach(function(c){
if(q&&c.name.toLowerCase().indexOf(q)<0)return;
shown+=1;
var tr=document.createElement('tr');
[c.name,c.email,c.status].forEach(function(v){var td=document.createElement('td');td.textContent=v;tr.appendChild(td);});
rows.appendChild(tr);
});
empty.hidden=shown!==0;
document.getElementById('stat-total').textContent=String(customers.length);
document.getElementById('stat-active').textContent=String(customers.filter(function(c){return c.status==='Active';}).length);
document.getElementById('stat-prospect').textContent=String(customers.filter(function(c){return c.status==='Prospect';}).length);
}
search.addEventListener('input',render);
document.getElementById('add').addEventListener('submit',function(e){
e.preventDefault();
var name=document.getElementById('f-name'),email=document.getElementById('f-email'),status=document.getElementById('f-status');
customers.push({name:name.value.trim(),email:email.value.trim(),status:status.value});
save(customers);
name.value='';email.value='';
render();
});
render();
})();`;

export function productSiteFiles(): Array<{ path: string; content: string }> {
  return [{ path: 'index.html', content: HTML }, { path: 'css/site.css', content: CSS }, { path: 'js/app.js', content: JS }];
}

/** the answer a model gives to the engine prompt */
export function productSiteAnswer(files = productSiteFiles()): string {
  return files.map((f) => `=== FILE: ${f.path} ===\n${f.content}\n=== END FILE ===`).join('\n');
}

/** a site that fails its own checks (the search does nothing): used to prove the repair loop */
export function brokenProductSiteAnswer(): string {
  return productSiteAnswer(productSiteFiles().map((f) => (f.path === 'js/app.js' ? { path: f.path, content: f.content.replace("search.addEventListener('input',render);", '/* search not wired */') } : f)));
}
