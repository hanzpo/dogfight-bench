import type { ReactNode } from "react";
import type { Choice } from "../setup";

/**
 * A row of mutually exclusive options, as real radio buttons, so the browser
 * gives a screen reader the group and its choice and the arrow keys move
 * within it.
 */
export function ChoiceGroup<T extends string>({
  legend,
  name,
  choices,
  value,
  onChange,
  caption,
  children,
  variant = "pills",
}: {
  legend: string;
  name: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  /** A line under the options about the one chosen. */
  caption?: string;
  /** Anything else that belongs on the same row, after the options. */
  children?: ReactNode;
  /** Separate pills, or one joined control. */
  variant?: "pills" | "segmented";
}) {
  return (
    <fieldset className={`choice-group ${variant}`}>
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
        {children}
      </div>
      {caption ? (
        <p className="choice-caption" aria-live="polite">
          {caption}
        </p>
      ) : null}
    </fieldset>
  );
}
