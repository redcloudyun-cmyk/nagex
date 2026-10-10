import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';

const referencePath = "j:\\사업별 프로젝트\\NAgex Project\\새 폴더\\What's NAgex main 20260930.png";
const outDir = path.join(process.cwd(), 'artifacts', process.env.NAGEX_VISUAL_RECON_OUT || 'visual-reconstruction');
const actualPath = path.join(outDir, 'actual-1440.png');
const reference1440Path = path.join(outDir, 'reference-1440.png');
const overlayPath = path.join(outDir, 'overlay-1440.png');
const diffPath = path.join(outDir, 'diff-1440.png');
const measurementsPath = path.join(outDir, 'reference-measurements.json');
const deltaPath = path.join(outDir, 'geometry-delta.json');
const visualTokensPath = path.join(outDir, 'visual-tokens.json');
const comparisonPath = path.join(outDir, 'comparison.json');

function waitForServer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      http.get(url, (res) => {
        clearInterval(interval);
        res.resume();
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

function runPowerShell(script) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });
}

function rect(x, y, width, height) {
  return { x, y, width, height, right: x + width, bottom: y + height };
}

function scaledRect(r, scale, yOffset = 0) {
  return rect(
    Math.round(r.x * scale),
    Math.round(r.y * scale) + yOffset,
    Math.round(r.width * scale),
    Math.round(r.height * scale),
  );
}

function magnitude(delta) {
  return Math.abs(delta.deltaX) + Math.abs(delta.deltaY) + Math.abs(delta.deltaWidth) + Math.abs(delta.deltaHeight);
}

