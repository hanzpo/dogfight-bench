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
  /** Tail: where the round was a few milliseconds ago. */
  a: [number, number, number];
  /** Head: where the round is now. */
  b: [number, number, number];
}

export interface ViewerSnapshot {
  aircraft: ViewerAircraft[];
  tracers: ViewerTracer[];
  /** Impact points recorded since the previous snapshot. */
  impacts?: Array<[number, number, number]>;
  /** Simulated time, used to age effects independently of frame rate. */
  time: number;
}
