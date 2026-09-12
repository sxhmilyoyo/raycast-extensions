import { useCachedPromise } from "@raycast/utils";
import { listMachines } from "../lib/machines";
import { formatSessionRef, type SessionRef } from "../lib/session-ref";

/**
 * How a view titles `ref`. A Machine's label is looked up at render, never
 * stored, so the machine list is read only while a Machine is selected, and
 * only by the view commands that show a title: the menu bar spawns nothing
 * beyond its Snapshot (ADR-0002) and titles from the list it reads anyway.
 */
export function useSessionTitle(ref: SessionRef | undefined): string | undefined {
  const machines = useCachedPromise(listMachines, [], { execute: Boolean(ref?.machine), keepPreviousData: true });
  return ref ? formatSessionRef(ref, machines.data) : undefined;
}
