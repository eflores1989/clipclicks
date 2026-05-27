import type { Easing } from '../types/project';

export function ease(t: number, easing: Easing): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (easing) {
    case 'linear':
      return t;
    case 'easeIn':
      return t * t;
    case 'easeOut':
      return 1 - (1 - t) * (1 - t);
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    case 'spring':
      // 1 - 2^(-10 t) * cos((t*10 - 0.75)(2π/3)) — subtle overshoot
      return 1 - Math.pow(2, -10 * t) * Math.cos(((t * 10 - 0.75) * 2 * Math.PI) / 3);
    default:
      return t;
  }
}
