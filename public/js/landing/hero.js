import { $, $$ } from '../utils.js';

export function initHeroGap() {
  const shell = $('.hero-shell');
  const copy = $('.hero-copy', shell || document);
  if (!shell || !copy) return;

  const BREATHING_ROOM = 14;
  const apply = () => {
    const shellTop = shell.getBoundingClientRect().top;
    const copyBottom = copy.getBoundingClientRect().bottom;
    const needed = Math.round(copyBottom - shellTop + BREATHING_ROOM);

    shell.style.setProperty('--hero-gap', `max(${needed}px, var(--hero-gap-base))`);
  };

  const base = getComputedStyle(shell).getPropertyValue('--hero-gap').trim();
  shell.style.setProperty('--hero-gap-base', base);

  apply();
  if ('ResizeObserver' in window) new ResizeObserver(apply).observe(copy);
  window.addEventListener('resize', apply);

  document.fonts?.ready?.then(apply);
}

export function initMagneticButtons() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;
  const MAX_PULL = 10;
  $$('.pill-button.dark, .pill-button.glass').forEach((button) => {
    let raf = null;
    let pressed = false;
    const apply = (x, y) => {
      const pull = `translate(${(x * MAX_PULL).toFixed(1)}px, ${(y * MAX_PULL).toFixed(1)}px)`;
      const lift = 'translateY(-2px)';
      const press = pressed ? ' scale(.94)' : '';
      button.style.transform = `${pull} ${lift}${press}`;
    };
    let lastX = 0;
    let lastY = 0;
    button.addEventListener('mousemove', (event) => {
      const rect = button.getBoundingClientRect();
      lastX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      lastY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      if (raf) return;
      raf = requestAnimationFrame(() => { apply(lastX, lastY); raf = null; });
    });
    button.addEventListener('mousedown', () => { pressed = true; apply(lastX, lastY); });
    button.addEventListener('mouseup', () => { pressed = false; apply(lastX, lastY); });
    button.addEventListener('mouseleave', () => { pressed = false; button.style.transform = ''; });
  });
}
