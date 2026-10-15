# NAgex D-09 Track A — UI hand-off for the approval-gated "save to my Vault" (integrator-owned)

**Status:** HANDOFF ONLY. Nothing here is applied on the Track A branch: `public/**` is outside Track A's write allowlist, and neither agent may touch Voice WIP or the Main UI. This is a PROTOTYPE patch the integrator may apply serially, after Track A and Track B have landed.
**Prototype base:** `5c90530` (PR #14 + the D-9 implementation order). It touches exactly three files: `public/main-surface.js`, `public/i18n.js`, `public/main-surface-rearchitecture.css`. The Voice WIP conflict on `public/main-surface.js` (recorded in the overnight report) applies to this patch as well.

## What the screen must do (the server side is complete)

1. When One Input routes a request whose `decision.reasonCodes` contains `VAULT_SAVE` (`POST /api/v1/workspace/route-input`), call `POST /api/v1/ambient/intent` with `{ prompt, requestMetadata, saveContext }`. `saveContext` is the whole text (at most 20 001 characters) of the answer currently on screen; the server uses it only when the request names no text of its own.
2. Handle `status: 'NEEDS_DETAIL'` (nothing to save, or too long): show `message` as a plain question. There is no plan and no approval.
3. For `status: 'PLAN_PREVIEW'` whose first step has `tool: 'vault.save_note'`: render the draft **before** anything is requested (title, destination, source label, the whole text via `textContent`), then the existing "Request approval to run" → `POST /api/v1/tasks/from-reviewed-plan` → the existing inline Approve / Reject.
4. When the run ends, a step with `result.outcome === 'SAVED_TO_VAULT'` **and** `result.verification.status === 'VERIFIED'` is shown as saved (never as "tool responded"), with an Open action for `result.vaultItemId`. `errorCode` `VAULT_SAVE_FAILED` / `VAULT_ITEM_NOT_VERIFIED` is shown as NOT saved (a failed run stores no `result`; only the code is reliable).
5. Activity titles `Saved to Vault: …` / `Could not save to Vault: …` are localized by two `APP_TEXT_PATTERNS` entries.

## What was verified for the prototype, and what was not

- Desktop 1440, EN and KR, real Chromium, production server: the whole chain passed (answer on screen → draft shown → request → Approve → saved and read back → Open shows the text → a brand-new browser lists it → Activity records the title). Decline, ask-again, double click, a Vault that cannot write and another person were exercised too.
- **Not working at phone widths (430 / 390 / 360):** the prototype's own test failed at its last step because the Vault list (`#vault-recent-list`) is hidden when the Vault tab is opened by hash at those widths. That is the Vault screen's mobile navigation, not this change, and the integrator must investigate it before any mobile claim. The 44 px target checks written for the new Open / request buttons were never reached on mobile.
- No screenshots are committed (UI is not part of the Track A branch).

## Prototype patch

Apply with `git apply` onto a tree whose `public/` files are those of `5c90530`; expect conflicts if Voice WIP is merged first.

````diff
diff --git a/public/i18n.js b/public/i18n.js
index c748fb9..0829669 100644
--- a/public/i18n.js
+++ b/public/i18n.js
@@ -4674,6 +4674,23 @@
     'mainRun.waitingNote': 'It will only happen if you approve below.',
     'mainRun.toolResponded': 'Tool responded',
     'mainRun.respondedNote': 'The tool answered. NAgex has not independently checked the result in the real world.',
+    'mainVault.draftLabel': 'Draft to save',
+    'mainVault.draftHeading': 'Exactly this is saved - only after you approve',
+    'mainVault.fieldTitle': 'Title',
+    'mainVault.fieldWhere': 'Saved to',
+    'mainVault.fieldSource': 'Text from',
+    'mainVault.destination': 'My Vault',
+    'mainVault.sourceUser': 'Your message',
+    'mainVault.sourceAnswer': 'The previous answer, unedited',
+    'mainVault.contentLabel': 'Text to be saved',
+    'mainVault.saved': 'Saved to your Vault',
+    'mainVault.savedNote': 'Saved, and read back from your Vault: "{title}".',
+    'mainVault.open': 'Open in Vault',
+    'mainVault.notSaved': 'Not saved',
+    'mainVault.failedNote': 'The Vault could not store this, so nothing was saved. The approval was used - ask again to get a fresh one.',
+    'mainVault.nothingSaved': 'Nothing was saved',
+    'mainPattern.vault_saved': 'Saved to Vault: {0}',
+    'mainPattern.vault_save_failed': 'Could not save to Vault: {0}',
     'mainRun.declined': 'Not run - you declined',
     'mainRun.declinedNote': 'You declined, so nothing was done.',
     'mainRun.expired': 'Not run - the approval expired',
@@ -4698,6 +4715,23 @@
     'mainRun.waitingNote': '아래에서 승인해야만 실행돼요.',
     'mainRun.toolResponded': '도구가 응답했어요',
     'mainRun.respondedNote': '도구가 응답했어요. 실제 결과는 NAgex가 따로 확인하지 않았어요.',
+    'mainVault.draftLabel': '저장할 초안',
+    'mainVault.draftHeading': '승인하신 뒤에만, 아래 내용이 그대로 저장돼요',
+    'mainVault.fieldTitle': '제목',
+    'mainVault.fieldWhere': '저장 위치',
+    'mainVault.fieldSource': '내용의 출처',
+    'mainVault.destination': '내 보관함',
+    'mainVault.sourceUser': '요청에 적어 주신 내용',
+    'mainVault.sourceAnswer': '바로 앞의 답변 (수정 없음)',
+    'mainVault.contentLabel': '저장될 내용',
+    'mainVault.saved': '보관함에 저장했어요',
+    'mainVault.savedNote': '보관함에 저장하고 다시 읽어 확인했어요: "{title}"',
+    'mainVault.open': '보관함에서 열기',
+    'mainVault.notSaved': '저장하지 못했어요',
+    'mainVault.failedNote': '보관함에 저장하지 못해서 아무것도 저장되지 않았어요. 승인은 이미 사용되었으니, 다시 요청해 주세요.',
+    'mainVault.nothingSaved': '아무것도 저장하지 않았어요',
+    'mainPattern.vault_saved': '보관함에 저장됨: {0}',
+    'mainPattern.vault_save_failed': '보관함에 저장하지 못함: {0}',
     'mainRun.declined': '실행하지 않음 - 거절하셨어요',
     'mainRun.declinedNote': '거절하셨기 때문에 아무것도 하지 않았어요.',
     'mainRun.expired': '실행하지 않음 - 승인이 만료됐어요',
diff --git a/public/main-surface-rearchitecture.css b/public/main-surface-rearchitecture.css
index abbb13b..93f6003 100644
--- a/public/main-surface-rearchitecture.css
+++ b/public/main-surface-rearchitecture.css
@@ -1613,3 +1613,65 @@
   color: var(--nagex-ink-2);
   font-size: var(--nagex-fs-control);
 }
