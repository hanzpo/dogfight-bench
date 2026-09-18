export function signed(value: number, digits = 0): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/** A signed whole number with thousands separators: "+1,200". */
export function signedCount(value: number): string {
  return `${value >= 0 ? "+" : ""}${Math.round(value).toLocaleString()}`;
}

export function either(value: number, positive: string, negative: string): string {
  return value >= 0 ? positive : negative;
}

/** Where you are relative to the opponent, from the angle off their tail. */
export function aspect(angleOffTailDeg: number): "behind them" | "abeam" | "in front of them" {
  if (angleOffTailDeg < 70) return "behind them";
  if (angleOffTailDeg > 120) return "in front of them";
  return "abeam";
}
