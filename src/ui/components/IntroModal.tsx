import type { ControlScheme } from "../input/pilot-input";
import { BINDINGS, GAME_KEYS, SCHEMES } from "../setup";
import { Dialog, KeyList } from "./Dialog";

const TIPS = [
  {
    title: "Speed is life",
    body: "Pulling hard turns you fast but bleeds speed. Keep the jet near 350 knots and you can always turn again.",
  },
  {
    title: "Lead your shots",
    body: "Put the gunsight circle ahead of the bandit, not on it. It turns green when a burst will hit.",
  },
  {
    title: "Heat-seekers want your tailpipe",
    body: "If a missile is coming, turn hard toward it, pull the throttle back and drop flares.",
  },
];

export function IntroModal({
  open,
  scheme,
  onClose,
}: {
  open: boolean;
  scheme: ControlScheme;
  onClose: () => void;
}) {
  const schemeLabel = SCHEMES.find((choice) => choice.value === scheme)?.label ?? "Keyboard";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Before you take off"
      description="You fly the blue F-16. Shoot down the red one before it gets you. Whoever runs out of luck first loses."
      className="intro"
    >
      <ol className="tips">
        {TIPS.map((tip) => (
          <li key={tip.title}>
            <strong>{tip.title}</strong>
            <span>{tip.body}</span>
          </li>
        ))}
      </ol>

      <h3 className="dialog-subtitle">{schemeLabel} controls</h3>
      <KeyList bindings={[...BINDINGS[scheme], ...GAME_KEYS]} />

      <div className="dialog-actions">
        <button className="primary large" onClick={onClose} autoFocus>
          Take off
        </button>
      </div>
    </Dialog>
  );
}
