// Rover A's safety camera: the Mac's webcam through ffmpeg (avfoundation),
// two frames a second written atomically to a file, decoded in the background.
// `latest()` is synchronous, so the motion loop never waits on the camera, and
// it throws when there is no fresh frame: the rover takes that as doubt and
// safe-stops. Every frame it returns goes into the episode file, which is
// published on 0G Storage, so keep people out of the shot.
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { type Image, loadImage } from '@napi-rs/canvas';

export const STALE_MS = 2000; // older than this, a frame no longer shows what is in front of the rover

/** The newest frame written to `file`, or an error saying why there is none. */
export function cameraFeed(file: string) {
  let img: Image | null = null, at = 0, seen = 0;
  setInterval(async () => {
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs === seen) return;
      seen = mtimeMs;
      img = await loadImage(await readFile(file));
      at = mtimeMs;
    } catch {} // no file yet, or a bad JPEG: the frame goes stale, and that is the error
  }, 250).unref();
  return (now = Date.now()) => {
    if (!img) throw new Error('camera unavailable: no frame yet');
    if (now - at > STALE_MS) throw new Error(`camera unavailable: last frame ${((now - at) / 1000).toFixed(1)} s old`);
    return img;
  };
}

/** ffmpeg writing `device`'s picture to `file` at 320×240, twice a second. */
export function startFfmpeg(device: string, file: string) {
  const ff = spawn('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-pixel_format', 'nv12', '-framerate', '30', '-video_size', '640x480', '-i', device,
    '-vf', 'fps=2,scale=320:240', '-q:v', '5', '-update', '1', '-atomic_writing', '1', '-y', file,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  // ponytail: no respawn; a dead ffmpeg leaves the rover safe-stopped with "camera unavailable", restart the sim.
  ff.on('exit', (code) => console.error(`camera "${device}": ffmpeg exited (${code})`));
  // SIGKILL: an ffmpeg stuck waiting for camera permission ignores Ctrl-C and would outlive the sim.
  const stop = () => ff.kill('SIGKILL');
  process.on('exit', stop);
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, () => { stop(); process.exit(130); });
}
