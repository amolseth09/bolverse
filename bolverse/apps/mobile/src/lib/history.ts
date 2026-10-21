import { useCallback, useEffect, useState } from "react";
import { upsertThread, type Thread } from "@bolverse/shared";
import { clearThreads, loadThreads, saveThreads } from "./store";

/** Chat history kept only on this phone, separately for each account. */
export function useHistory(owner: string) {
  const [threads, setThreads] = useState<Thread[]>([]);
  useEffect(() => { loadThreads(owner).then(setThreads); }, [owner]);

  const save = useCallback((thread: Thread) => {
    // Read the latest stored list first, so two screens saving don't overwrite each other.
    void loadThreads(owner).then((list) => { const next = upsertThread(list, thread); saveThreads(owner, next); setThreads(next); });
  }, [owner]);
  const remove = useCallback((id: string) => {
    setThreads((list) => { const next = list.filter((t) => t.id !== id); saveThreads(owner, next); return next; });
  }, [owner]);
  const clear = useCallback(() => { clearThreads(owner); setThreads([]); }, [owner]);
  const reload = useCallback(() => { void loadThreads(owner).then(setThreads); }, [owner]);

  return { threads, save, remove, clear, reload };
}
