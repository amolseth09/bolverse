import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  ApiError, LOADING_ACCOUNT, paywallReasonFor, tokensFrom, type Account, type BolverseApi, type PaywallReason,
  type SessionStore, type SignedIn,
} from "@bolverse/shared";
import { Paywall } from "../components/Paywall";
import { errorText } from "./api";

interface AccountCtx {
  account: Account;
  ready: boolean;              // first answer from the server received
  offline: string;             // why the server couldn't be reached ("" when fine)
  refresh: () => Promise<Account | null>;
  signIn: (result: SignedIn) => void;
  signOut: () => Promise<void>;
  openPaywall: (reason: PaywallReason) => void;
  /** The login screen, opened from the paywall, Connect or Profile while using Bolverse as a guest. */
  loginOpen: boolean;
  openLogin: (then?: PaywallReason) => void;
  closeLogin: () => void;
  /** Opens the paywall when the free translations are used up, the login when needed. True when handled. */
  handleError: (e: unknown) => boolean;
}

const Ctx = createContext<AccountCtx | null>(null);

export function useAccount(): AccountCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("AccountProvider missing");
  return v;
}

export function AccountProvider({ api, session, children }: { api: BolverseApi; session: SessionStore; children: ReactNode }) {
  const [account, setAccount] = useState<Account>(LOADING_ACCOUNT);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState("");
  const [paywall, setPaywall] = useState<PaywallReason | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [afterLogin, setAfterLogin] = useState<PaywallReason | null>(null);

  const refresh = useCallback(async () => {
    try {
      const a = await api.me();
      setAccount(a); setOffline("");
      return a;
    } catch (e) {
      if (e instanceof ApiError && e.code === "session_expired") session.set(null);
      else setOffline(errorText(e));
      return null;
    } finally {
      setReady(true);
    }
  }, [api, session]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Signed out elsewhere (refresh refused, another tab logged out): show the guest view.
  useEffect(() => session.subscribe((t) => { if (!t) void refresh(); }), [session, refresh]);

  const value: AccountCtx = {
    account, ready, offline, refresh, loginOpen,
    signIn(result) {
      session.set(tokensFrom(result));
      setAccount(result.account);
      setLoginOpen(false);
      if (afterLogin && result.account.plan !== "premium") setPaywall(afterLogin);
      setAfterLogin(null);
    },
    async signOut() {
      try { await api.logout(); } catch { /* already signed out */ }
      session.set(null);
    },
    openPaywall: (reason) => setPaywall(reason),
    openLogin(then) { setPaywall(null); setAfterLogin(then ?? null); setLoginOpen(true); },
    closeLogin() { setLoginOpen(false); setAfterLogin(null); },
    handleError(e) {
      if (!(e instanceof ApiError)) return false;
      if (e.code === "session_expired") { session.set(null); return true; }
      if (e.code === "login_required") { setLoginOpen(true); return true; }
      const reason = paywallReasonFor(e.code);
      if (reason) { void refresh(); setPaywall(reason); return true; }
      return false;
    },
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {paywall && <Paywall reason={paywall} onClose={() => setPaywall(null)} />}
    </Ctx.Provider>
  );
}
