import { useState } from "react";
import { signInAsGuest, signInWith } from "../auth";
import { useAccount } from "../hooks/useAccount";

/**
 * Signing in, and what it is for.
 *
 * Deliberately not a wall. Everything on this site works signed out: the
 * simulator, the baselines, the free model. An account buys two things and the
 * panel says so rather than demanding one and explaining nothing -- a result
 * that counts on the leaderboard, and replays that are kept and can be watched
 * again.
 */
export function AccountMenu() {
  const account = useAccount();
  const [open, setOpen] = useState(false);

  if (!account.configured) return null;
  if (account.loading) return <span className="account-chip muted">…</span>;

  if (account.user) {
    return (
      <div className="account">
        <button className="account-chip" onClick={() => setOpen(!open)}>
          {account.displayName}
          {/* A guest's display name is already "Guest"; badging it too reads as
              "Guest guest". */}
          {account.isGuest ? null : <span className="badge">signed in</span>}
        </button>
        {open ? (
          <div className="account-menu">
            {account.isGuest ? (
              <>
                <p className="muted">
                  Flying as a guest. Your matches are rated and your replays are kept, but you are not listed on the
                  leaderboard until you attach an account.
                </p>
                <SignInButtons onDone={() => setOpen(false)} />
                <hr />
              </>
            ) : null}
            <button
              className="ghost"
              onClick={() => {
                void account.signOut();
                setOpen(false);
              }}
            >
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="account">
      <button className="account-chip" onClick={() => setOpen(!open)}>
        Sign in
      </button>
      {open ? (
        <div className="account-menu">
          <p className="muted">
            Optional. Everything here works signed out; an account records your results on the leaderboard and keeps
            your replays.
          </p>
          <SignInButtons onDone={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

function SignInButtons({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(undefined);
    const failure = await action();
    setBusy(false);
    if (failure) setError(failure);
    else onDone();
  };

  return (
    <>
      <div className="account-actions">
        <button disabled={busy} onClick={() => void run(() => signInWith("google"))}>
          Continue with Google
        </button>
        <button disabled={busy} onClick={() => void run(() => signInWith("github"))}>
          Continue with GitHub
        </button>
        <button className="ghost" disabled={busy} onClick={() => void run(signInAsGuest)}>
          Play as a guest
        </button>
      </div>
      {error ? <p className="account-error">{error}</p> : null}
    </>
  );
}