+
+/* D-9: the exact text that would be saved to the person's Vault, shown before anything is requested or stored */
+.main-vault-draft {
+  margin: 10px 0;
+  padding: 10px 12px;
+  border: 1px solid var(--nagex-line);
+  border-radius: var(--nagex-r-control);
+  background: #f8fbff;
+  font-size: var(--nagex-fs-control);
+}
+
+.main-vault-draft dl {
+  display: grid;
+  grid-template-columns: max-content minmax(0, 1fr);
+  gap: 4px 12px;
+  margin: 8px 0;
+}
+
+.main-vault-draft dt {
+  color: var(--nagex-ink-3);
+}
+
+.main-vault-draft dd {
+  margin: 0;
+  overflow-wrap: anywhere;
+}
+
+.main-vault-draft-text,
+.main-run-proposal dd.main-vault-content {
+  max-height: 220px;
+  overflow: auto;
+  padding: 8px 10px;
+  border: 1px solid var(--nagex-line);
+  border-radius: var(--nagex-r-control);
+  background: #ffffff;
+  white-space: pre-wrap;
+  overflow-wrap: anywhere;
+}
+
+.main-vault-draft-text:focus-visible {
+  outline: 2px solid var(--nagex-accent, #2563eb);
+  outline-offset: 2px;
+}
+
+.main-run-block[data-run-state="SAVED_TO_VAULT"] .main-run-state {
+  color: #0b6b3a;
+}
+
+.main-run-block[data-run-state="VAULT_NOT_SAVED"] .main-run-state {
+  color: #a11d1d;
+}
+
+.main-run-block .main-run-open[hidden] {
+  display: none !important;
+}
+
+@media (max-width: 860px) {
+  .main-run-block .main-run-open {
+    min-width: 44px;
+    min-height: 44px;
+  }
+}
diff --git a/public/main-surface.js b/public/main-surface.js
index d235276..22131f9 100644
--- a/public/main-surface.js
+++ b/public/main-surface.js
@@ -19,6 +19,7 @@
     mode: 'AUTO',
     shortcutsOpen: false,
     lastContext: '',
+    lastAnswerFull: '',
     web: true,
     personalContext: false,
     planPreview: true,
@@ -515,7 +516,7 @@
     if (!block) {
       block = document.createElement('div');
       block.className = 'main-run-block';
-      block.innerHTML = '<div class="main-run-head"><strong class="main-run-state"></strong><button type="button" class="main-tool-btn main-run-cancel" hidden></button></div><div class="main-run-proposal" hidden></div><ol class="main-run-steps"></ol><p class="main-run-note"></p>';
+      block.innerHTML = '<div class="main-run-head"><strong class="main-run-state"></strong><button type="button" class="main-tool-btn main-run-open" hidden></button><button type="button" class="main-tool-btn main-run-cancel" hidden></button></div><div class="main-run-proposal" hidden></div><ol class="main-run-steps"></ol><p class="main-run-note"></p>';
       const anchor = turn.el.querySelector('.main-inline-approvals');
       (anchor && anchor.parentNode ? anchor.parentNode : turn.el).insertBefore(block, anchor || null);
     }
@@ -534,8 +535,14 @@
     const responded = status === 'SUCCEEDED' && result.kind === 'STEP_EXECUTION';
     const declined = status === 'FAILED' && run && run.errorCode === 'APPROVAL_REJECTED';
     const expired = status === 'FAILED' && run && run.errorCode === 'APPROVAL_EXPIRED';
-    block.dataset.runState = planOnly ? 'PLAN_ONLY' : responded ? 'TOOL_RESPONDED' : declined ? 'DECLINED' : expired ? 'EXPIRED' : status;
-    block.querySelector('.main-run-state').textContent = planOnly ? bt('mainRoute.planOnlyState', 'Plan reviewed')
+    // D-9: a Vault save that was read back from the person's own Vault is reported as saved (VERIFIED); a failed one as not saved - never as a tool response
+    const executedSteps = Array.isArray(result.steps) ? result.steps : Array.isArray(result.completedSteps) ? result.completedSteps : [];
+    const savedStep = status === 'SUCCEEDED' ? executedSteps.find((s) => s && s.result && s.result.outcome === 'SAVED_TO_VAULT' && s.result.verification && s.result.verification.status === 'VERIFIED') : null;
+    const vaultFailed = status === 'FAILED' && run && /^VAULT_/.test(String(run.errorCode || ''));
+    block.dataset.runState = savedStep ? 'SAVED_TO_VAULT' : vaultFailed ? 'VAULT_NOT_SAVED' : planOnly ? 'PLAN_ONLY' : responded ? 'TOOL_RESPONDED' : declined ? 'DECLINED' : expired ? 'EXPIRED' : status;
+    block.querySelector('.main-run-state').textContent = savedStep ? bt('mainVault.saved', 'Saved to your Vault')
+      : vaultFailed ? bt('mainVault.notSaved', 'Not saved')
+      : planOnly ? bt('mainRoute.planOnlyState', 'Plan reviewed')
       : responded ? bt('mainRun.toolResponded', 'Tool responded')
       : declined ? bt('mainRun.declined', 'Not run - you declined')
       : expired ? bt('mainRun.expired', 'Not run - the approval expired')
@@ -554,6 +561,8 @@
     let text = note || '';
     if (!text && declined) text = bt('mainRun.declinedNote', 'You declined, so nothing was done.');
     if (!text && expired) text = bt('mainRun.expiredNote', 'The approval expired before it was granted, so nothing was done. Ask again to get a fresh one.');
+    if (!text && savedStep) text = bt('mainVault.savedNote', 'Saved, and read back from your Vault: "{title}".').replace('{title}', String(savedStep.result.title || ''));
+    if (!text && vaultFailed) text = bt('mainVault.failedNote', 'The Vault could not store this, so nothing was saved. The approval was used - ask again to get a fresh one.');
     if (!text && responded) text = bt('mainRun.respondedNote', 'The tool answered. NAgex has not independently checked the result in the real world.');
     if (!text && status === 'WAITING_APPROVAL' && block.dataset.flow === 'reviewed') text = bt('mainRun.waitingNote', 'It will only happen if you approve below.');
     if (!text && status === 'FAILED') text = result && typeof result.reason === 'string' && result.reason ? mt("NAgex couldn't complete this plan.") + ' ' + String(result.reason).slice(0, 200) : mt("NAgex couldn't complete this plan.");
@@ -562,6 +571,14 @@
     if (!text && status === 'CANCELLED') text = mt('The plan was cancelled.');
     noteEl.textContent = text;
     noteEl.hidden = !text;
+    const openBtn = block.querySelector('.main-run-open');
+    if (openBtn) {
+      openBtn.hidden = !savedStep;
+      if (savedStep) {
+        openBtn.textContent = bt('mainVault.open', 'Open in Vault');
+        openBtn.onclick = () => openVaultItem(savedStep.result.vaultItemId);
+      }
+    }
     const cancel = block.querySelector('.main-run-cancel');
     const live = status === 'RUNNING' || status === 'WAITING_APPROVAL';
     cancel.hidden = !live;
@@ -605,11 +622,20 @@
     box.appendChild(title);
     if (args.length > 0) {
       const list = document.createElement('dl');
+      const vaultSave = proposal.capabilityId === 'vault.save_note';
       args.forEach((a) => {
         const dt = document.createElement('dt');
-        dt.textContent = String(a.name || '');
         const dd = document.createElement('dd');
-        dd.textContent = String(a.value == null ? '' : a.value);
+        if (vaultSave) {
+          // a Vault draft is approved in the person's own words: field names and the source in plain language, the text whole
+          const names = { title: bt('mainVault.fieldTitle', 'Title'), content: bt('mainVault.contentLabel', 'Text to be saved'), source: bt('mainVault.fieldSource', 'Text from') };
+          dt.textContent = names[a.name] || String(a.name || '');
+          dd.textContent = a.name === 'source' ? (a.value === 'USER_MESSAGE' ? bt('mainVault.sourceUser', 'Your message') : bt('mainVault.sourceAnswer', 'The previous answer, unedited')) : String(a.value == null ? '' : a.value);
+          if (a.name === 'content') dd.className = 'main-vault-content';
+        } else {
+          dt.textContent = String(a.name || '');
+          dd.textContent = String(a.value == null ? '' : a.value);
+        }
         list.appendChild(dt);
         list.appendChild(dd);
       });
@@ -618,6 +644,56 @@
     box.hidden = false;
   }
 
+  // D-9: the exact text that would be saved to the person's Vault, shown BEFORE anything is requested or stored (textContent only - never markup)
+  function renderVaultDraft(turn, plan, draftSource) {
+    if (!turn || !turn.el) return;
+    const step = plan && Array.isArray(plan.steps) ? plan.steps[0] : null;
+    const p = step && step.tool === 'vault.save_note' && step.parameters && typeof step.parameters.content === 'string' ? step.parameters : null;
+    let box = turn.el.querySelector('.main-vault-draft');
+    if (!p) { if (box) box.remove(); return; }
+    if (!box) {
+      box = document.createElement('section');
+      box.className = 'main-vault-draft';
+      const summary = turn.el.querySelector('.main-work-summary');
+      if (summary && summary.parentNode) summary.parentNode.insertBefore(box, summary.nextSibling);
+      else turn.el.appendChild(box);
+    }
+    box.textContent = '';
+    box.setAttribute('role', 'group');
+    box.setAttribute('aria-label', bt('mainVault.draftLabel', 'Draft to save'));
+    const heading = document.createElement('strong');
+    heading.textContent = bt('mainVault.draftHeading', 'Exactly this is saved - only after you approve');
+    box.appendChild(heading);
+    const facts = document.createElement('dl');
+    [[bt('mainVault.fieldTitle', 'Title'), String(p.title || '')], [bt('mainVault.fieldWhere', 'Saved to'), bt('mainVault.destination', 'My Vault')], [bt('mainVault.fieldSource', 'Text from'), p.source === 'USER_MESSAGE' ? bt('mainVault.sourceUser', 'Your message') : bt('mainVault.sourceAnswer', 'The previous answer, unedited')]].forEach((row) => {
+      const dt = document.createElement('dt');
+      dt.textContent = row[0];
+      const dd = document.createElement('dd');
+      dd.textContent = row[1];
+      facts.appendChild(dt);
+      facts.appendChild(dd);
+    });
+    box.appendChild(facts);
+    const body = document.createElement('div');
+    body.className = 'main-vault-draft-text';
+    body.setAttribute('tabindex', '0');
+    body.setAttribute('role', 'region');
+    body.setAttribute('aria-label', bt('mainVault.contentLabel', 'Text to be saved'));
+    body.textContent = p.content;
+    box.appendChild(body);
+  }
+
+  // Opens the Vault screen and then the saved item itself (its own preview), so "saved" can be checked by looking at it
+  async function openVaultItem(vaultItemId) {
+    if (!vaultItemId) return;
+    window.location.hash = '#vault';
+    for (let i = 0; i < 24; i += 1) {
+      await new Promise((resolve) => setTimeout(resolve, 250));
+      if (document.querySelector('#vault-recent-list [onclick*="' + String(vaultItemId).replace(/[^A-Za-z0-9_-]/g, '') + '"]')) break;
+    }
+    if (window.NAGEX && typeof window.NAGEX.previewVaultItem === 'function') window.NAGEX.previewVaultItem(vaultItemId);
+  }
+
   function setPlanNote(turn, text) {
     if (!turn || !turn.el) return;
     let note = turn.el.querySelector('.main-plan-note');
@@ -976,6 +1052,14 @@
     renderInlineActions([{ id: 'edit', label: bt('mainRoute.editRequest', 'Edit request'), action: () => putBackInComposer(prompt) }]);
   }
 
+  // The answer on screen is remembered twice: a short copy that travels as context for "make slides from this", and the whole text (bounded) that a "save that to my Vault" request may use.
+  // The whole text is only ever sent when the person asks to save, and it is shown in full, as the draft, before anything is requested or stored.
+  function rememberAnswer(text) {
+    const full = String(text == null ? '' : text);
+    state.lastContext = full.slice(0, 6000);
+    state.lastAnswerFull = full.slice(0, 20001);
+  }
+
   // Only the first N characters of a previous answer ever travel as context for "make slides from this".
   function withContext(prompt) {
     const nl = String.fromCharCode(10);
@@ -1038,7 +1122,7 @@
       ]);
       return;
     }
