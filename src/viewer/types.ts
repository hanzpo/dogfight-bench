export interface ViewerAircraft {
  id: string;
  team: "blue" | "red";
  position: [number, number, number];
  orientation: [number, number, number, number];
  alive: boolean;
  afterburner?: boolean;
  integrity?: number;
}

export interface ViewerTracer {
  from: [number, number, number];
  to: [number, number, number];
}

export interface ViewerMissile {
  /** Stable while it flies, so its smoke trail joins up from frame to frame. */
  id: number;
  position: [number, number, number];
  velocity: [number, number, number];
  /** Burning motors trail smoke; a coasting missile is all but invisible. */
  motor: boolean;
}

export interface ViewerBurst {
  position: [number, number, number];
  /** When it went off, which is also what makes it one burst rather than several. */
  time: number;
  /** A warhead, or a missile that ran out of everything and self-destructed. */
  kind: "warhead" | "self-destruct";
}

export interface ViewerSnapshot {
  aircraft: ViewerAircraft[];
  tracers: ViewerTracer[];
  /** Impacts recorded since the previous snapshot. */
  impacts?: Array<[number, number, number]>;
  missiles?: ViewerMissile[];
  flares?: Array<[number, number, number]>;
  /** Missile bursts near the present; the viewer draws each one once. */
  bursts?: ViewerBurst[];
  /** Simulated time, so effects age independently of the frame rate. */
  time: number;
}
