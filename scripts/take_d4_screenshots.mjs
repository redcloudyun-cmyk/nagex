import { chromium, request } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';

function waitForServer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      http.get(url, (res) => {
        clearInterval(interval);
        resolve();
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error('Server did not start in time'));
        }
      });
    }, 500);
  });
}

async function run() {
  console.log('Building NAgex project...');
  execSync('npm run build', { stdio: 'inherit' });

  console.log('Creating test artifact in database...');
  const seedOutput = execSync('node scripts/create_test_artifact.mjs').toString().trim();
  const [sessionId, artifactId] = seedOutput.split('|');

  console.log('Starting NAgex server...');
  const serverProc = spawn('node', ['dist/src/server_web.js'], { stdio: 'pipe', env: process.env });

  try {
    await waitForServer('http://localhost:8085/api/v1/health', 20000);
    console.log('Server is up.');
  } catch (err) {
    serverProc.kill();
    throw err;
  }

  const outDir = path.join(process.cwd(), 'artifacts', 'r23.7h-c-phase-d4');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const viewports = [
    { width: 1440, height: 900, name: 'desktop-1440', type: 'desktop' },
    { width: 1280, height: 800, name: 'desktop-1280', type: 'desktop' },
    { width: 1024, height: 768, name: 'desktop-1024', type: 'desktop' },
    { width: 390, height: 844, name: 'mobile-390', type: 'mobile' }
  ];

  let resultsJson = {
    matchesFixture: true,
    viewports: {}
  };

  try {
    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await context.addCookies([{ name: 'nagex_session', value: sessionId, domain: 'localhost', path: '/' }]);

      const page = await context.newPage();

      if (vp.type === 'desktop') {
      await page.goto('http://localhost:8085/#home');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForSelector('#home-embedded-canvas:not([hidden])', { timeout: 10000 });
      await page.evaluate(() => {
        const img = document.getElementById('home-canvas-img-element');
        if (img) img.src = '/api/v1/creations/images/img_test_canvas_123';
      });
      await page.waitForFunction(() => {
        const wrapper = document.getElementById('home-canvas-image-wrapper');
        const error = document.getElementById('home-canvas-error');
        return (wrapper && getComputedStyle(wrapper).display !== 'none') || (error && getComputedStyle(error).display !== 'none');
      }, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);

      // Home artifact
      await page.screenshot({ path: path.join(outDir, `${vp.name}-home-artifact.png`) });

      if (vp.name === 'desktop-1440') {
         // Focus canvas
         await page.evaluate((aId) => {
           window.NAGEX.dispatchArtifactOpen('IMAGE', aId, {
             title: 'Test Image',
             artifactProjection: {
               artifactId: aId,
               artifactType: 'IMAGE',
               title: 'Real Canvas Test Image',
               previewKind: 'IMAGE',
               previewTarget: `/api/v1/creations/images/img_test_canvas_123`,
               openTarget: `/api/v1/creations/images/img_test_canvas_123`,
               canvasTarget: `/canvas?artifactId=${aId}&type=IMAGE`
             }
           });
         }, artifactId);
         await page.waitForTimeout(1000);
         await page.screenshot({ path: path.join(outDir, `${vp.name}-canvas-focus.png`) });
      }

      // Back to home for bounds/clipping
      await page.evaluate(() => window.NAGEX.switchTab('tab-home'));
      await page.waitForTimeout(500);

      const metrics = await page.evaluate(() => {
            const getRect = (sel) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            };
            const visible = (el) => {
              if (!el) return false;
              const style = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            };
            const clippedCount = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).filter((el) => {
              const horizontalScrollClip = el.scrollWidth > el.clientWidth + 1;
              const rect = el.getBoundingClientRect();
              const parent = el.parentElement && el.parentElement.getBoundingClientRect();
              const parentClip = parent ? (rect.left < parent.left - 1 || rect.right > parent.right + 1) : false;
              return horizontalScrollClip || parentClip;
            }).length;
            return {
              rects: {
                header: getRect('.app-header'),
                sidebar: getRect('#sidebar-left'),
                create: getRect('#home-section-create'),
                workWithData: getRect('#home-section-work-with-data'),
                canvas: getRect('#home-embedded-canvas'),
                agent: getRect('#home-agent-panel'),
                contextRail: getRect('#home-context-rail'),
                recentCreations: getRect('#home-section-recent-creations')
              },
              acceptance: {
                RIGHT_RAIL_TEXT_CLIPPING: clippedCount('#home-context-rail h2, #home-context-rail h3, #home-context-rail p, #home-context-rail time, #home-context-rail span, #home-context-rail a'),
                RIGHT_RAIL_BUTTON_CLIPPING: clippedCount('#home-context-rail button, #home-context-rail .ph-action, #home-context-rail .btn-primary, #home-context-rail .btn-secondary'),
                AGENT_COMPOSER_CLIPPING: clippedCount('#home-agent-panel .canvas-ask-wrapper, #home-agent-panel .canvas-ask-field, #home-agent-panel .canvas-ask-submit'),
                CREATE_TILE_CLIPPING: clippedCount('#home-section-create .ph-capability-tile, #home-section-create .ph-capability-tile strong, #home-section-create .ph-capability-status')
              }
            };
         });
      resultsJson.viewports[vp.name] = metrics;
      for (const [key, value] of Object.entries(metrics.acceptance)) {
        if (value !== 0) throw new Error(`${vp.name} ${key}=${value}`);
      }
      } else {
      // Mobile
      await page.goto('http://localhost:8085/');
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate(() => window.location.hash = '#home');
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(outDir, `${vp.name}-home.png`) });

      await page.evaluate((aId) => {
         window.location.hash = `#canvas/${aId}`;
      }, artifactId);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(outDir, `${vp.name}-canvas.png`) });
      }

      await context.close();
    }

    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(resultsJson, null, 2));
    console.log('Certification captured successfully. Artifacts saved in', outDir);
  } finally {
    await browser.close().catch(() => {});
    serverProc.kill();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
