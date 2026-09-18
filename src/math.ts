export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function lerp(from: number, to: number, fraction: number): number {
  return from + (to - from) * fraction;
}
