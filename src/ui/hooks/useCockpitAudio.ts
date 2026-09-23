import { useEffect, useRef, type RefObject } from "react";
import { rwrContacts } from "../../sim/rwr";
import type { MatchState } from "../../sim/types";

/**
 * What the pilot hears: the missile's seeker and the missile warning.
 *
 * The seeker's tone is how a Sidewinder pilot knows what it sees without
 * looking -- a low growl that gets louder as heat comes into view, and a
 * steady high tone once it has locked. The warning is a fast pulse that does
 * not stop while a missile is coming.
 *
 * Browsers will not start sound before the page has been touched, so the
 * audio is built on the first key or click and stays silent until then.
 */
export function useCockpitAudio(
  stateRef: RefObject<MatchState | undefined>,
  followId: string,
  enabled: boolean,
): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    let context: AudioContext | undefined;
    let voices: ReturnType<typeof buildVoices> | undefined;
    let frame = 0;

    const start = () => {
      if (context || typeof AudioContext === "undefined") {
        void context?.resume();
        return;
      }
      try {
        context = new AudioContext();
        voices = buildVoices(context);
      } catch {
        context = undefined;
      }
    };
    addEventListener("keydown", start);
    addEventListener("pointerdown", start);

    const update = () => {
      frame = requestAnimationFrame(update);
      if (!context || !voices) return;
      const state = stateRef.current;
      const own = state?.aircraft.find((aircraft) => aircraft.id === followId);
      const live = enabledRef.current && state !== undefined && !state.finished && own?.alive === true;
      const now = context.currentTime;

      let growl = 0;
      let lock = 0;
      let warning = 0;
      if (live && own && own.stores.missiles > 0) {
        const tone = own.seeker.tone;
        if (tone === "search") growl = 0.012;
        if (tone === "growl") growl = 0.03 + 0.06 * Math.min(own.seeker.signal, 1);
        if (tone === "lock") lock = 0.07;
        voices.growl.frequency.setTargetAtTime(tone === "growl" ? 360 + 140 * Math.min(own.seeker.signal, 1) : 300, now, 0.05);
      }
      if (live && state && own && own.stores.missileStations > 0) {
        warning = rwrContacts(state, own.id).some((contact) => contact.kind === "missile") ? 0.06 : 0;
      }
      voices.growlGain.gain.setTargetAtTime(growl, now, 0.04);
      voices.lockGain.gain.setTargetAtTime(lock, now, 0.03);
      voices.warningGain.gain.setTargetAtTime(warning, now, 0.02);
    };
    frame = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("keydown", start);
      removeEventListener("pointerdown", start);
      void context?.close();
    };
  }, [stateRef, followId]);
}

function buildVoices(context: AudioContext) {
  const master = context.createGain();
  master.gain.value = 0.8;
  master.connect(context.destination);

  // The growl: a buzzy tone whose loudness shudders, the way the real one does.
  const growl = context.createOscillator();
  growl.type = "sawtooth";
  growl.frequency.value = 300;
  const shudder = context.createOscillator();
  shudder.frequency.value = 23;
  const shudderDepth = context.createGain();
  shudderDepth.gain.value = 0.5;
  const growlShape = context.createGain();
  growlShape.gain.value = 0.5;
  const growlFilter = context.createBiquadFilter();
  growlFilter.type = "lowpass";
  growlFilter.frequency.value = 1_400;
  const growlGain = context.createGain();
  growlGain.gain.value = 0;
  shudder.connect(shudderDepth).connect(growlShape.gain);
  growl.connect(growlShape).connect(growlFilter).connect(growlGain).connect(master);

  const lock = context.createOscillator();
  lock.type = "sine";
  lock.frequency.value = 1_250;
  const lockGain = context.createGain();
  lockGain.gain.value = 0;
  lock.connect(lockGain).connect(master);

  // The warning: a square tone keyed on and off six times a second.
  const warning = context.createOscillator();
  warning.type = "square";
  warning.frequency.value = 950;
  const key = context.createOscillator();
  key.type = "square";
  key.frequency.value = 6;
  const keyDepth = context.createGain();
  keyDepth.gain.value = 0.5;
  const keyed = context.createGain();
  keyed.gain.value = 0.5;
  const warningGain = context.createGain();
  warningGain.gain.value = 0;
  key.connect(keyDepth).connect(keyed.gain);
  warning.connect(keyed).connect(warningGain).connect(master);

  for (const oscillator of [growl, shudder, lock, warning, key]) oscillator.start();
  return { growl, growlGain, lockGain, warningGain };
}
