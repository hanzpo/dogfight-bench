import { useEffect, useState, type RefObject } from "react";
import type { Choice } from "../setup";
import type { PilotInput } from "../input/pilot-input";
import type { DogfightViewer, ViewMode } from "../../viewer";

export const VIEWS: ReadonlyArray<Choice<ViewMode>> = [
  { value: "chase", label: "Chase" },
  { value: "cockpit", label: "Cockpit" },
  { value: "track", label: "Target track" },
  { value: "arena", label: "Arena" },
  { value: "free", label: "Free look" },
];

const ZOOM_PER_WHEEL_PIXEL = 0.0012;

/** Keys the page answers itself, so they are not read while typing into a field. */
export function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}

/**
 * What a flight screen does around the fight, offline and online alike: V
 * changes the camera, Esc or P asks for the menu, losing a captured mouse
 * asks for it too, and mouse or stick movement that is not flying turns and
 * zooms the camera.
 */
export function useFlightView({
  viewerRef,
  inputRef,
  enabled,
  menu,
  onMenu,
}: {
  viewerRef: RefObject<DogfightViewer | undefined>;
  inputRef: RefObject<PilotInput>;
  /** Off while something else has the screen, such as an instant replay. */
  enabled: boolean;
  /** Whether Esc should ask for the menu: not once the fight is over. */
  menu: boolean;
  onMenu: () => void;
}): { view: ViewMode; setView: (view: ViewMode) => void; viewLabel: string } {
  const [view, setView] = useState<ViewMode>("chase");

  useEffect(() => viewerRef.current?.setView(view), [view, viewerRef]);

  // Escape inside an open dialog is the dialog's own, which closes it.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || typingInto(event.target) || document.querySelector("dialog[open]")) return;
      if (event.code === "Escape" || event.code === "KeyP") {
        // Otherwise the browser reads this same Escape as a request to close
        // the dialog it has just opened, and the menu flashes shut.
        event.preventDefault();
        if (menu) onMenu();
      } else if (event.code === "KeyV") {
        setView((current) => VIEWS[(VIEWS.findIndex((entry) => entry.value === current) + 1) % VIEWS.length]!.value);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [enabled, menu, onMenu]);

  // The browser takes Escape for itself to release a captured mouse, so the
  // page never hears it; losing the capture mid-flight is the same request.
  useEffect(() => {
    if (!enabled || !menu) return;
    let wasLocked = document.pointerLockElement !== null;
    const changed = () => {
      const locked = document.pointerLockElement !== null;
      if (wasLocked && !locked && !document.querySelector("dialog[open]")) onMenu();
      wasLocked = locked;
    };
    document.addEventListener("pointerlockchange", changed);
    return () => document.removeEventListener("pointerlockchange", changed);
  }, [enabled, menu, onMenu]);

  useEffect(() => {
    let frame = 0;
    const orbit = () => {
      const instance = viewerRef.current;
      if (instance) {
        const delta = inputRef.current.consumeViewDelta();
        if (delta.orbitX || delta.orbitY) instance.orbitBy(delta.orbitX, delta.orbitY);
        if (delta.zoom) instance.zoomBy(Math.exp(delta.zoom * ZOOM_PER_WHEEL_PIXEL));
      }
      frame = requestAnimationFrame(orbit);
    };
    frame = requestAnimationFrame(orbit);
    return () => cancelAnimationFrame(frame);
  }, [viewerRef, inputRef]);

  return { view, setView, viewLabel: VIEWS.find((entry) => entry.value === view)?.label ?? "" };
}
