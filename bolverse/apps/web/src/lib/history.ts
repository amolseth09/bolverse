import { useCallback, useEffect, useState } from "react";
import { upsertThread, type Thread } from "@bolverse/shared";
import { clearThreads, loadThreads, saveThreads } from "./store";

/** Chat history kept only in this browser, separately for each account. */
export function useHistory(owner: string) {
  const [threads, setThreads] = useState<Thread[]>(() => loadThreads(owner));
  useEffect(() => { setThreads(loadThreads(owner)); }, [owner]);

  const save = useCallback((thread: Thread) => {
    setThreads((list) => { const next = upsertThread(list, thread); saveThreads(owner, next); return next; });
  }, [owner]);
  const remove = useCallback((id: string) => {
    setThreads((list) => { const next = list.filter((t) => t.id !== id); saveThreads(owner, next); return next; });
  }, [owner]);
  const clear = useCallback(() => { clearThreads(owner); setThreads([]); }, [owner]);

  return { threads, save, remove, clear };
}
