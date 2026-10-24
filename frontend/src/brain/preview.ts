import { initializeBrain3D } from './viewer';
import type { Mapping } from './graph';
const canvas = document.querySelector<HTMLCanvasElement>('#brain')!;
const status = document.querySelector<HTMLElement>('#status')!;
const button = document.querySelector<HTMLButtonElement>('#play')!;
const dispose = await initializeBrain3D(
  canvas,
  (message) => {
    status.textContent = message;
  },
  document.querySelector('#labels'),
);
let timer: ReturnType<typeof setInterval> | undefined;
try {
  const response = await fetch(
    `${import.meta.env.BASE_URL}brain/recorded-preview.json`,
  );
  if (!response.ok) throw new Error('Recording unavailable');
  const recording = (await response.json()) as {
    mapping: Mapping;
    fires: { pairs: [number, number][] }[];
  };
  canvas.dispatchEvent(
    new CustomEvent('mapping', { detail: recording.mapping }),
  );
  let step = 0;
  button.addEventListener('click', () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
      button.textContent = 'Play recording';
      return;
    }
    button.textContent = 'Pause recording';
    const tick = () => {
      if (!document.hidden && recording.fires.length)
        canvas.dispatchEvent(
          new CustomEvent('fire', {
            detail: recording.fires[step++ % recording.fires.length]!,
          }),
        );
    };
    tick();
    timer = setInterval(tick, 1100);
  });
} catch (error) {
  status.textContent = String(error);
  button.disabled = true;
}
document
  .querySelector('#circuit')!
  .addEventListener('click', () =>
    canvas.dispatchEvent(new Event('focus-circuit')),
  );
document
  .querySelector('#fit')!
  .addEventListener('click', () => canvas.dispatchEvent(new Event('fit')));
window.addEventListener(
  'pagehide',
  () => {
    clearInterval(timer);
    dispose();
  },
  { once: true },
);
