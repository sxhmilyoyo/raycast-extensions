import { useCallback, useEffect, useRef } from "react";
import { useCachedPromise } from "@raycast/utils";
import { clearMachineBackoff, getSnapshotWithBackoff } from "../lib/machine-backoff";
import { getRefreshIntervalMs } from "../lib/preferences";
import { sameSessionRef, type SessionRef } from "../lib/session-ref";
import { pinSession, resolveStoredSession } from "../lib/session-selection";
import type { HerdrSnapshot } from "../lib/types";

/** A Machine read is a chain of SSH connections, so it refreshes no faster than this. */
const MACHINE_REFRESH_FLOOR_MS = 5_000;

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
  // Aborting the in-flight snapshot when the Session changes keeps a slow
  // server's read from landing after the next Session's.
  const abortable = useRef<AbortController>(null);
  // A tick never interrupts a read: a Machine read can outlast the interval,
  // and restarting it on every tick would leave the view loading forever.
  const inFlight = useRef(false);
  // The ref is an argument rather than read inside the closure, so the cache is
  // keyed per Session, and the result carries the Session it is for.
  const result = useCachedPromise(
    async (target: SessionRef | undefined): Promise<SessionSnapshot> => {
      inFlight.current = true;
      try {
        return { ref: target, snapshot: await getSnapshotWithBackoff(target, abortable.current?.signal) };
      } finally {
        inFlight.current = false;
      }
    },
    [ref],
    { keepPreviousData: true, abortable, execute: ref !== undefined },
  );
  const interval = Math.max(getRefreshIntervalMs(), ref?.machine ? MACHINE_REFRESH_FLOOR_MS : 0);

  // Both halves refresh: without the selection, a command left open kept
  // targeting the Session it started with after the user selected another.
  useEffect(() => {
    const timer = setInterval(() => {
      if (inFlight.current) return;
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

  // A user's retry or refresh always reads: it lifts the hold that a run of
  // unreachable reads placed on the Machine, which the ticks above respect.
  const revalidate = useCallback(async () => {
    if (ref?.machine) await clearMachineBackoff(ref.machine);
    return result.revalidate();
  }, [ref, result.revalidate]);

  // A hook that is not executing reports itself as not loading, so the session
  // lookup carries both the loading state and its own failure: without it a
  // rejected lookup rendered an empty list with no error.
  const data = snapshotOfSession(result.data, ref);
  return {
    ...result,
    revalidate,
    data,
    ref,
    isLoading: selected.isLoading || result.isLoading || (ref !== undefined && data === undefined && !result.error),
    error: result.error ?? selected.error,
  };
}
