import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { encodeGif } from './encode-gif.mjs';

const uiEntry = 'studio/ui/dist/index.html';
const usage = 'node record.mjs --before <OpenFilm path> --after <OpenFilm path> --media <video> --out <empty directory> [--scenario waveform-height] [--before-label <label>] [--after-label <label>]';
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const fromBuild = (pkg, path) => import(pathToFileURL(join(pkg, path)).href);

export async function openFilmPackage(path) {
  for (const pkg of [resolve(path, 'packages', 'openfilm'), resolve(path)]) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.name !== 'openfilm') continue;
    try {
      await access(join(pkg, uiEntry));
      createRequire(join(pkg, 'package.json')).resolve('playwright-core');
    } catch {
      throw new Error(`Prepare ${pkg} first. Its built Studio UI and playwright-core dependency are required.`);
    }
    return { pkg, version: manifest.version, uiEntrySha256: await sha256(join(pkg, uiEntry)) };
  }
  throw new Error(`No OpenFilm checkout or installed package at ${path}`);
}

function addDemoOverlay({ language, storage, label }) {
  if (window !== window.top) return;
  localStorage.setItem('openfilm.language', language);
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.createElement('div');
    overlay.id = 'openfilm-gif-overlay';
    Object.assign(overlay.style, { pointerEvents: 'none', position: 'fixed', inset: '0', zIndex: '2147483646' });
    const caption = document.createElement('div');
    caption.id = 'openfilm-gif-caption';
    Object.assign(caption.style, {
      position: 'absolute', left: '145px', right: '24px', bottom: '28px', padding: '8px 12px',
      background: '#102530', color: 'white', font: '15px/1.6 system-ui, sans-serif', whiteSpace: 'pre-line',
    });
    caption.textContent = label;
    const cursor = document.createElement('div');
    Object.assign(cursor.style, { position: 'absolute', width: '25px', height: '32px', display: 'none' });
    cursor.innerHTML = '<svg viewBox="0 0 28 34"><path d="M3 2L3 27L10 21L15 32L20 29L15 19L25 19Z" fill="white" stroke="#17202a" stroke-width="2"/></svg>';
    overlay.append(caption, cursor);
    document.body.append(overlay);
    document.addEventListener('pointermove', ({ clientX, clientY }) => {
      cursor.style.display = 'block';
      cursor.style.transform = `translate(${clientX}px,${clientY}px)`;
    }, true);
  }, { once: true });
}

async function capture({ build, out, media, role, scenario, label }) {
  const { chromium } = createRequire(join(build.pkg, 'package.json'))('playwright-core');
  const { filmHtml } = await fromBuild(build.pkg, 'src/film-doc.mjs');
  const { openProject } = await fromBuild(build.pkg, 'studio/server/projects.mjs');
  const { startStudio } = await fromBuild(build.pkg, 'studio/server/server.mjs');
  const { default: scene } = await import(`./${scenario}/scenario.mjs`);
  const folder = join(process.env.OPENFILM_LIBRARY, 'GIF demo');
  const errors = [];
  const startedAt = new Date().toISOString();
  let studio, browser;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    await scene.prepare({ folder, media, filmHtml });
    const project = await openProject(folder);
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
    const context = await browser.newContext({
      viewport: scene.viewport, locale: scene.locale, reducedMotion: 'reduce',
      recordVideo: { dir: join(process.env.OPENFILM_HOME, 'video'), size: scene.viewport },
    });
    await context.addInitScript(addDemoOverlay, {
      label, language: scene.locale, storage: scene.storage ?? {},
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const url = new URL(`/projects/${encodeURIComponent(project.id)}`, studio.origin);
    url.searchParams.set('key', studio.key);
    await page.goto(url.href);
    const caption = (message) => page.locator('#openfilm-gif-caption').evaluate(
      (element, text) => { element.textContent = text; }, `${label}\n${message}`,
    );
    const result = await scene.run({ page, caption, role, folder });
    if (errors.length) throw new Error(`Studio page errors: ${errors.join('; ')}`);
    const recording = page.video();
    await context.close();
    await recording.saveAs(join(out, `${role}.webm`));
    await writeFile(join(out, `${role}.json`), JSON.stringify({
      label, role, startedAt, packageVersion: build.version, uiEntrySha256: build.uiEntrySha256,
      browser: browser.version(), crop: scene.crop, trim: scene.trim, ...result,
    }, null, 2) + '\n');
  } finally {
    try {
      await browser?.close();
    } finally {
      await studio?.close();
    }
  }
}

async function compare(args) {
  const { values } = parseArgs({
    args,
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
      media: { type: 'string' },
      out: { type: 'string' },
      scenario: { type: 'string', default: 'waveform-height' },
      'before-label': { type: 'string' },
      'after-label': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) { console.log(usage); return; }
  if (!values.before || !values.after || !values.media || !values.out) throw new Error(usage);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.scenario)) throw new Error('Invalid scenario name.');
  try { await access(fileURLToPath(new URL(`./${values.scenario}/scenario.mjs`, import.meta.url))); }
  catch { throw new Error(`No comparison scenario named ${values.scenario}. See README.md for feature commands.`); }
  const media = resolve(values.media), out = resolve(values.out);
  if (!(await stat(media)).isFile()) throw new Error('Media must be a file.');
  const builds = {};
  for (const role of ['before', 'after']) builds[role] = await openFilmPackage(values[role]);
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ffmpeg.status !== 0) throw new Error('FFmpeg must be available on PATH.');
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error('Use a new or empty output directory.');

  const temp = await realpath(tmpdir());
  const scratch = await mkdtemp(join(temp, 'openfilm-gif-'));
  const results = {};
  try {
    // Studio imports read process state. Give each version its own process and project library.
    const cleanEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^OPENFILM_|_API_KEY$/i.test(key)));
    for (const role of ['before', 'after']) {
      const build = builds[role];
      const label = values[`${role}-label`] ?? `${role} · OpenFilm ${build.version}`;
      console.log(`Recording ${label}`);
      const runtime = join(scratch, role);
      const env = { ...cleanEnv };
      for (const name of ['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS']) {
        env[`OPENFILM_${name}`] = join(runtime, name.toLowerCase());
      }
      const child = spawnSync(process.execPath, [
        fileURLToPath(import.meta.url), '--capture-one',
        JSON.stringify({ build, out, media, role, label, scenario: values.scenario }),
      ], { env, stdio: 'inherit' });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`${role} recording failed (${child.signal ?? child.status}).`);
      const recording = JSON.parse(await readFile(join(out, `${role}.json`), 'utf8'));
      const gif = encodeGif({
        input: join(out, `${role}.webm`), output: join(out, `${role}.gif`),
        crop: recording.crop, trim: recording.trim,
      });
      results[role] = { ...recording, gif: `${role}.gif`, gifBytes: gif.bytes };
    }
    await writeFile(join(out, 'measurements.json'), JSON.stringify({
      scenario: values.scenario, mediaSha256: await sha256(media), ...results,
    }, null, 2) + '\n');
    console.log(`Saved both GIFs and measurements in ${out}`);
  } finally {
    const target = await realpath(scratch);
    const child = relative(temp, target);
    if (isAbsolute(child) || child.includes(sep) || !child.startsWith('openfilm-gif-')) {
      throw new Error(`Unexpected temporary directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) try {
  if (process.argv[2] === '--capture-one') await capture(JSON.parse(process.argv[3]));
  else await compare(process.argv.slice(2));
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