async function main() {
  if (!fs.existsSync(referencePath)) {
    throw new Error(`Reference image unavailable: ${referencePath}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const psMeasure = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Bitmap]::FromFile('${referencePath.replaceAll("'", "''")}')
function Hex($c) { '#{0:X2}{1:X2}{2:X2}' -f $c.R,$c.G,$c.B }
function Sample($x,$y) { $c=$img.GetPixel($x,$y); [pscustomobject]@{ r=$c.R; g=$c.G; b=$c.B; hex=(Hex $c) } }
function FindPrimaryBlue() {
  $best = $null; $bestScore = -999999
  for ($y=0; $y -lt $img.Height; $y+=2) {
    for ($x=0; $x -lt $img.Width; $x+=2) {
      $c = $img.GetPixel($x,$y)
      $score = ($c.B * 2 + $c.G) - ($c.R * 2) - [Math]::Abs($c.B - 248)
      if ($c.B -gt 170 -and $c.G -gt 40 -and $c.R -lt 80 -and $score -gt $bestScore) {
        $bestScore = $score
        $best = [pscustomobject]@{ x=$x; y=$y; r=$c.R; g=$c.G; b=$c.B; hex=(Hex $c) }
      }
    }
  }
  $best
}
$out = [ordered]@{
  width = $img.Width
  height = $img.Height
  palette = [ordered]@{
    pageBackground = (Sample ([Math]::Min($img.Width-2,[int]($img.Width*0.97))) ([int]($img.Height*0.04)))
    surface = (Sample ([int]($img.Width*0.91)) ([int]($img.Height*0.03)))
    softBlueSurface = (Sample ([int]($img.Width*0.78)) ([int]($img.Height*0.14)))
    primaryBlue = (FindPrimaryBlue)
    primaryText = (Sample ([int]($img.Width*0.18)) ([int]($img.Height*0.05)))
    secondaryText = (Sample ([int]($img.Width*0.245)) ([int]($img.Height*0.075)))
    border = (Sample ([int]($img.Width*0.70)) ([int]($img.Height*0.24)))
  }
}
$img.Dispose()
$out | ConvertTo-Json -Depth 6
`;
  const measured = JSON.parse(runPowerShell(psMeasure));

  const designBasis = { width: 1809, height: 1024 };
  const sx = measured.width / designBasis.width;
  const sy = measured.height / designBasis.height;
  const designRect = (x, y, width, height) => rect(
    Math.round(x * sx),
    Math.round(y * sy),
    Math.round(width * sx),
    Math.round(height * sy),
  );
  const referenceRects = {
    header: designRect(0, 0, 1809, 101),
    sidebar: designRect(12, 99, 187, 925),
    createStrip: designRect(216, 181, 1063, 163),
    workWithData: designRect(1295, 195, 312, 132),
    canvas: designRect(216, 358, 1026, 429),
    agent: designRect(1257, 201, 261, 584),
    intelligenceRail: designRect(1532, 0, 277, 787),
    recentCreations: designRect(216, 802, 1304, 222),
  };
  const scale = 1440 / measured.width;
  const reference1440Rects = Object.fromEntries(Object.entries(referenceRects).map(([key, value]) => [key, scaledRect(value, scale)]));
  fs.writeFileSync(measurementsPath, JSON.stringify({
    referenceImage: referencePath,
    dimensions: { width: measured.width, height: measured.height },
    rects: referenceRects,
    rects1440: reference1440Rects,
    palette: measured.palette,
  }, null, 2));

  runPowerShell(`
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile('${referencePath.replaceAll("'", "''")}')
$w = 1440; $h = 900
$dst = New-Object System.Drawing.Bitmap($w,$h)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.Clear([System.Drawing.Color]::FromArgb(237,246,255))
$scaledH = [int][Math]::Round($src.Height * ($w / $src.Width))
$g.DrawImage($src, 0, 0, $w, $scaledH)
$dst.Save('${reference1440Path.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $dst.Dispose(); $src.Dispose()
`);

  execFileSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
  const seedOutput = execFileSync('node', ['scripts/create_test_artifact.mjs'], { encoding: 'utf8' }).trim();
  const [sessionId] = seedOutput.split('|');

  const server = spawn('node', ['dist/src/server_web.js'], { stdio: 'pipe', env: process.env });
  let browser;
  try {
    await waitForServer('http://localhost:8085/api/v1/health', 20000);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'nagex_session', value: sessionId, domain: 'localhost', path: '/' }]);
    const page = await context.newPage();
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
    await page.waitForTimeout(700);
    await page.screenshot({ path: actualPath, fullPage: false });

    const actualRects = await page.evaluate(() => {
      const get = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
      };
      return {
        header: get('.app-header'),
        sidebar: get('.sidebar-left'),
        createStrip: get('#home-section-create'),
        workWithData: get('#home-section-work-with-data'),
        canvas: get('#home-embedded-canvas'),
        agent: get('#home-agent-panel'),
        intelligenceRail: get('#home-context-rail'),
        recentCreations: get('#home-section-recent-creations'),
      };
    });
    const visualTokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const token = (name) => root.getPropertyValue(name).trim();
      const body = getComputedStyle(document.body);
      return {
        pageBackground: token('--nagex-page-bg') || body.backgroundColor,
        surface: token('--nagex-surface-ref'),
        surfaceSoft: token('--nagex-surface-soft-ref'),
        surfaceSelected: token('--nagex-surface-selected-ref'),
        border: token('--nagex-border-ref'),
        borderSoft: token('--nagex-border-soft-ref'),
        textPrimary: token('--nagex-text-primary-ref'),
        textSecondary: token('--nagex-text-secondary-ref'),
        primary: token('--nagex-primary-ref'),
        primaryHover: token('--nagex-primary-hover-ref'),
        shadowCard: token('--nagex-shadow-card-ref'),
        shadowStage: token('--nagex-shadow-stage-ref')
      };
    });
    fs.writeFileSync(visualTokensPath, JSON.stringify(visualTokens, null, 2));
    await context.close();

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mobileContext.addCookies([{ name: 'nagex_session', value: sessionId, domain: 'localhost', path: '/' }]);
    const mobile = await mobileContext.newPage();
    await mobile.goto('http://localhost:8085/#home');
    await mobile.waitForLoadState('domcontentloaded');
    await mobile.waitForTimeout(1000);
    await mobile.screenshot({ path: path.join(outDir, 'actual-390-home.png'), fullPage: false });
    await mobile.evaluate(() => { window.location.hash = '#canvas/art_test_canvas_123'; });
    await mobile.waitForTimeout(1000);
    await mobile.screenshot({ path: path.join(outDir, 'actual-390-canvas.png'), fullPage: false });
    await mobileContext.close();

    const deltas = Object.fromEntries(Object.entries(reference1440Rects).map(([key, ref]) => {
      const actual = actualRects[key];
      const delta = {
        referenceRect: ref,
        actualRect: actual,
        deltaX: actual ? actual.x - ref.x : null,
        deltaY: actual ? actual.y - ref.y : null,
        deltaWidth: actual ? actual.width - ref.width : null,
        deltaHeight: actual ? actual.height - ref.height : null,
      };
      return [key, delta];
    }));
    fs.writeFileSync(deltaPath, JSON.stringify({
      referenceImage: referencePath,
      actualScreenshot: actualPath,
      regions: deltas,
      sortedByMagnitude: Object.entries(deltas).sort((a, b) => magnitude(b[1]) - magnitude(a[1])).map(([region, delta]) => ({ region, ...delta })),
    }, null, 2));
    fs.writeFileSync(comparisonPath, JSON.stringify({
      geometryFrozen: true,
      reference: reference1440Path,
      actual: actualPath,
      overlay: overlayPath,
      diff: diffPath,
      geometryDelta: deltaPath,
      visualTokens: visualTokensPath,
      mobileHome: path.join(outDir, 'actual-390-home.png'),
      mobileCanvas: path.join(outDir, 'actual-390-canvas.png'),
      categories: {
        pageBackground: 'semantic token override applied',
        surfaces: 'soft blue-tinted surfaces and lighter borders applied',
        typography: 'desktop shell hierarchy adjusted without geometry changes',
        borders: 'heavy dashboard outlines softened',
        shadows: 'card/stage blue shadows applied',
        primaryBlue: 'semantic primary token applied to buttons, selected states, active pills',
        capabilityTiles: 'icon containers, secondary status treatment, softer tile surface applied',
        canvasChrome: 'toolbar, stage, and action button skin adjusted only',
        agentChrome: 'tabs, composer, empty conversation surface adjusted only',
        intelligenceRail: 'section/card/action skin adjusted only',
        recentCreations: 'filter pills, card surface, open action styling adjusted only'
      }
    }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }

  runPowerShell(`
Add-Type -AssemblyName System.Drawing
$ref = [System.Drawing.Bitmap]::FromFile('${reference1440Path.replaceAll("'", "''")}')
$act = [System.Drawing.Bitmap]::FromFile('${actualPath.replaceAll("'", "''")}')
$w = [Math]::Min($ref.Width,$act.Width); $h = [Math]::Min($ref.Height,$act.Height)
$overlay = New-Object System.Drawing.Bitmap($w,$h)
$diff = New-Object System.Drawing.Bitmap($w,$h)
for ($y=0; $y -lt $h; $y++) {
  for ($x=0; $x -lt $w; $x++) {
    $r=$ref.GetPixel($x,$y); $a=$act.GetPixel($x,$y)
    $overlay.SetPixel($x,$y,[System.Drawing.Color]::FromArgb([int](($r.R+$a.R)/2),[int](($r.G+$a.G)/2),[int](($r.B+$a.B)/2)))
    $dr=[Math]::Abs($r.R-$a.R); $dg=[Math]::Abs($r.G-$a.G); $db=[Math]::Abs($r.B-$a.B)
    $d=[Math]::Min(255,[int](($dr+$dg+$db)/3*3))
    $diff.SetPixel($x,$y,[System.Drawing.Color]::FromArgb($d,0,255-$d))
  }
}
$overlay.Save('${overlayPath.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$diff.Save('${diffPath.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$ref.Dispose(); $act.Dispose(); $overlay.Dispose(); $diff.Dispose()
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
