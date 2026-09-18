import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSelectedSession } from "../src/lib/session-selection";
import {
  attachInTerminal,
  focusExistingHerdrClient,
  launchHerdrInTerminal,
  locateTerminalPaneClients,
} from "../src/lib/terminal";
import { cddMeshclaw, remote } from "./helpers/machines";
import { storage } from "./helpers/raycast-api";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("@raycast/api", () => import("./helpers/raycast-api"));
vi.mock("node:fs/promises", () => ({
  access: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

const preferences: {
  herdrPath?: string;
  sessionName?: string;
  customTerminalLauncher?: string;
  terminalApplication?: { bundleId: string; name: string; path: string };
} = {};
vi.mock("../src/lib/preferences", () => ({
  getHerdrPreferences: () => preferences,
}));

const binary = join(homedir(), ".local", "bin", "herdr");

beforeEach(() => {
  preferences.herdrPath = "~/.local/bin/herdr";
  preferences.sessionName = undefined;
  preferences.customTerminalLauncher = "term -e {herdr} {args}";
  preferences.terminalApplication = undefined;
  storage.clear();
  execCalls.length = 0;
  vi.mocked(execFile).mockReset();
  vi.mocked(spawn).mockReset();
  const child = {
    once(event: string, callback: () => void) {
      if (event === "spawn") callback();
      return child;
    },
    unref() {},
  };
  vi.mocked(spawn).mockReturnValue(child as never);
});

function spawnedArgs(): unknown {
  return vi.mocked(spawn).mock.calls[0][1];
}

const execCalls: Array<{ path: string; args: string[] }> = [];

// execFile is called as (path, args, options, callback) throughout terminal.ts.
function mockExecFile(respond: (path: string, args: string[]) => string) {
  vi.mocked(execFile).mockImplementation(((
    path: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execCalls.push({ path, args });
    callback(null, respond(path, args), "");
    return {};
  }) as never);
}

describe("launchHerdrInTerminal", () => {
  // Regression: the launched client inherits the Raycast process environment,
  // and without a --session flag the CLI falls back to an inherited
  // HERDR_SESSION, so an unset preference must still name the default session.
  it("names the default session explicitly when no session is configured", async () => {
    await launchHerdrInTerminal();
    expect(spawnedArgs()).toEqual(["-e", binary, "--session", "default"]);
  });

  it("names the configured session explicitly", async () => {
    preferences.sessionName = "work";

    await launchHerdrInTerminal();
    expect(spawnedArgs()).toEqual(["-e", binary, "--session", "work"]);
  });

  it("omits the session flag when the caller opts out with its own argv", async () => {
    await expect(launchHerdrInTerminal(["session", "attach", "review"], { includeSession: false })).resolves.toEqual(
      {},
    );
    expect(spawnedArgs()).toEqual(["-e", binary, "session", "attach", "review"]);
  });

  it("launches the Selected Session ahead of the configured session", async () => {
    storage.set("selectedSession", "tmp-b");
    preferences.sessionName = "work";

    await launchHerdrInTerminal();
    expect(spawnedArgs()).toEqual(["-e", binary, "--session", "tmp-b"]);
  });
});

// Remote Attach: a Machine's Session is attached with `--remote <target>
// --session <session>`, taken from the Machine Herdr has saved. The Client runs
// on the Local Host and streams the remote server's UI. Naming the Session with
// --session alone would start a Local Host Session of that name.
describe("Remote Attach for a Machine", () => {
  const remoteAttach = ["-e", binary, "--remote", "clouddesk-arm", "--session", "meshclaw"];

  it("launches the Selected Machine's Session by Remote Attach", async () => {
    await setSelectedSession(remote);
    mockExecFile(() => JSON.stringify([cddMeshclaw]));

    await launchHerdrInTerminal();
    expect(spawnedArgs()).toEqual(remoteAttach);
  });

  it("attaches a Machine by Remote Attach whatever the selection", async () => {
    await setSelectedSession({ name: "tmp-b" });
    mockExecFile(() => JSON.stringify([cddMeshclaw]));

    await attachInTerminal(remote);
    expect(spawnedArgs()).toEqual(remoteAttach);
  });

  // Herdr's --remote runs the plain client only: `herdr --remote … agent attach`
  // is rejected before anything runs, yet the Terminal Pane would open on the
  // error while Raycast reported the terminal opened.
  it("refuses to run a subcommand inside a Remote Attach", async () => {
    await setSelectedSession(remote);
    mockExecFile(() => JSON.stringify([cddMeshclaw]));

    await expect(launchHerdrInTerminal(["agent", "attach", "w1:p1"])).rejects.toMatchObject({
      code: "machine_command_unavailable",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  // A Machine that is no longer saved has no target to attach through.
  it("refuses a Machine that is not in Herdr's list", async () => {
    mockExecFile(() => "[]");

    await expect(attachInTerminal(remote)).rejects.toMatchObject({ code: "machine_unknown" });
    expect(spawn).not.toHaveBeenCalled();
  });
});

// R3. A Machine's Client is its Remote Attach, matched in the process table by
// the Machine's target and session rather than by a Session name: a Local Host
// Session may carry the same name, and the remote attach carries the target.
describe("client lookups for a Machine", () => {
  // The Remote Attach owns the Terminal Pane, and its `herdr client` child draws
  // the remote UI on the same tty.
  const remoteAttach = `48369 900 ttys041 ${binary} --remote clouddesk-arm --session meshclaw`;
  const remoteChild = `48678 48369 ttys041 ${binary} client`;
  const localSameName = `23895 900 ttys001 ${binary} session attach meshclaw`;

  function mockProcesses(rows: string[], onScript?: (script: string) => string) {
    mockExecFile((path, args) => {
      if (path.endsWith("pgrep")) return rows.map((row) => row.split(" ")[0]).join("\n");
      if (path === "/bin/ps") return rows.join("\n");
      if (path === binary && args[0] === "machine") return JSON.stringify([cddMeshclaw]);
      if (path === "/usr/bin/osascript") return onScript ? onScript(args[1]) : "";
      return "";
    });
  }

  it("reveals the Remote Attach that shows the Machine's Session", async () => {
    mockProcesses([remoteAttach, remoteChild, localSameName], (script) =>
      script.includes("/dev/ttys041") ? "/dev/ttys041" : "miss",
    );

    await expect(focusExistingHerdrClient(remote)).resolves.toBe("focused");
  });

  it("does not reveal a Local Host Session that shares the Machine's session name", async () => {
    mockProcesses([localSameName], () => "miss");

    await expect(focusExistingHerdrClient(remote)).resolves.toBe("missing");
  });

  it("locates the Remote Attach in a Terminal Pane and names the client child to signal", async () => {
    mockProcesses([remoteAttach, remoteChild, localSameName], () => "/dev/ttys041, /dev/ttys001");

    const location = await locateTerminalPaneClients(remote);
    expect(location).toMatchObject({ status: "found" });
    expect(location.status === "found" && location.clients).toEqual([
      { pid: "48369", tty: "/dev/ttys041", signalPid: "48678", windowId: undefined, paneId: undefined },
    ]);
  });

  // A Machine that is no longer saved has no target to match a Client by.
  it("refuses to locate the Clients of a Machine Herdr no longer has", async () => {
    mockExecFile((path) => (path.endsWith("pgrep") ? "48369" : path === "/bin/ps" ? remoteAttach : "[]"));

    await expect(locateTerminalPaneClients(remote)).rejects.toMatchObject({ code: "machine_unknown" });
  });
});

describe("launchHerdrInTerminal in WezTerm", () => {
  const wezterm = "/Applications/WezTerm.app/Contents/MacOS/wezterm";

  beforeEach(() => {
    preferences.customTerminalLauncher = undefined;
    preferences.terminalApplication = {
      bundleId: "com.github.wez.wezterm",
      name: "WezTerm",
      path: "/Applications/WezTerm.app",
    };
  });

  function spawnArgs(): string[] | undefined {
    return execCalls.find((call) => call.path === wezterm && call.args[1] === "spawn")?.args;
  }

  it("spawns a tab into the first listed window by default", async () => {
    mockExecFile((_path, args) =>
      args[1] === "list" ? JSON.stringify([{ window_id: 4, pane_id: 1, tty_name: "/dev/ttys001" }]) : "9",
    );

    await launchHerdrInTerminal(["session", "attach", "tmp-b"], { includeSession: false });
    expect(spawnArgs()).toEqual(["cli", "spawn", "--window-id", "4", "--", binary, "session", "attach", "tmp-b"]);
  });

  // The pane id lets a caller confirm that this launch, and not some other
  // client of the session, attached.
  it("reports the pane the spawn created", async () => {
    mockExecFile(() => "9");

    await expect(launchHerdrInTerminal(["session", "attach", "tmp-b"], { includeSession: false })).resolves.toEqual({
      wezTermPaneId: "9",
    });
  });

  it("spawns a new window without listing panes when asked", async () => {
    mockExecFile(() => "9");

    await launchHerdrInTerminal(["session", "attach", "tmp-b"], { includeSession: false, newWindow: true });
    expect(spawnArgs()).toEqual(["cli", "spawn", "--new-window", "--", binary, "session", "attach", "tmp-b"]);
    expect(execCalls.some((call) => call.args[1] === "list")).toBe(false);
  });

  it("spawns into the requested window", async () => {
    mockExecFile(() => "9");

    await launchHerdrInTerminal(["session", "attach", "tmp-b"], { includeSession: false, windowId: "7" });
    expect(spawnArgs()).toEqual(["cli", "spawn", "--window-id", "7", "--", binary, "session", "attach", "tmp-b"]);
  });
});

describe("launchHerdrInTerminal in iTerm", () => {
  beforeEach(() => {
    preferences.customTerminalLauncher = undefined;
    preferences.terminalApplication = {
      bundleId: "com.googlecode.iterm2",
      name: "iTerm",
      path: "/Applications/iTerm.app",
    };
  });

  function script(): string | undefined {
    return execCalls.find((call) => call.path === "/usr/bin/osascript")?.args[1];
  }

  it("opens a tab in the current window by default", async () => {
    mockExecFile(() => "");

    await launchHerdrInTerminal();
    expect(script()).toContain("create tab with default profile");
  });

  it("opens a new window when asked", async () => {
    mockExecFile(() => "");

    await launchHerdrInTerminal([], { newWindow: true });
    expect(script()).toContain("create window with default profile");
    expect(script()).not.toContain("create tab");
  });
});

describe("launchHerdrInTerminal in Ghostty", () => {
  beforeEach(() => {
    preferences.customTerminalLauncher = undefined;
    preferences.terminalApplication = {
      bundleId: "com.mitchellh.ghostty",
      name: "Ghostty",
      path: "/Applications/Ghostty.app",
    };
  });

  function script(): string | undefined {
    return execCalls.find((call) => call.path === "/usr/bin/osascript")?.args[1];
  }

  it("opens a tab in the front window by default", async () => {
    mockExecFile(() => "opened");

    await launchHerdrInTerminal();
    expect(script()).toContain("new tab in front window with configuration cfg");
  });

  it("opens a new window when asked", async () => {
    mockExecFile(() => "opened");

    await launchHerdrInTerminal([], { newWindow: true });
    expect(script()).toContain("new window with configuration cfg");
    expect(script()).not.toContain("new tab");
  });
});
