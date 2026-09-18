/**
 * How much of a round's recent path a tracer streak represents, seconds.
 *
 * Shared by the live renderer and the replay recorder so a burst looks the same
 * whether it is happening now or being played back.
 */
export const TRACER_TRAIL_SECONDS = 0.018;
