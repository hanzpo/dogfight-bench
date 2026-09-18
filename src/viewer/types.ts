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

export interface ViewerSnapshot {
  aircraft: ViewerAircraft[];
  tracers: ViewerTracer[];
  /** Impacts recorded since the previous snapshot. */
  impacts?: Array<[number, number, number]>;
  /** Simulated time, so effects age independently of the frame rate. */
  time: number;
}
