# P0-01 real-user journey harness (local, not part of the product)

- `audit_server.cjs`: runs the build in-process with isolated temp stores, creates two throwaway signed-in accounts, listens on 127.0.0.1:8191.
  Start: `NAGEX_GEMINI_MODEL=gemini-flash-lite-latest NAGEX_PROVIDER_PRIORITY=gemini node --require ./dist/tests/_setup.js scratch/p0-01-e2e/audit_server.cjs` (needs GEMINI_API_KEY; paths inside the scripts point at F:/nxprod - adjust).
- `e2e_journey2.cjs <cookie> p_report.txt p_revise.txt <outDir> <tag>`: Playwright UI journey: 3-page report -> DOCX download -> Revise -> download -> refresh -> Recent -> Open -> new browser context.
- Results (2026-10-15, real Gemini flash-lite): created in 11-17 s (3.8-3.9k characters), the DOCX opens in Microsoft Word as 3 pages (7 headings, Title/Heading styles), revision created via the revision endpoint, document persists across refresh and a new browser context, other users get 404.
- Known: with the non-preferred Gemini provider an invalid-JSON model answer is not retried (the router only retries validation on the preferred provider), so a revision can fail once with "All configured model providers failed" - retry works.
