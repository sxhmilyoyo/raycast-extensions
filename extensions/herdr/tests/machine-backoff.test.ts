import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrError } from "../src/lib/herdr";
import { clearMachineBackoff, getSnapshotWithBackoff } from "../src/lib/machine-backoff";
import { remote } from "./helpers/machines";
import { storage } from "./helpers/raycast-api";

vi.mock("node:fs/promises", () => ({ access: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("@raycast/api", () => import("./helpers/raycast-api"));
vi.mock("../src/lib/preferences", () => ({
  getHerdrPreferences: () => ({ herdrPath: "~/.local/bin/herdr" }),
}));

const UNREACHABLE =
  "Error: Custom { kind: ConnectionAborted, error: \"machine 'cdd-meshclaw' (session meshclaw): remote SSH connection failed: ssh: connect to host clouddesk-arm port 22: Connection refused\" }\n";
const STOPPED =
  'Error: Custom { kind: ConnectionAborted, error: "machine \'cdd-meshclaw\' (session meshclaw): remote SSH connection failed: Error: Custom { kind: ConnectionRefused, error: \\"failed to connect to remote Herdr API socket /x/herdr.sock: Connection refused (os error 111)\\" }" }\n';
const SNAPSHOT = JSON.stringify({ result: { snapshot: { workspaces: [], tabs: [], panes: [], agents: [] } } });

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

function replyFailure(stderr: string) {
  vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
    (callArgs.at(-1) as Callback)(Object.assign(new Error("Command failed"), { code: 1 }), "", stderr);
    return {};
  }) as never);
}

function replySnapshot() {
  vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
    (callArgs.at(-1) as Callback)(null, SNAPSHOT, "");
    return {};
  }) as never);
}

async function failedRead(): Promise<unknown> {
  return getSnapshotWithBackoff(remote).catch((error: unknown) => error);
}

const START = new Date("2026-09-17T20:00:00Z");

beforeEach(() => {
  storage.clear();
  vi.mocked(access).mockReset().mockResolvedValue();
  vi.mocked(execFile).mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

// Herdr's bridge does not retry, each menu-bar tick is a fresh process, and an
// unreachable Machine costs a full SSH round trip, or the whole command
// timeout, per attempt. After three unreachable reads in a row the Machine is
// left alone for a minute: the last failure is reported without spawning Herdr.
describe("getSnapshotWithBackoff", () => {
  it("reads a Local Host Session every time", async () => {
    replyFailure('Error: Os { code: 61, kind: ConnectionRefused, message: "Connection refused" }\n');

    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(getSnapshotWithBackoff({ name: "tmp-b" })).rejects.toMatchObject({ code: "session_not_running" });
      expect(execFile).toHaveBeenCalledTimes(attempt);
    }
  });

  it("keeps reading a Machine through its first failures, then holds it back after the third", async () => {
    replyFailure(UNREACHABLE);

    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await failedRead()).toMatchObject({ code: "machine_unavailable" });
      expect(execFile).toHaveBeenCalledTimes(attempt);
    }

    const held = await failedRead();
    expect(held).toBeInstanceOf(HerdrError);
    expect(held).toMatchObject({ code: "machine_unavailable", session: remote });
    expect((held as HerdrError).detail).toContain("Connection refused");
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it("reads again once the hold expires, and a successful read clears the record", async () => {
    replyFailure(UNREACHABLE);
    for (let attempt = 1; attempt <= 3; attempt++) await failedRead();
    vi.setSystemTime(START.getTime() + 60_001);
    replySnapshot();

    await expect(getSnapshotWithBackoff(remote)).resolves.toMatchObject({ agents: [] });
    expect(execFile).toHaveBeenCalledTimes(4);

    // The record is gone: a fresh run of failures starts counting from one.
    replyFailure(UNREACHABLE);
    await failedRead();
    await failedRead();
    expect(execFile).toHaveBeenCalledTimes(6);
  });

  it("holds back again when the read after an expired hold fails", async () => {
    replyFailure(UNREACHABLE);
    for (let attempt = 1; attempt <= 3; attempt++) await failedRead();
    vi.setSystemTime(START.getTime() + 60_001);

    await failedRead();
    expect(execFile).toHaveBeenCalledTimes(4);
    await failedRead();
    expect(execFile).toHaveBeenCalledTimes(4);
  });

  // A Stopped remote Session is a state, not an unreachable Machine, and the
  // Stopped view needs every tick to notice the server coming back.
  it("counts only unreachable failures", async () => {
    replyFailure(STOPPED);

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await failedRead()).toMatchObject({ code: "session_not_running" });
      expect(execFile).toHaveBeenCalledTimes(attempt);
    }
  });

  it("lets a user's retry through by clearing the hold", async () => {
    replyFailure(UNREACHABLE);
    for (let attempt = 1; attempt <= 3; attempt++) await failedRead();
    await failedRead();
    expect(execFile).toHaveBeenCalledTimes(3);

    await clearMachineBackoff(remote.machine);

    await failedRead();
    expect(execFile).toHaveBeenCalledTimes(4);
  });
});
