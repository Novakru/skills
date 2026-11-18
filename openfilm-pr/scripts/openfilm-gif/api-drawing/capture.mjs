import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile, readdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openFilmPackage } from '../record.mjs';
import { exportRecording } from './export.mjs';

const { values } = parseArgs({ options: {
  openfilm: { type: 'string' }, out: { type: 'string' },
  config: { type: 'string', default: fileURLToPath(new URL('./example.json', import.meta.url)) },
  live: { type: 'boolean' }, help: { type: 'boolean' },
} });
const usage = 'node capture.mjs --openfilm <built checkout or package> --out <empty directory> --live [--config example.json]';
if (values.help) { console.log(usage); process.exit(0); }
assert.ok(values.live && values.openfilm && values.out, usage);
const { pkg, version } = await openFilmPackage(values.openfilm);
const out = resolve(values.out);
const key = process.env.OPENROUTER_API_KEY;
assert.ok(key, 'Set OPENROUTER_API_KEY in the process environment.');
const configPath = resolve(values.config);
const { model, prompt, ratio, references } = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(model, 'black-forest-labs/flux-3-image');
assert.equal(ratio, '16:9');
assert.equal(references.length, 3);
assert.ok(typeof prompt === 'string' && prompt.trim());
await mkdir(out, { recursive: true });
assert.equal((await readdir(out)).length, 0, 'Use a new or empty output directory.');
const temp = await realpath(os.tmpdir());
const run = await mkdtemp(join(temp, 'openfilm-api-drawing-'));
let studio, browser, context, page;
const originalFetch = globalThis.fetch;
try {
  for (const name of ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS']) process.env[`OPENFILM_${name}`] = join(run, name.toLowerCase());
  for (const name of Object.keys(process.env)) if (name.endsWith('_API_KEY') && name !== 'OPENROUTER_API_KEY') delete process.env[name];
  delete process.env.OPENFILM_OPENROUTER_URL;
  await mkdir(join(run, 'recordings'), { recursive: true });
  const root = join(run, 'library', 'Reference workflow');
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, '.film'), { recursive: true });
  const hashes = [];
  for (let i = 0; i < 3; i++) {
    const path = join(root, 'assets', `ref${i + 1}.jpg`);
    await copyFile(resolve(configPath, '..', references[i].file), path);
    hashes.push(createHash('sha256').update(await readFile(path)).digest('hex'));
    assert.equal(hashes[i], references[i].sha256, 'Reference bytes differ from the sample configuration.');
  }
  const calls = [], requests = [], errors = [], moves = [];
  const publish = async () => {
    await writeFile(join(out, 'network-calls.json'), JSON.stringify(calls, null, 2));
    if (page && !page.isClosed()) await page.evaluate(data => {
      const el = document.getElementById('backend-data');
      if (el) {
        const last = data.at(-1);
        const summary = last ? { run: last.run, method: last.method, url: last.url, model: last.model, inputReferenceCount: last.inputReferences.length, inputSha256: last.inputReferences.map(r => r.sha256.slice(0, 16)), requestBytes: last.requestBytes, httpStatus: last.status, outputImages: last.outputImages ?? null, seconds: last.seconds ?? null, generationId: last.id ?? null, usage: last.usage ?? null } : {};
        el.textContent = (data.length > 1 ? `对照组（无参考图）: HTTP ${data[0].status}\n返回 ${data[0].outputImages} 张，费用 $${data[0].usage?.cost ?? '未报告'}\n\n` : '') + JSON.stringify(summary, null, 2);
      }
    }, calls);
  };
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://openrouter.ai/api/v1/images' || init?.method !== 'POST') return originalFetch(url, init);
    assert.ok(calls.length < 2, 'at most two billable generations');
    const body = JSON.parse(init.body);
    assert.equal(body.model, model); assert.equal(body.n, 1);
    assert.ok(!body.size || body.size === '1K');
    const entry = { run: calls.length ? 'with references' : 'no-reference control', method: 'POST', url: String(url), model: body.model, inputReferences: (body.input_references ?? []).map(ref => {
      const bytes = Buffer.from(ref.image_url.url.split(',')[1], 'base64');
      return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }), requestBytes: Buffer.byteLength(init.body), prompt: body.prompt, startedAt: new Date().toISOString(), status: 'pending' };
    assert.deepEqual(entry.inputReferences.map(ref => ref.sha256), calls.length ? hashes : []);
    calls.push(entry); await publish(); console.log(`real request ${calls.length}: references=${entry.inputReferences.length}`);
    const started = Date.now();
    const response = await originalFetch(url, init);
    const data = await response.clone().json();
    entry.status = response.status; entry.seconds = (Date.now() - started) / 1000;
    entry.id = data.id ?? null; entry.requestId = response.headers.get('x-request-id'); entry.usage = data.usage ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens, total_tokens: data.usage.total_tokens, cost: data.usage.cost } : null;
    entry.outputImages = data.data?.length ?? 0;
    if (!response.ok) entry.error = 'OpenRouter rejected the request';
    if (data.data?.[0]?.b64_json) {
      const bytes = Buffer.from(data.data[0].b64_json, 'base64');
      entry.outputSha256 = createHash('sha256').update(bytes).digest('hex');
      const ext = data.data[0].media_type?.includes('jpeg') ? 'jpg' : data.data[0].media_type?.includes('webp') ? 'webp' : 'png';
      entry.outputFile = `api-result-${calls.length}.${ext}`;
      await writeFile(join(out, entry.outputFile), bytes);
    }
    await publish(); console.log(`real response ${calls.length}: HTTP ${response.status}, outputs=${entry.outputImages}, cost=${entry.usage?.cost ?? 'not reported'}`);
    return response;
  };
  const authCheck = await originalFetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  assert.equal(authCheck.status, 200, 'OpenRouter authentication must succeed');
  await writeFile(join(out, 'auth-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), host: 'openrouter.ai', path: '/api/v1/key', status: authCheck.status }, null, 2));
  await mkdir(process.env.OPENFILM_HOME, { recursive: true });
  await writeFile(join(process.env.OPENFILM_HOME, 'providers.json'), JSON.stringify({ keys: {}, use: { image: 'openrouter' }, model: { image: model } }));
  const imp = path => import(pathToFileURL(join(pkg, path)));
  const { filmHtml } = await imp('src/film-doc.mjs');
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 640, h: 360 }, tracks: [] }));
  const board = {
    nodes: [
      ...references.map(({ title: name }, i) => ({ id: `r${i}`, title: `参考图 ${i + 1} · ${name}`, path: `assets/ref${i + 1}.jpg`, x: 0, y: i * 230, w: 240, h: 180 })),
      { id: 'make', title: '真实生图 · OpenRouter / FLUX.3', make: 'image', prompt, via: 'openrouter', model, opts: { ratio }, x: 650, y: 207, w: 416, h: 234 },
    ],
    edges: [0, 1, 2].map(i => ({ id: `e${i}`, from: `r${i}`, to: 'make', order: i })),
  };
  await writeFile(join(root, '.film/canvas.json'), JSON.stringify(board));
  const { openProject } = await imp('studio/server/projects.mjs');
  const { startStudio } = await imp('studio/server/server.mjs');
  const project = await openProject(root);
  studio = await startStudio({ port: 0, openBrowser: () => {} });
  const { chromium } = createRequire(join(pkg, 'package.json'))('playwright-core');
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, recordVideo: { dir: join(run, 'recordings'), size: { width: 1920, height: 1000 } }, locale: 'en-US' });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/get') { const { via, model, args } = req.postDataJSON(); requests.push({ via, model, args }); } });
  await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
  await page.addStyleTag({ content: '#root { width:1440px !important; max-width:1440px !important; height:100vh; } .workspace-shell { right:480px !important; }' });
  await page.locator('[data-work-mode="edit"]').click();
  await page.locator('[data-studio-canvas][data-canvas-ready="1"]').waitFor();
  await page.locator('[data-id="make"]').click();
  await page.waitForTimeout(800);
  const geometry = await page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(n => {
    const b = n.getBoundingClientRect(); return { id: n.dataset.id, x: b.x, y: b.y, w: b.width, h: b.height };
  }));
  for (const b of geometry) assert.ok(b.x >= 0 && b.y >= 140 && b.x + b.w <= 1440 && b.y + b.h <= 920, `node in view: ${JSON.stringify(b)}`);
  assert.equal(await page.locator('[data-canvas-wire="edge"]').count(), 3);
  await page.evaluate(() => {
    const el = document.createElement('aside');
    el.style = 'position:fixed;right:0;top:0;width:480px;height:100vh;background:#0c1422;color:#e0e9f8;z-index:99980;border-left:1px solid #58677a;padding:22px;box-sizing:border-box;overflow:auto;font:13px/1.5 monospace';
    el.innerHTML = '<h2 style="font:20px Microsoft YaHei">真实后台请求 / 响应</h2><p>直接读取 OpenRouter 网络返回；不是模拟响应。仅隐藏 Authorization。</p><pre id="backend-data" style="white-space:pre-wrap;word-break:break-word"></pre>';
    document.body.append(el);
  });
  await page.screenshot({ path: join(out, 'layout-before-spend.png') });
  const { runGet } = await imp('studio/server/get.mjs');
  const controlReceipt = await runGet(root, 'image', { out: 'no-reference-control', prompt, ratio }, { via: 'openrouter', model, yes: true });
  await writeFile(join(out, 'control-receipt.txt'), controlReceipt);
  assert.equal(calls[0].status, 200); assert.equal(calls[0].outputImages, 1);
  await page.evaluate(() => {
    const header = document.createElement('div'); header.id = 'capture-header';
    header.style = 'position:fixed;left:24px;width:1392px;box-sizing:border-box;top:64px;z-index:99990;pointer-events:none;padding:14px 18px;border:1px solid #58677a;border-radius:12px;background:#17202eef;color:#eff5ff;font:15px/1.6 "Microsoft YaHei",sans-serif;display:flex;justify-content:space-between;gap:24px';
    header.innerHTML = '<div><strong style="font-size:19px">真实参考照片 → FLUX.3 生图 → 真实云端返回</strong><div style="color:#b9c9df">OpenFilm · OpenRouter · 右侧为实际后台日志 · GIF 可裁去等待，完整视频保留</div></div><div id="capture-step" style="align-self:center;font-size:17px;color:#ffe08a">① 查看参考图与连线</div>';
    document.body.append(header);
    const cursor = document.createElement('div'); cursor.id = 'capture-cursor';
    cursor.style = 'position:fixed;left:0;top:0;width:36px;height:42px;pointer-events:none;z-index:100000;will-change:transform;transform:translate3d(80px,170px,0)';
    cursor.innerHTML = '<svg width="36" height="42" viewBox="-10 -10 36 42"><circle cx="4" cy="9" r="15" fill="#ffd952" fill-opacity=".16"/><path d="M0 0V23L6 17L11 28L16 26L11 15H21Z" fill="white" stroke="#171c29" stroke-width="2" stroke-linejoin="round"/></svg>';
    document.body.append(cursor);
    window.capturePointer = { x: 80, y: 170 };
    window.captureStartedAt = performance.now();
  });
  const elapsed = () => page.evaluate(() => (performance.now() - window.captureStartedAt) / 1000);
  const step = text => page.evaluate(text => { document.getElementById('capture-step').textContent = text; }, text);
  const glide = async (x, y, duration = 1100) => {
    const started = await elapsed();
    // This compositor-animated pointer is a recording aid. Playwright performs the actual hover/click.
    await Promise.all([
      page.evaluate(async ({ x, y, duration }) => {
        const el = document.getElementById('capture-cursor'), from = window.capturePointer;
        const a = el.animate([{ transform: `translate3d(${from.x}px,${from.y}px,0)` }, { transform: `translate3d(${x}px,${y}px,0)` }], { duration, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
        await a.finished; el.style.transform = `translate3d(${x}px,${y}px,0)`; a.cancel(); window.capturePointer = { x, y };
      }, { x, y, duration }),
      page.mouse.move(x, y),
    ]);
    moves.push({ started, finished: await elapsed(), x, y, duration });
  };
  const point = async (id, fx = .5, fy = .5) => {
    const b = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox(); assert.ok(b);
    return { x: b.x + b.width * fx, y: b.y + b.height * fy };
  };
  await page.waitForTimeout(650);
  for (const id of ['r0', 'r1', 'r2']) {
    const p = await point(id); await glide(p.x, p.y, 1000); await page.waitForTimeout(300);
  }
  await step('② 顺着连线查看生成节点');
  const source = await point('r2', 1, .5), target = await point('make', 0, .5);
  await glide((source.x + target.x) / 2, (source.y + target.y) / 2, 1100);
  await glide(target.x + 50, target.y, 1000);
  await page.waitForTimeout(450);
  await step('③ 真实云端生成，等待 API 返回');
  const button = page.getByRole('button', { name: 'Make', exact: true }), box = await button.boundingBox(); assert.ok(box);
  await glide(box.x + box.width / 2, box.y + box.height / 2, 1300);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const el = document.getElementById('capture-cursor');
    el.animate([{ filter: 'drop-shadow(0 0 0px #ffdf5e)' }, { filter: 'drop-shadow(0 0 14px #ffdf5e)' }, { filter: 'drop-shadow(0 0 0px #ffdf5e)' }], { duration: 450 });
  });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const waitFrom = await elapsed();
  for (let n = 0; n < 720 && (!calls[1] || calls[1].status === 'pending'); n++) await page.waitForTimeout(500);
  const waitTo = await elapsed();
  assert.equal(calls.length, 2); assert.equal(calls[1].status, 200); assert.equal(calls[1].outputImages, 1);
  assert.deepEqual(calls[1].inputReferences.map(r => r.sha256), hashes);
  assert.equal(requests.length, 1); assert.equal(requests[0].args.ref.length, 3);
  await page.locator('[data-id="make"] img').first().waitFor();
  await page.waitForTimeout(450);
  await step(`④ HTTP ${calls[1].status} · 发送 3 张参考图 · 真实返回 1 张`);
  const result = await point('make'); await glide(result.x, result.y, 1200);
  await page.waitForTimeout(700);
  await glide(1670, 370, 1100);
  await page.waitForTimeout(3000);
  const seconds = await elapsed();
  await page.screenshot({ path: join(out, 'workflow.png') });
  const savedBoard = JSON.parse(await readFile(join(root, '.film/canvas.json'), 'utf8'));
  const savedPath = savedBoard.nodes.find(n => n.id === 'make').path;
  assert.ok(savedPath, 'actual result saved to the canvas');
  const savedHash = createHash('sha256').update(await readFile(join(root, savedPath))).digest('hex');
  assert.equal(savedHash, calls[1].outputSha256);
  await writeFile(join(out, 'results.json'), JSON.stringify({ platform: os.platform(), release: os.release(), packageVersion: version, browser: browser.version(), model, prompt, hashes, calls, requests, errors, geometry, pointerMoves: moves, sceneDurationSeconds: seconds, cloudWait: { from: waitFrom, to: waitTo }, savedPath, savedHash, pointer: 'Compositor-animated recording aid; actual interactions performed by Playwright; all API responses are real' }, null, 2));
  const video = page.video(); await context.close(); context = null;
  const videoPath = join(out, 'workflow.webm'); await video.saveAs(videoPath);
  // Locate the first recorded header frame, rather than treating screenshot/encoding time as part of the scene.
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath], { encoding: 'utf8' }).trim());
  const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', videoPath, '-vf', 'crop=2:2:32:120,format=rgb24', '-f', 'rawvideo', 'pipe:1']);
  let first = -1;
  for (let n = 0; n < pixels.length / 12; n++) {
    const [r, g, b] = pixels.subarray(n * 12, n * 12 + 3);
    if (b > g + 8 && g > r + 3) { first = n; break; }
  }
  assert.ok(first >= 0, 'recording header appears');
  const start = first / 25;
  await writeFile(join(out, 'export.json'), JSON.stringify({ videoPath: 'workflow.webm', sourceSeconds: duration, start, seconds, fps: 25, cloudWait: { from: waitFrom, to: waitTo } }, null, 2));
  exportRecording(out, { input: videoPath });
  console.log(JSON.stringify({ out, calls: calls.length, realImages: calls.map(c => c.outputImages), costs: calls.map(c => c.usage?.cost ?? null), errors, duration: seconds }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(out, 'error.png') }).catch(() => {});
  console.error(String(error.stack ?? error).split(key).join('<REDACTED>'));
  process.exitCode = 1;
} finally {
  await context?.close(); await browser?.close(); await studio?.close(); globalThis.fetch = originalFetch;
  const target = await realpath(run);
  assert.ok(target === run && resolve(target, '..') === temp && target.startsWith(join(temp, 'openfilm-api-drawing-')));
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
