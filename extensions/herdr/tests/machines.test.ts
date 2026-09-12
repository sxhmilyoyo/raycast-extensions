import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { duplicateMachineIds, findMachine, listMachines, sessionRefPresence } from "../src/lib/machines";
import type { Machine } from "../src/lib/types";
import { cddMeshclaw, remote } from "./helpers/machines";
import { storage } from "./helpers/raycast-api";

vi.mock("node:fs/promises", () => ({ access: vi.fn().mockResolvedValue(undefined) }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("@raycast/api", () => import("./helpers/raycast-api"));

const preferences: { herdrPath?: string; sessionName?: string } = {};
vi.mock("../src/lib/preferences", () => ({
  getHerdrPreferences: () => preferences,
}));

beforeEach(() => {
  preferences.herdrPath = "~/.local/bin/herdr";
  preferences.sessionName = "work";
  storage.clear();
  vi.mocked(execFile).mockReset();
});

function mockMachineList(stdout: string) {
  vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
    const callback = callArgs.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, stdout, "");
    return {};
  }) as never);
}

function executedArgs(): unknown {
  return vi.mocked(execFile).mock.calls[0][1];
}

describe("listMachines", () => {
  // The catalog is Herdr's and spans Sessions, so the call carries no --session
  // even while a Preferred Session is configured.
  it("reads Herdr's Machines without naming a Session", async () => {
    mockMachineList(JSON.stringify([cddMeshclaw]));

    await expect(listMachines()).resolves.toEqual([cddMeshclaw]);
    expect(executedArgs()).toEqual(["machine", "list", "--json"]);
  });

  it("returns no machines when none are saved", async () => {
    mockMachineList("[]\n");

    await expect(listMachines()).resolves.toEqual([]);
  });
});

describe("duplicateMachineIds", () => {
  // Herdr accepts two Machines for the same target and session. They are two
  // Machines, flagged so the user can tell them apart, never merged.
  it("flags every Machine that shares a target and session with another", () => {
    const twin: Machine = { ...cddMeshclaw, id: "0f3c1a9b7e2d4c6a8b1d3e5f7a9c2b4d", label: "cdd-meshclaw-2" };
    const other: Machine = { ...cddMeshclaw, id: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d", label: "cdd-default", session: "default" };

    expect(duplicateMachineIds([cddMeshclaw, twin, other])).toEqual(new Set([cddMeshclaw.id, twin.id]));
    expect(duplicateMachineIds([cddMeshclaw, other])).toEqual(new Set());
  });
});

// A Stopped Machine Session exists for as long as its Machine is saved; Herdr's
// `session list` speaks for the Local Host only, so it cannot say.
describe("sessionRefPresence", () => {
  const sessions = {
    data: [{ name: "tmp-a", default: false, running: false, session_dir: "/x", socket_path: "/x/s" }],
    isLoading: false,
  };
  const saved = { data: [cddMeshclaw], isLoading: false };
  const noMachines = { data: [] as Machine[], isLoading: false };
  const noList = { data: undefined, isLoading: false };

  it("answers for a Machine's Session from the machine list, not the session list", () => {
    expect(sessionRefPresence(remote, sessions, saved)).toBe("listed");
    expect(sessionRefPresence(remote, sessions, noMachines)).toBe("missing");
    expect(sessionRefPresence(remote, sessions, noList)).toBe("unknown");
  });

  // Only a settled, successful read is evidence: the hooks keep the previous
  // list while a refresh is in flight or after one fails, so a Machine removed
  // in the meantime would otherwise still read as listed.
  it("treats a refreshing or failed machine list as unknown even when it names the Machine", () => {
    expect(sessionRefPresence(remote, sessions, { data: [cddMeshclaw], isLoading: true })).toBe("unknown");
    expect(sessionRefPresence(remote, sessions, { ...saved, error: new Error("boom") })).toBe("unknown");
  });

  it("answers for a Local Host Session from the session list alone", () => {
    expect(sessionRefPresence({ name: "tmp-a" }, sessions, noList)).toBe("listed");
    expect(sessionRefPresence({ name: "meshclaw" }, sessions, saved)).toBe("missing");
    expect(sessionRefPresence({ name: "tmp-a" }, noList, saved)).toBe("unknown");
  });
});

describe("findMachine", () => {
  it("finds a Machine by its id and nothing by a label", () => {
    expect(findMachine([cddMeshclaw], cddMeshclaw.id)).toBe(cddMeshclaw);
    expect(findMachine([cddMeshclaw], "cdd-meshclaw")).toBeUndefined();
  });
});
