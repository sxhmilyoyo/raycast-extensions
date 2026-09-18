import { describe, expect, it, vi } from "vitest";
import { lookupHerdrClientTtys, lookupHerdrClients, lookupRemoteClients } from "../src/lib/process-lookup";

describe("lookupHerdrClientTtys", () => {
  it("returns an empty list only when pgrep confirms no process", async () => {
    const capture = vi.fn().mockRejectedValue({ code: 1 });

    await expect(lookupHerdrClientTtys("/opt/herdr", "default", 250, capture)).resolves.toEqual([]);
  });

  it("returns unavailable when pgrep times out", async () => {
    const capture = vi.fn().mockRejectedValue({ code: null, killed: true, signal: "SIGTERM" });

    await expect(lookupHerdrClientTtys("/opt/herdr", "default", 250, capture)).resolves.toBeUndefined();
  });

  it("returns unavailable when ps times out", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce("101")
      .mockRejectedValueOnce({ code: null, killed: true, signal: "SIGTERM" });

    await expect(lookupHerdrClientTtys("/opt/herdr", "default", 250, capture)).resolves.toBeUndefined();
  });

  it("returns TTYs for clients in the selected session", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce("101\n102")
      .mockResolvedValueOnce("101 900 ttys001 herdr\n102 900 ttys002 herdr --session work");

    await expect(lookupHerdrClientTtys("/opt/herdr", "work", 250, capture)).resolves.toEqual(["/dev/ttys002"]);
    expect(capture).toHaveBeenLastCalledWith("/bin/ps", ["-p", "101,102", "-o", "pid=,ppid=,tty=,args="], 250);
  });
});

describe("lookupHerdrClients", () => {
  it("returns pid and tty pairs for clients that name the session", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce("101\n102")
      .mockResolvedValueOnce("101 900 ttys001 herdr\n102 900 ttys002 herdr --session work");

    await expect(lookupHerdrClients("/opt/herdr", "work", 250, capture)).resolves.toEqual([
      { pid: "102", tty: "/dev/ttys002" },
    ]);
    expect(capture).toHaveBeenLastCalledWith("/bin/ps", ["-p", "101,102", "-o", "pid=,ppid=,tty=,args="], 250);
  });

  it("returns an empty list when pgrep confirms no process and unavailable when ps fails", async () => {
    await expect(
      lookupHerdrClients("/opt/herdr", "work", 250, vi.fn().mockRejectedValue({ code: 1 })),
    ).resolves.toEqual([]);
    const capture = vi.fn().mockResolvedValueOnce("101").mockRejectedValueOnce({ code: null, killed: true });
    await expect(lookupHerdrClients("/opt/herdr", "work", 250, capture)).resolves.toBeUndefined();
  });
});

// R3: the same two-step lookup finds a Machine's Remote Client, matched by the
// Machine's target and session rather than by a bare Session name.
describe("lookupRemoteClients", () => {
  it("returns the remote attach and the client child to signal", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce("101\n102")
      .mockResolvedValueOnce(
        "101 900 ttys041 herdr --remote clouddesk-arm --session meshclaw\n102 101 ttys041 /opt/herdr client",
      );

    await expect(lookupRemoteClients("/opt/herdr", "clouddesk-arm", "meshclaw", 250, capture)).resolves.toEqual([
      { pid: "101", tty: "/dev/ttys041", clientPid: "102" },
    ]);
  });

  it("is unavailable when the process list cannot be read, and empty when nothing runs", async () => {
    await expect(
      lookupRemoteClients("/opt/herdr", "host", "s", 250, vi.fn().mockRejectedValue({ code: 1 })),
    ).resolves.toEqual([]);
    const capture = vi.fn().mockResolvedValueOnce("101").mockRejectedValueOnce({ code: null, killed: true });
    await expect(lookupRemoteClients("/opt/herdr", "host", "s", 250, capture)).resolves.toBeUndefined();
  });
});
