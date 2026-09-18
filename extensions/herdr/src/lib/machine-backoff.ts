import { LocalStorage } from "@raycast/api";
import { HerdrError, getSnapshot } from "./herdr";
import type { SessionRef } from "./session-ref";
import type { HerdrSnapshot } from "./types";

const STORAGE_KEY = "machineBackoff";
/** Consecutive unreachable reads before a Machine is held back. */
const FAILURES_BEFORE_HOLD = 3;
/** How long a held-back Machine is left alone. */
const HOLD_MS = 60_000;

interface MachineFailures {
  /** Consecutive unreachable reads. */
  count: number;
  /** When the last one happened, in epoch milliseconds. */
  at: number;
  /** The last failure, so a held-back read can report it. */
  message: string;
  detail?: string;
}

/** Keyed by Machine id. Persisted, because every menu-bar tick is a fresh process. */
type FailureStore = Record<string, MachineFailures>;

async function readStore(): Promise<FailureStore> {
  const stored = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === "object" && parsed !== null ? (parsed as FailureStore) : {};
  } catch {
    return {};
  }
}

async function writeStore(store: FailureStore): Promise<void> {
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/** Forgets a Machine's run of failures: a user's retry always reads. */
export async function clearMachineBackoff(id: string): Promise<void> {
  const store = await readStore();
  if (!(id in store)) return;
  delete store[id];
  await writeStore(store);
}

/**
 * The Snapshot of `ref`, for the views' refresh ticks. Herdr's bridge does not
 * retry, and an unreachable Machine costs a chain of SSH connections, or the
 * whole command timeout, per attempt. After three unreachable reads in a row
 * the Machine is held back for a minute: the last failure is reported again
 * without spawning Herdr. A successful read clears the record; a Stopped
 * remote Session is a state, not a failure, and never counts. Actions never
 * come through here, so a user's command is always attempted.
 */
export async function getSnapshotWithBackoff(
  ref: SessionRef | undefined,
  signal?: AbortSignal,
): Promise<HerdrSnapshot> {
  if (!ref?.machine) return getSnapshot(signal, ref);
  const store = await readStore();
  const failures = store[ref.machine];
  if (failures && failures.count >= FAILURES_BEFORE_HOLD && Date.now() - failures.at < HOLD_MS) {
    throw new HerdrError(failures.message, "machine_unavailable", failures.detail, ref);
  }
  try {
    const snapshot = await getSnapshot(signal, ref);
    if (failures) await clearMachineBackoff(ref.machine);
    return snapshot;
  } catch (error) {
    if (error instanceof HerdrError && error.code === "machine_unavailable") {
      store[ref.machine] = {
        count: (failures?.count ?? 0) + 1,
        at: Date.now(),
        message: error.message,
        detail: error.detail,
      };
      await writeStore(store);
    }
    throw error;
  }
}