-    state.lastContext = String(research.answer).slice(0, 6000);
+    rememberAnswer(research.answer);
     const sourceCount = Array.isArray(research.sources) ? research.sources.length : 0;
     const lead = [{ state: 'done', label: 'Sources checked', detail: String(sourceCount) }];
     if (target === 'PRESENTATION') await createPresentation(prompt, metadata, { apiPrompt: researchReportPrompt(prompt, research, 'slides'), leadSteps: lead });
@@ -1081,7 +1165,7 @@
       return;
     }
     const answer = (result.data && result.data.message) || result.message || '';
-    if (answer) state.lastContext = String(answer).slice(0, 6000);
+    if (answer) rememberAnswer(answer);
     showThread(prompt, 'Answered', 'NAgex answered inline', answer || 'NAgex returned an empty answer.', [
       { state: 'done', label: 'Intent classified', detail: routeLabel(routingDecisionOf(route, metadata)) },
       { state: 'done', label: 'Answer prepared', detail: (result.data && result.data.messageId) || result.requestId || '' },
@@ -1270,7 +1354,7 @@
       .map((s, i) => '- [' + (i + 1) + '] [' + String(s.title || s.sourceName || s.url).replace(/[\[\]]/g, '') + '](' + String(s.url).replace(/\s/g, '') + ')');
     const answerText = result.answer || 'Research completed.';
     const markdown = sourceList.length ? answerText + nl + nl + '**' + bt('mainRoute.sources', 'Sources') + '**' + nl + sourceList.join(nl) : answerText;
-    if (result.answer) state.lastContext = String(result.answer).slice(0, 6000);
+    if (result.answer) rememberAnswer(result.answer);
     showThread(prompt, 'Completed', 'Research result', markdown, [
       { state: 'done', label: 'Request captured', detail: 'Research' },
       { state: 'done', label: 'Sources checked', detail: Array.isArray(result.sources) ? String(result.sources.length) : '' },
@@ -1304,11 +1388,22 @@
   }
 
   async function runPlan(prompt, metadata, route) {
+    // "save that to my Vault": the answer on screen goes along ONLY for that request; the server uses it only when the request names no text of its own
+    const savesToVault = ((routingDecisionOf(route, metadata).reasonCodes) || []).indexOf('VAULT_SAVE') >= 0;
     const result = await api('/api/v1/ambient/intent', {
       method: 'POST',
-      body: JSON.stringify({ prompt, requestMetadata: metadata }),
+      body: JSON.stringify(savesToVault && state.lastAnswerFull ? { prompt, requestMetadata: metadata, saveContext: state.lastAnswerFull } : { prompt, requestMetadata: metadata }),
       timeoutMs: 120000,
     });
+    // nothing (or nothing storable) to save: a plain question or reason, no plan, no approval
+    if (result && !result.error && result.status === 'NEEDS_DETAIL' && typeof result.message === 'string') {
+      showThread(prompt, 'Ready', bt('mainRoute.clarifyTitle', 'One quick question'), result.message, [
+        { state: 'done', label: 'Request captured', detail: '' },
+        { state: 'running', label: bt('mainVault.nothingSaved', 'Nothing was saved'), detail: '' },
+      ]);
+      renderInlineActions([{ id: 'edit', label: bt('mainRoute.editRequest', 'Edit request'), action: () => putBackInComposer(prompt) }]);
+      return;
+    }
     // Advice only: the person asked for advice and nothing to be done. It is shown as an answer - no plan, no steps, no Run button, nothing to approve.
     if (result && !result.error && !result.plan && result.status === 'ADVISORY_RESPONSE' && result.executable === false && result.advice && typeof result.advice.summary === 'string') {
       const nl = String.fromCharCode(10);
@@ -1317,7 +1412,7 @@
         .concat(suggestions.length ? ['', '**' + mt('Suggested next moves') + '**'].concat(suggestions.map((s) => '- ' + s)) : [])
         .concat(['', '_' + mt('No actions were taken. This is advice only.') + '_'])
         .join(nl);
-      state.lastContext = String(result.advice.summary + nl + suggestions.join(nl)).slice(0, 6000);
+      rememberAnswer(result.advice.summary + nl + suggestions.join(nl));
       showThread(prompt, 'Answered', 'Advice', markdown, []);
       renderInlineActions([{ id: 'follow', label: 'Ask follow-up', action: () => focusComposer('') }]);
       return;
@@ -1339,6 +1434,7 @@
     showThread(prompt, 'Plan ready', result.plan.summary || 'NAgex prepared a plan.', 'Review the plan inline. Required approvals remain mandatory and cannot be bypassed here.', steps);
     // a plan Home cannot take to approval is a preview, and says why (a separate line: the summary above is a fixed, translated sentence)
     setPlanNote(state.activeTurn, runnable ? '' : bt('mainRun.previewOnly', 'This is a preview only:') + ' ' + runnableReasonText(result.runnable && result.runnable.reasons));
+    renderVaultDraft(state.activeTurn, result.plan, result.draftSource);
     renderInlineActions([
       // Request approval: sends exactly this reviewed plan to the existing approval flow. Nothing runs until the person approves.
       ...(runnable ? [{ id: 'run-plan', label: bt('mainRun.requestApproval', 'Request approval to run'), action: ((turn) => () => startPlanRun(turn, prompt, result.plan, result.planSeal))(state.activeTurn) }] : []),
@@ -1828,6 +1924,8 @@
     [/^Task Blocked: (.+)$/, 'mainPattern.task_blocked'],
     [/^Task Completed: (.+)$/, 'mainPattern.task_completed'],
     [/^Task Failed: (.+)$/, 'mainPattern.task_failed'],
+    [/^Saved to Vault: (.+)$/, 'mainPattern.vault_saved'],
+    [/^Could not save to Vault: (.+)$/, 'mainPattern.vault_save_failed'],
     [/^Condition Met: (.+)$/, 'mainPattern.condition_met'],
     [/^"(.+)" needs your attention$/, 'mainPattern.needs_attention'],
     [/^Action "(.+)" was rejected by user\.$/, 'mainPattern.action_rejected'],
@@ -1866,6 +1964,7 @@
     update_event: 'Update calendar event',
     cancel_event: 'Cancel calendar event',
     respond_to_event: 'Respond to calendar event',
+    save_note: 'Save to Vault',
   };
 
   function friendlyToolName(id) {

````
