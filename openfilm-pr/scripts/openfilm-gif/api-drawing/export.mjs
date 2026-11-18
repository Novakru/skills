import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { encodeGif } from '../encode-gif.mjs';

export function exportRecording(folder, { input, keepWait = false } = {}) {
  const meta = JSON.parse(readFileSync(join(folder, 'export.json'), 'utf8'));
  input ??= resolve(folder, meta.videoPath);
  const from = meta.cloudWait.from + 2;
  const to = meta.cloudWait.to - 0.4;
  const omit = !keepWait && from < to ? { from, to } : undefined;
  const output = join(folder, 'workflow.gif');
  const { bytes } = encodeGif({ input, output, fps: 25, width: 1280, trim: meta.start, duration: meta.seconds, omit });
  execFileSync('ffmpeg', [
    '-v', 'error', '-nostdin', '-n', '-ss', String(meta.start), '-i', input, '-t', String(meta.seconds),
    '-vf', 'scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(folder, 'workflow-full.mp4'),
  ], { stdio: 'inherit' });
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_frames:format=duration', '-of', 'json', output,
  ], { encoding: 'utf8' }));
  assert.equal(probe.streams[0].avg_frame_rate, '25/1');
  const summary = { bytes, omittedWaitSeconds: omit ? omit.to - omit.from : 0, ...probe };
  writeFileSync(join(folder, 'media-qa.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, input: { type: 'string' }, 'keep-wait': { type: 'boolean' }, help: { type: 'boolean' } } });
  const usage = 'node export.mjs --out <directory with export.json> [--input workflow.webm] [--keep-wait]';
  if (values.help) console.log(usage);
  else {
    assert.ok(values.out, usage);
    exportRecording(resolve(values.out), { input: values.input, keepWait: values['keep-wait'] });
  }
}
