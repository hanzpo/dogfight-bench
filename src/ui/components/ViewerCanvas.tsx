import { useEffect, useRef, type RefObject } from "react";
import { DogfightViewer, type ViewerSnapshot } from "../../viewer";

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
