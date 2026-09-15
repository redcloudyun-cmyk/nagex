import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { server } from '../src/server_web.js';
import * as path from 'node:path';

async function main() {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1680, height: 945 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000); // allow initial renders to settle

  const screenshotPath = 'C:\\Users\\redcl\\.gemini\\antigravity-ide\\brain\\fe484a0d-2796-4b45-b00b-714b10b93b38\\implemented_desktop_home_1680x945.png';
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`[SCREENSHOT] Saved 1680x945 screenshot to ${screenshotPath}`);

  await browser.close();
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
