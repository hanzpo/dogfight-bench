import { useState } from "react";
import type { AgentRow } from "../api";
import { clearKey, loadKey, maskKey, saveKey, type KeyScope } from "../keys";

const DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  jev: "Jev",
};

export function ModelKeysPanel({
  agents,
  onClose,
  onChanged,
}: {
  agents: AgentRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const keyed = agents.filter((agent) => agent.acceptsCallerKey);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>Model keys</h2>
            <p>
              Keys are sent to this site's own server, used for a single request and discarded. They are
              never written to the database and never logged.
            </p>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {keyed.length === 0 ? (
          <p className="muted">This deployment does not accept caller-supplied keys.</p>
        ) : (
          keyed.map((agent) => <KeyRow key={agent.kind} agent={agent} onChanged={onChanged} />)
        )}
      </section>
    </div>
  );
}

function KeyRow({ agent, onChanged }: { agent: AgentRow; onChanged: () => void }) {
  const existing = loadKey(agent.kind);
  const [value, setValue] = useState("");
  const [model, setModel] = useState(existing?.model ?? "");
  const [scope, setScope] = useState<KeyScope>(existing?.scope ?? "session");
  const [editing, setEditing] = useState(!existing);

  const save = () => {
    saveKey(agent.kind, value, scope, model);
    setValue("");
    setEditing(false);
    onChanged();
  };

  const remove = () => {
    clearKey(agent.kind);
    setEditing(true);
    onChanged();
  };

  return (
    <div className="key-row">
      <div className="key-row-head">
        <span className="key-provider">{DISPLAY_NAMES[agent.provider] ?? agent.provider}</span>
        <span className="muted">{agent.model}</span>
        {agent.free ? <span className="badge">free here</span> : null}
      </div>

      {existing && !editing ? (
        <div className="key-saved">
          <code>{maskKey(existing.key)}</code>
          <span className="muted">{existing.scope === "local" ? "remembered" : "this tab only"}</span>
          <button className="ghost" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button className="ghost danger" onClick={remove}>
            Remove
          </button>
        </div>
      ) : (
        <>
          <label className="field">
            <span>API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={agent.kind === "anthropic" ? "sk-ant-…" : "sk-…"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <label className="field">
            <span>
              Model <span className="muted">optional</span>
            </span>
            <input
              autoComplete="off"
              spellCheck={false}
              placeholder={agent.model}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <fieldset className="scope">
            <label>
              <input
                type="radio"
                name={`scope-${agent.kind}`}
                checked={scope === "session"}
                onChange={() => setScope("session")}
              />
              <span>
                This tab only <span className="muted">forgotten when the tab closes</span>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name={`scope-${agent.kind}`}
                checked={scope === "local"}
                onChange={() => setScope("local")}
              />
              <span>
                Remember on this device{" "}
                <span className="muted">survives restarts; readable by anything running on this origin</span>
              </span>
            </label>
          </fieldset>
          <div className="key-actions">
            <button className="primary" disabled={!value.trim()} onClick={save}>
              Save key
            </button>
            {existing ? (
              <button className="ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
