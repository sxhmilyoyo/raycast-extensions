import { useEffect, useRef } from "react";
import { useCachedPromise } from "@raycast/utils";
import { getSnapshot } from "../lib/herdr";
import { getRefreshIntervalMs } from "../lib/preferences";
import { sameSessionRef, type SessionRef } from "../lib/session-ref";
import { pinSession, resolveStoredSession } from "../lib/session-selection";
import type { HerdrSnapshot } from "../lib/types";

/**
 * The Session every command resolves to. Read from persisted state rather than
 * through resolveSessionRef: that would return this view's own pin first, and
 * the view could never notice a selection made in another command.
 */
export function useSelectedSession() {
  return useCachedPromise(() => resolveStoredSession(), [], { keepPreviousData: true });
}

interface SessionSnapshot {
  ref?: SessionRef;
  snapshot: HerdrSnapshot;
}

/**
 * The Snapshot only when it belongs to `ref`. The cache keeps the previous
 * Session's data while the next one loads, and rendering that as if it were this
 * Session showed one Session's resources under another Session's name.
 */
export function snapshotOfSession(data: SessionSnapshot | undefined, ref?: SessionRef): HerdrSnapshot | undefined {
  return data && sameSessionRef(data.ref, ref) ? data.snapshot : undefined;
}

export function useHerdrSnapshot() {
  const selected = useSelectedSession();
  const ref = selected.data;
  // Aborting the in-flight snapshot on revalidate keeps refresh ticks from
  // stacking subprocesses behind a slow server.
  const abortable = useRef<AbortController>(null);
  // The ref is an argument rather than read inside the closure, so the cache is
  // keyed per Session, and the result carries the Session it is for.
  const result = useCachedPromise(
    async (target: SessionRef | undefined): Promise<SessionSnapshot> => ({
      ref: target,
      snapshot: await getSnapshot(abortable.current?.signal, target),
    }),
    [ref],
    { keepPreviousData: true, abortable, execute: ref !== undefined },
  );
  const interval = getRefreshIntervalMs();

  // Both halves refresh: without the selection, a command left open kept
  // targeting the Session it started with after the user selected another.
  useEffect(() => {
    const timer = setInterval(() => {
      void selected.revalidate();
      void result.revalidate();
    }, interval);
    return () => clearInterval(timer);
  }, [interval, result.revalidate, selected.revalidate]);

  // Actions resolve the Session themselves, so the view pins what it displays:
  // otherwise a selection made elsewhere would retarget them mid-view.
  useEffect(() => {
    if (ref === undefined) return;
    return pinSession(ref);
  }, [ref]);

  // A hook that is not executing reports itself as not loading, so the session
  // lookup carries both the loading state and its own failure: without it a
  // rejected lookup rendered an empty list with no error.
  const data = snapshotOfSession(result.data, ref);
  return {
    ...result,
    data,
    ref,
    isLoading: selected.isLoading || result.isLoading || (ref !== undefined && data === undefined && !result.error),
    error: result.error ?? selected.error,
  };
}
