import type { Loadout } from "../../sim/types";
import type { ControlScheme } from "../input/pilot-input";
import { BINDINGS, GAME_KEYS } from "../setup";
import { Dialog, KeyList } from "./Dialog";

export function IntroModal({
  open,
  scheme,
  weapons,
  onClose,
}: {
  open: boolean;
  scheme: ControlScheme;
  weapons: Loadout;
  onClose: () => void;
}) {
  const bindings = BINDINGS[scheme].filter(
    (binding) => weapons === "fox2" || !/missile|flares/i.test(binding.action),
  );
  return (
    <Dialog open={open} onClose={onClose} title="How to play" description="Shoot down the red F-16." className="intro">
      <ul className="tips">
        <li>Hard turns bleed speed. Stay near 350 knots.</li>
        <li>Aim the gunsight ahead of the target. It turns green when you&rsquo;ll hit.</li>
        {weapons === "fox2" ? <li>Missile inbound: turn toward it, throttle back, drop flares.</li> : null}
      </ul>
      <KeyList bindings={[...bindings, ...GAME_KEYS]} />
      <div className="dialog-actions">
        <button className="primary large" onClick={onClose} autoFocus>
          Start
        </button>
      </div>
    </Dialog>
  );
}
