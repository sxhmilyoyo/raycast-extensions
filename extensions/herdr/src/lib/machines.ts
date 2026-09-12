import {
  HerdrError,
  runHerdr,
  runHerdrJson,
  sessionPresence,
  type SessionListState,
  type SessionPresence,
} from "./herdr";
import { shortMachineId, type SessionRef } from "./session-ref";
import type { Machine } from "./types";

/**
 * Herdr's Machines. The catalog is Herdr's own and spans Sessions, so the call
 * opts out of the --session flag.
 */
export async function listMachines(): Promise<Machine[]> {
  try {
    const rows = await runHerdrJson<Machine[]>(["machine", "list", "--json"], { ref: { name: "" } });
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    // Herdr before 0.9 has no `machine` command at all: a Herdr with no
    // Machines, not a failed listing.
    if (isUnknownCommand(error)) return [];
    throw error;
  }
}

function isUnknownCommand(error: unknown): boolean {
  return (
    error instanceof HerdrError &&
    error.code === "command_failed" &&
    /\bunknown command: machine\b/.test(error.detail ?? "")
  );
}

/**
 * The ids of every Machine that shares its target and session with another.
 * Herdr accepts the pair, so they are flagged for the user, never merged.
 */
export function duplicateMachineIds(machines: Machine[]): Set<string> {
  const idsByRemote = new Map<string, string[]>();
  for (const machine of machines) {
    const remote = `${machine.target}\n${machine.session}`;
    idsByRemote.set(remote, [...(idsByRemote.get(remote) ?? []), machine.id]);
  }
  return new Set([...idsByRemote.values()].filter((ids) => ids.length > 1).flat());
}

/**
 * Enables or disables a Machine: Herdr's own `machine enable|disable <id>`,
 * run on the Local Host. Disabling keeps the Machine for later.
 */
export async function setMachineEnabled(id: string, enabled: boolean): Promise<void> {
  await runHerdr(["machine", enabled ? "enable" : "disable", id], { ref: { name: "" } });
}

/** Forgets a Machine with Herdr's `machine remove <id>`. The server on its Remote Host, and its Session, keep running. */
export async function removeMachine(id: string): Promise<void> {
  await runHerdr(["machine", "remove", id], { ref: { name: "" } });
}

/** The Machine with `id`, if it is still saved. Labels rename freely, so lookups go by id. */
export function findMachine(machines: Machine[], id: string): Machine | undefined {
  return machines.find((machine) => machine.id === id);
}

/** The Machine with `id`, or a failure that says it is gone: a Session Ref may outlive its Machine. */
export async function requireMachine(id: string): Promise<Machine> {
  const machine = findMachine(await listMachines(), id);
  if (machine) return machine;
  throw new HerdrError(
    `Machine ${shortMachineId(id)} is no longer saved in Herdr`,
    "machine_unknown",
    "Choose another session for Raycast to control, or add the Machine again with `herdr machine add`.",
  );
}

/** The state of a `machine list` read, as the cached-promise hooks report it. */
export interface MachineListState {
  data?: Machine[];
  isLoading: boolean;
  error?: unknown;
}

/**
 * Whether the Session `ref` names still exists, for the Stopped views. Herdr
 * reports a missing Session exactly like a Stopped one, and `session list`
 * speaks for the Local Host only, so a Machine's Session exists for as long as
 * its Machine is saved. Only a settled, successful listing is evidence: the
 * hooks keep the previous list while a refresh is in flight or after one
 * fails, so a Machine removed in the meantime would otherwise still read as
 * listed. Anything else is unknown, and unknown never earns a start.
 */
export function sessionRefPresence(
  ref: SessionRef,
  sessions: SessionListState,
  machines: MachineListState,
): SessionPresence {
  if (!ref.machine) return sessionPresence(sessions, ref.name);
  if (machines.isLoading || machines.error !== undefined || machines.data === undefined) return "unknown";
  return findMachine(machines.data, ref.machine) ? "listed" : "missing";
}
