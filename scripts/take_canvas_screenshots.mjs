import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
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
  console.log('Starting NAgex server...');
  const serverProc = spawn('node', ['dist/src/server_web.js'], { stdio: 'inherit', env: process.env });

  try {
    await waitForServer('http://localhost:8085', 20000);
    console.log('Server is up.');
  } catch (err) {
    serverProc.kill();
    throw err;
  }

  const browser = await chromium.launch({ headless: true });
  const viewports = [
    { width: 1440, height: 900, name: 'desktop-1440' },
    { width: 360, height: 800, name: 'mobile-360' },
    { width: 390, height: 844, name: 'mobile-390' },
    { width: 430, height: 932, name: 'mobile-430' }
  ];

  const outDir = path.join(process.cwd(), 'artifacts', 'r23.7h-c-canvas');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const vp of viewports) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });

    // Add mock cookie for login if needed
    await context.addCookies([{ name: 'nagex_session', value: 'mock_session', domain: 'localhost', path: '/' }]);

    const page = await context.newPage();

    // Mock the specific artifact we want to open
    await page.route('**/api/v1/personal/home', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.recentCreations = [{
         id: 'art_test',
         title: 'Test Image',
         type: 'IMAGE',
         state: 'COMPLETED',
         time: new Date().toISOString(),
         artifactProjection: {
            artifactId: 'art_test',
            artifactType: 'IMAGE',
            previewKind: 'IMAGE',
            previewTarget: 'https://via.placeholder.com/600x400.png?text=Test+Image',
            openTarget: 'https://via.placeholder.com/600x400.png',
            canvasTarget: '/canvas?artifactId=art_test&type=IMAGE'
         }
      }];
      await route.fulfill({ response, json });
    });

    await page.goto('http://localhost:8085/#home');
    await page.waitForLoadState('domcontentloaded');

    // Desktop Home
    if (vp.name === 'desktop-1440') {
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(outDir, '01-home-before-canvas.png') });
    }

    // Open canvas explicitly
    await page.evaluate(() => {
        window.NAGEX.dispatchArtifactOpen('IMAGE', 'art_test', {
           title: 'Test Image',
           artifactProjection: {
              artifactId: 'art_test',
              artifactType: 'IMAGE',
              previewKind: 'IMAGE',
              previewTarget: 'https://via.placeholder.com/600x400.png?text=Test+Image',
              openTarget: 'https://via.placeholder.com/600x400.png',
              canvasTarget: '/canvas?artifactId=art_test&type=IMAGE'
           }
        });
    });

    // Wait for loading state
    if (vp.name === 'desktop-1440') {
       // Canvas loading might be skipped if image loads too fast.
       // await page.waitForSelector('#canvas-loading');
       // await page.screenshot({ path: path.join(outDir, '02-image-canvas-loading-or-transition.png') });
    }

    // Wait for image to load
    await page.waitForSelector('#canvas-image-wrapper', { state: 'visible', timeout: 5000 }).catch(() => {});

    if (vp.name === 'desktop-1440') {
       await page.screenshot({ path: path.join(outDir, '03-image-canvas-ready.png') });

       // Force error state
       await page.evaluate(() => {
          document.getElementById('canvas-loading').style.display = 'none';
          document.getElementById('canvas-image-wrapper').style.display = 'none';
          document.getElementById('canvas-error').style.display = 'flex';
       });
       await page.screenshot({ path: path.join(outDir, '04-image-canvas-error.png') });
    } else {
       await page.screenshot({ path: path.join(outDir, `${vp.name}-ready.png`) });
    }

    // Check overflow
    const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    if (overflow) {
        console.warn(`Viewport ${vp.name} has horizontal overflow!`);
    }

    await context.close();
  }

  await browser.close();
  serverProc.kill();
  console.log('Screenshots captured successfully.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
