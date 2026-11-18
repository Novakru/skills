import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function encodeGif({ input, output, crop, fps = 10, trim = 0 }) {
  if (crop && !/^[1-9]\d*:[1-9]\d*:\d+:\d+$/.test(crop)) {
    throw new Error('Crop must be width:height:x:y with integer values.');
  }
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(trim) || trim < 0) {
    throw new Error('Frame rate must be positive and trim must be nonnegative.');
  }
  const filters = [
    ...(crop ? [`crop=${crop}`] : []),
    `fps=${fps}`,
    'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
  ];
  execFileSync('ffmpeg', [
    '-v', 'error', '-nostdin', '-n', '-ss', String(trim), '-i', resolve(input),
    '-vf', filters.join(','), '-loop', '0', resolve(output),
  ], { stdio: 'inherit' });
  return { bytes: statSync(output).size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        input: { type: 'string' },
        output: { type: 'string' },
        crop: { type: 'string' },
        fps: { type: 'string', default: '10' },
        trim: { type: 'string', default: '0' },
        help: { type: 'boolean' },
      },
    });
    const usage = 'node encode-gif.mjs --input capture.webm --output demo.gif [--crop width:height:x:y] [--fps 10] [--trim 0]';
    if (values.help) console.log(usage);
    else {
      if (!values.input || !values.output) throw new Error(usage);
      console.log(JSON.stringify(encodeGif({ ...values, fps: Number(values.fps), trim: Number(values.trim) })));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
