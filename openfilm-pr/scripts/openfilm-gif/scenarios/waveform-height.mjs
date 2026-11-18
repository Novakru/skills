import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const asset = 'assets/source.mp4';
const infoHeight = 15;
const canvasInset = 2;

async function prepare({ folder, media, filmHtml }) {
  assert.equal(extname(media).toLowerCase(), '.mp4', 'Use an MP4 with its own audio for this scenario.');
  await mkdir(join(folder, 'assets'), { recursive: true });
  await copyFile(media, join(folder, asset));
  await writeFile(join(folder, 'film.html'), filmHtml({
    stage: { w: 640, h: 360 },
    tracks: [
      { clips: [{ id: 'video', src: asset, time: [0, 8] }] },
      { clips: [{ id: 'audio', src: asset, sound: true, time: [0, 8] }] },
    ],
  }));
}

async function run({ page, caption, role, folder }) {
  const film = join(folder, 'film.html');
  const original = await readFile(film);
  const video = page.locator('[data-block-kind="video"]');
  const audio = page.locator('[data-block-id]:not([data-block-kind="video"]):not([data-block-kind="mg"])');
  const videoHead = page.locator('[data-lane-type="visual"]').first();
  const audioHead = page.locator('[data-lane-type="audio"]').first();
  const measurements = {};
  let mouseX = 0, mouseY = 0;

  async function until(check, reason) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await page.waitForTimeout(100);
    }
    assert.fail(reason);
  }

  async function box(locator) {
    await locator.waitFor({ state: 'visible' });
    const bounds = await locator.boundingBox();
    assert.ok(bounds, 'Expected visible timeline element.');
    return bounds;
  }

  async function move(x, y, steps = 14) {
    const startX = mouseX, startY = mouseY;
    for (let step = 1; step <= steps; step++) {
      await page.mouse.move(startX + (x - startX) * step / steps, startY + (y - startY) * step / steps);
      await page.waitForTimeout(12);
    }
    mouseX = x;
    mouseY = y;
  }

  async function guides(bounds = {}) {
    await page.evaluate((rectangles) => {
      const overlay = document.getElementById('openfilm-gif-overlay');
      overlay.querySelector('#openfilm-gif-guides')?.remove();
      const layer = document.createElement('div');
      layer.id = 'openfilm-gif-guides';
      for (const [name, color] of [['fade', '#ffd858'], ['line', '#ff8cdb']]) {
        const rect = rectangles[name];
        if (!rect) continue;
        const outline = document.createElement('div');
        Object.assign(outline.style, {
          position: 'absolute', left: `${rect.x - 2}px`, top: `${rect.y - 2}px`,
          width: `${rect.width + 4}px`, height: `${rect.height + 4}px`,
          outline: `2px solid ${color}`, borderRadius: '4px',
        });
        layer.append(outline);
      }
      overlay.prepend(layer);
    }, bounds);
  }

  async function resize(head, height, message) {
    await guides();
    await caption(message);
    const row = await box(head);
    const handle = await box(head.locator('[data-track-resize]'));
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await move(x, y);
    await page.mouse.down();
    await move(x, y + height - row.height, 30);
    await page.mouse.up();
    await until(async () => (await head.boundingBox())?.height === height, `Expected a ${height}px track.`);
  }

  async function chooseSmall() {
    await guides();
    await caption('右键选择原有“小”预设');
    const head = await box(videoHead);
    await move(head.x + 6, head.y + 9);
    await page.mouse.click(mouseX, mouseY, { button: 'right' });
    const menu = await box(page.getByRole('menuitem', { name: '轨道高度', exact: true }));
    await move(menu.x + menu.width / 2, menu.y + menu.height / 2);
    const small = await box(page.getByRole('menuitem', { name: '小', exact: true }));
    await move(small.x + small.width / 2, mouseY);
    await move(mouseX, small.y + small.height / 2);
    await page.mouse.click(mouseX, mouseY);
    await until(async () => (await videoHead.boundingBox())?.height === 36, 'Small should set a 36px video track.');
  }

  function columnHeights(canvas) {
    return canvas.evaluate((element) => {
      const { width, height } = element;
      const { data } = element.getContext('2d').getImageData(0, 0, width, height);
      return Array.from({ length: width }, (_, x) => {
        for (let y = 0; y < height; y++) {
          if (data[(y * width + x) * 4 + 3]) return (height - y) / devicePixelRatio;
        }
        return 0;
      });
    });
  }

  async function measure(name, kind, clip, head) {
    const bounds = await box(clip);
    await move(bounds.x + bounds.width / 2, bounds.y + 10);
    const canvas = clip.locator('canvas[data-wave-volume]');
    const trackPx = (await box(head)).height;
    const band = kind === 'audio'
      ? { y: bounds.y + infoHeight, height: bounds.height - infoHeight }
      : await box(clip.locator('[data-audio-band="on"]'));
    const expectedBand = kind === 'audio' ? trackPx - infoHeight
      : role === 'before' ? infoHeight : Math.max(infoHeight, Math.round((trackPx - infoHeight) * 0.3));
    assert.equal(band.height, expectedBand, `${name} audio band height`);
    const canvasPx = (await box(canvas)).height;
    assert.equal(canvasPx, expectedBand - canvasInset, `${name} waveform canvas height`);
    await until(() => canvas.evaluate((element) => element.height === Math.round(element.getBoundingClientRect().height * devicePixelRatio)), 'Expected canvas to redraw at its final size.');
    let peaks;
    await until(async () => {
      peaks = await columnHeights(canvas);
      return Math.max(...peaks) > 1;
    }, `${name} draws no waveform above the display floor. Check that the media contains audible audio.`);
    const fade = await box(clip.locator('[data-fade-handle="in"] > span'));
    const line = await box(clip.locator('[data-volume-line]'));
    const fadeBoundaryErrorPx = Math.abs(fade.y + fade.height / 2 - band.y);
    const lineY = line.y + line.height / 2;
    const volumeLineInsideBand = lineY >= band.y && lineY < band.y + band.height;
    const volume = Number(await canvas.getAttribute('data-wave-volume'));
    assert.ok(fadeBoundaryErrorPx <= 1, 'Fade handle follows the band boundary.');
    assert.ok(volumeLineInsideBand, 'Volume line remains in the audio band.');
    assert.equal(volume, 1, 'Track resizing preserves clip volume.');
    const thumbnailPx = kind === 'video' ? (await box(clip.locator('img').first())).height : null;
    const record = { trackPx, bandPx: band.height, canvasPx, peakPx: Math.max(...peaks), thumbnailPx, volume, fadeBoundaryErrorPx, volumeLineInsideBand };
    measurements[name] = record;
    await guides({ fade, line });
    await caption(`${kind === 'audio' ? '纯音频' : '视频＋原声'}｜轨道 ${trackPx}px，音频区域 ${band.height}px，波形画布 ${canvasPx}px，最大波峰 ${record.peakPx}px\n黄色为淡入点，粉色为音量线（录制标注）。音量 ${volume}`);
    await page.waitForTimeout(1300);
    return record;
  }

  await video.waitFor({ state: 'visible' });
  await until(() => video.locator('img').evaluateAll((images) => images.some((image) => image.complete && image.naturalWidth > 0)), 'Expected real video thumbnails.');
  await measure('video-default', 'video', video, videoHead);
  await chooseSmall();
  await measure('video-small', 'video', video, videoHead);
  await resize(videoHead, 156, '将视频轨道从小号拉高到 156px');
  const tall = await measure('video-tall', 'video', video, videoHead);

  await resize(audioHead, tall.canvasPx + infoHeight + canvasInset, '把纯音频画布调成与视频相同高度');
  await measure('audio-matched', 'audio', audio, audioHead);
  const videoPeaks = await columnHeights(video.locator('canvas[data-wave-volume]'));
  const audioPeaks = await columnHeights(audio.locator('canvas[data-wave-volume]'));
  assert.equal(videoPeaks.length, audioPeaks.length);
  const maxColumnErrorPx = Math.max(...videoPeaks.map((peak, index) => Math.abs(peak - audioPeaks[index])));
  assert.ok(maxColumnErrorPx <= 1, 'Same source, volume and canvas height should draw matching waveforms.');
  await caption(`同音源、同音量、同画布高度（${tall.canvasPx}px）｜逐列波峰最大差 ${maxColumnErrorPx}px`);
  await page.waitForTimeout(1600);

  await resize(videoHead, 76, '还原视频轨道');
  await resize(audioHead, 44, '还原纯音频轨道');
  const audioBefore = await measure('audio-default', 'audio', audio, audioHead);
  await resize(audioHead, 124, '将纯音频轨道从 44px 拉高到 124px');
  const audioAfter = await measure('audio-tall', 'audio', audio, audioHead);
  assert.ok(audioAfter.peakPx > audioBefore.peakPx, 'Audio peaks should grow with the canvas.');
  assert.deepEqual(await readFile(film), original, 'Track resizing leaves film.html intact.');
  return { measurements, sameCanvas: { heightPx: tall.canvasPx, maxColumnErrorPx }, filmUnchanged: true };
}

export default {
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
  storage: { 'openfilm.project.timelineH': '500' },
  crop: '1280:500:0:400',
  trim: 2,
  prepare,
  run,
};
