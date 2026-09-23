import { useId } from "react";
import type { Choice } from "../setup";

/**
 * A row of mutually exclusive options, as real radio buttons.
 *
 * Radios rather than a row of toggle buttons because the browser then gives
 * a screen reader the group and its choice, and the arrow keys move within
 * it, without any of that being rebuilt here.
 */
export function ChoiceGroup<T extends string>({
  legend,
  name,
  choices,
  value,
  onChange,
  showDetail = true,
}: {
  legend: string;
  name: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Off where the choices speak for themselves. */
  showDetail?: boolean;
}) {
  const detailId = useId();
  const selected = choices.find((choice) => choice.value === value);
  return (
    <fieldset className="choice-group" aria-describedby={showDetail ? detailId : undefined}>
      <legend>{legend}</legend>
      <div className="choice-options">
        {choices.map((choice) => (
          <label key={choice.value} className="choice">
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={choice.value === value}
              onChange={() => onChange(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
      {showDetail ? (
        <p id={detailId} className="choice-detail">
          {selected?.detail}
        </p>
      ) : null}
    </fieldset>
  );
}
