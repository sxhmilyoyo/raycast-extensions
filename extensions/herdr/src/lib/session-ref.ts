import type { Machine } from "./types";

/**
 * What identifies a Session to the extension: a Local Host Session by name, or
 * a Machine, whose remote Session name is kept for display and Remote Attach.
 */
export interface SessionRef {
  /** The id of a Machine. Never an empty string. */
  machine?: string;
  name: string;
}

/**
 * A key for caches and lists, never for people. A Machine's remote Session may
 * share its name with a Local Host Session, and two Machines may name the same
 * remote Session, so only the Machine's id keeps the rows apart.
 */
export function sessionRefKey(ref: SessionRef): string {
  return ref.machine ? `machine:${ref.machine}` : ref.name;
}

/** The ref that selects a Machine's Session. */
export function machineSessionRef(machine: Machine): SessionRef {
  return { machine: machine.id, name: machine.session };
}

/** The first eight characters of a Machine id, for text that has no label to show. */
export function shortMachineId(id: string): string {
  return id.slice(0, 8);
}

/**
 * How titles and toasts name a Session. Labels rename freely, so a Machine's
 * label is resolved at render from the list, never stored; without the list,
 * the short id stands in.
 */
export function formatSessionRef(ref: SessionRef, machines?: Machine[]): string {
  if (!ref.machine) return ref.name;
  const label = machines?.find((machine) => machine.id === ref.machine)?.label;
  return `${ref.name} on ${label ?? `machine ${shortMachineId(ref.machine)}`}`;
}

/** Whether two refs name the same Session: the same Machine, or both the Local Host, and the same name. */
export function sameSessionRef(a: SessionRef | undefined, b: SessionRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.machine === b.machine && a.name === b.name;
}

const STORAGE_VERSION = 2;
/**
 * The previous form named a Local Host Session the same way, and could carry
 * an SSH host that no Machine corresponds to.
 */
const PREVIOUS_STORAGE_VERSION = 1;

/** The stored form of a ref, versioned so a later shape can be told from this one. */
export function serializeSessionRef(ref: SessionRef): string {
  return JSON.stringify({ v: STORAGE_VERSION, ...ref });
}

/**
 * A ref from its stored form, or nothing for anything this version cannot
 * read. Nothing means no selection, which falls back to the Preferred Session;
 * guessing at a Machine, or at the Local Host, would target a Session the user
 * never chose.
 */
export function parseSessionRef(stored: unknown): SessionRef | undefined {
  if (typeof stored !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { v, machine, host, name } = parsed as { v?: unknown; machine?: unknown; host?: unknown; name?: unknown };
  if (typeof name !== "string" || !name) return undefined;
  if (v === PREVIOUS_STORAGE_VERSION) return host === undefined ? { name } : undefined;
  if (v !== STORAGE_VERSION) return undefined;
  if (machine === undefined) return { name };
  return typeof machine === "string" && machine ? { machine, name } : undefined;
}
