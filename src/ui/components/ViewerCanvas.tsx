import { useEffect, useRef, type RefObject } from "react";
import { DogfightViewer, type ViewerSnapshot } from "../../viewer";

/**
 * Mounts the Three.js renderer into React.
 *
 * The snapshot arrives through a ref rather than a prop on purpose. Pushing a
 * new scene through React state sixty times a second re-renders the whole page
 * for every frame, which is both slow and how the app ended up exceeding
 * React's update depth. The renderer reads the latest snapshot from the ref in
 * its own loop; React only re-renders when something a person can see changes.
 */
export function ViewerCanvas({
  snapshotRef,
  followId,
  onReady,
}: {
  snapshotRef: RefObject<ViewerSnapshot | undefined>;
  followId: string;
  onReady?: (viewer: DogfightViewer) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<DogfightViewer>(undefined);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    if (!host.current) return;
    const instance = new DogfightViewer(host.current);
    viewer.current = instance;
    let frame = 0;
    let disposed = false;

    void instance.loadAircraft().then(() => {
      if (disposed) return;
      ready.current?.(instance);
      const loop = () => {
        const snapshot = snapshotRef.current;
        if (snapshot) instance.render(snapshot);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      instance.dispose();
      viewer.current = undefined;
    };
  }, [snapshotRef]);

  useEffect(() => {
    viewer.current?.setFollow(followId);
  }, [followId]);

  return <div id="viewport" ref={host} />;
}
