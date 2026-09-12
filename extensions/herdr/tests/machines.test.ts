import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  duplicateMachineIds,
  findMachine,
  listMachines,
  removeMachine,
  sessionRefPresence,
  setMachineEnabled,
} from "../src/lib/machines";
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

function mockHerdrOutput(stdout: string) {
  vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
    const callback = callArgs.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, stdout, "");
    return {};
  }) as never);
}

function mockHerdrFailure(stderr: string, code: number) {
  vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
    const callback = callArgs.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(Object.assign(new Error("Command failed"), { code }), "", stderr);
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
    mockHerdrOutput(JSON.stringify([cddMeshclaw]));

    await expect(listMachines()).resolves.toEqual([cddMeshclaw]);
    expect(executedArgs()).toEqual(["machine", "list", "--json"]);
  });

  it("returns no machines when none are saved", async () => {
    mockHerdrOutput("[]\n");

    await expect(listMachines()).resolves.toEqual([]);
  });

  // Herdr before 0.9 has no `machine` command at all: a Herdr with no Machines,
  // not a failed listing, so Manage Sessions stays as it was.
  it("treats a Herdr without the machine command as having no Machines", async () => {
    mockHerdrFailure("unknown command: machine\nrun 'herdr --help' for usage\n", 2);

    await expect(listMachines()).resolves.toEqual([]);
  });

  it("reports any other listing failure", async () => {
    mockHerdrFailure("error: the saved-machine file could not be read\n", 1);

    await expect(listMachines()).rejects.toMatchObject({ code: "command_failed" });
  });
});

// Machine management is Herdr's own `machine` command family, run on the Local
// Host: it is never routed through --machine, and it names no Session.
describe("machine management", () => {
  it("disables and enables a Machine by id", async () => {
    mockHerdrOutput("");

    await setMachineEnabled(cddMeshclaw.id, false);
    expect(executedArgs()).toEqual(["machine", "disable", cddMeshclaw.id]);

    vi.mocked(execFile).mockClear();
    await setMachineEnabled(cddMeshclaw.id, true);
    expect(executedArgs()).toEqual(["machine", "enable", cddMeshclaw.id]);
  });

  it("removes a Machine by id", async () => {
    mockHerdrOutput("");

    await removeMachine(cddMeshclaw.id);
    expect(executedArgs()).toEqual(["machine", "remove", cddMeshclaw.id]);
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
