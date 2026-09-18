import { basename } from "node:path";

interface WezTermPane {
  window_id?: number;
  pane_id: number;
  tty_name?: string;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

export interface HerdrClient {
  pid: string;
  tty: string;
}

/**
 * A Machine's Client: the `herdr --remote <target> --session <session>` process
 * that owns the Terminal Pane, and the `herdr client` child that draws the
 * remote server's UI. The child is the Client, so it is the one to signal; the
 * parent exits once the child has detached (ADR-0003, ADR-0005).
 */
export interface RemoteClient extends HerdrClient {
  clientPid: string;
}

/**
 * The one column set every lookup asks `ps` for. `ppid` ties a Remote Client's
 * child to its parent. `comm` is omitted because macOS truncates it to 16
 * characters, which splits a binary path containing a space.
 */
export const PS_COLUMNS = "pid=,ppid=,tty=,args=";

interface HerdrProcess extends HerdrClient {
  ppid: string;
  /** The argv after the executable, so a path containing spaces cannot shift the arguments. */
  arguments: string;
}

/** Parses `ps -o pid=,ppid=,tty=,args=` into the Herdr processes that own a tty. */
function parseHerdrProcesses(output: string, binary: string): HerdrProcess[] {
  const binaryName = basename(binary);
  const processes: HerdrProcess[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, ppid, tty, args] = match;
    if (tty === "??" || tty === "?") continue;
    const argv = args.trim().replace(/^['"]|['"]$/g, "");
    // The resolved binary path is matched whole, so a path containing spaces
    // still yields the right argument list; a differently located `herdr`
    // falls back to the first token.
    const first = argv.split(/\s+/)[0];
    let rest: string;
    if (argv === binary || argv.startsWith(`${binary} `)) rest = argv.slice(binary.length);
    else if (basename(first) === binaryName || basename(first) === "herdr") rest = argv.slice(first.length);
    else continue;
    processes.push({ pid, ppid, tty: tty.startsWith("/dev/") ? tty : `/dev/${tty}`, arguments: rest.trim() });
  }
  return processes;
}

type ArgvSession =
  /** `herdr --session x` or `herdr session attach x`. */
  | { kind: "named"; session: string }
  /** A plain `herdr`, which joins the Default Session. */
  | { kind: "bare" }
  /** A Remote Attach: `herdr --remote <target> [--session <session>]`. */
  | { kind: "remote"; target: string; session: string }
  /** Not a Client: a server, a CLI call, or the remote bridge's own child. */
  | { kind: "other" };

/** Herdr's remote default session, used when a Remote Attach names none. */
const REMOTE_DEFAULT_SESSION = "default";

/** Herdr's global options, which a Client may carry before any subcommand. */
const GLOBAL_FLAGS_WITH_VALUE = ["--session", "--remote", "--remote-keybindings"];
const GLOBAL_FLAGS = ["--no-session", "--handoff", "--default-config", "--version", "-V", "--help", "-h"];

/**
 * What a Herdr process's arguments say about the Session it belongs to.
 *
 * A Client is `herdr` with global options only, or `herdr session attach <name>`.
 * Anything else is a subcommand, so a CLI call such as `herdr --session work
 * pane read` is not a Client even though it names a Session: revealing its pane
 * or signaling it would hit the user's own running command. The remote bridge
 * (`herdr client`) and a `--remote` attach drive another host's server, so
 * neither is a Client of a local Session either.
 */
function argvSession(argv: string): ArgvSession {
  const words = argv.split(/\s+/).filter(Boolean);
  let session: string | undefined;
  let target: string | undefined;
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    const [flag, inlineValue] = word.startsWith("--") && word.includes("=") ? word.split(/=(.*)/s) : [word, undefined];
    if (GLOBAL_FLAGS_WITH_VALUE.includes(flag)) {
      const value = inlineValue ?? words[index + 1];
      if (flag === "--session") session = value;
      if (flag === "--remote") target = value;
      index += inlineValue === undefined ? 2 : 1;
      continue;
    }
    if (GLOBAL_FLAGS.includes(flag)) {
      index += 1;
      continue;
    }
    // The only subcommand a Client runs.
    const attached = words
      .slice(index)
      .join(" ")
      .match(/^session\s+attach\s+(\S+)$/)?.[1];
    return attached === undefined ? { kind: "other" } : { kind: "named", session: attached };
  }
  // A Remote Attach names another Host's server, so it is never a Client of a
  // Local Host Session; it is the Client of its Machine's Session instead.
  if (target !== undefined) {
    return { kind: "remote", target, session: session ?? REMOTE_DEFAULT_SESSION };
  }
  return session === undefined ? { kind: "bare" } : { kind: "named", session };
}

/**
 * Ttys of Clients that may be Revealed. A plain `herdr` reads as the Default
 * Session, because argv cannot reveal a client that joined a named session
 * through an inherited HERDR_SESSION.
 */
export function parseHerdrClientTtys(output: string, binary: string, sessionName?: string): string[] {
  const wanted = sessionName?.trim() || "default";
  const ttys = parseHerdrProcesses(output, binary)
    .filter((process) => {
      const argv = argvSession(process.arguments);
      return argv.kind === "named" ? argv.session === wanted : argv.kind === "bare" && wanted === "default";
    })
    .map((process) => process.tty);
  return [...new Set(ttys)];
}

/**
 * Clients whose arguments name `sessionName` outright, as pid and tty pairs.
 * Argv alone never qualifies one for a detach; the caller must also find its
 * tty in the Terminal Application's pane listing.
 */
export function parseHerdrClients(output: string, binary: string, sessionName: string): HerdrClient[] {
  return parseHerdrProcesses(output, binary)
    .filter((process) => {
      const argv = argvSession(process.arguments);
      return argv.kind === "named" && argv.session === sessionName;
    })
    .map(({ pid, tty }) => ({ pid, tty }));
}

/**
 * The Remote Clients of the Machine at `target` showing `session`, each with the
 * `herdr client` child to signal. A Remote Attach with no child has nothing left
 * to detach and no UI to reveal, so it does not count: Herdr's own background
 * bridge to a machine is an `ssh` child of a local Client and never appears
 * here, being no Herdr process at all.
 */
export function parseRemoteClients(output: string, binary: string, target: string, session: string): RemoteClient[] {
  const processes = parseHerdrProcesses(output, binary);
  const children = new Map<string, string>();
  for (const process of processes) {
    // `herdr client` and nothing else: the bridge's own child.
    if (process.arguments.trim() === "client") children.set(process.ppid, process.pid);
  }
  const clients: RemoteClient[] = [];
  for (const process of processes) {
    const argv = argvSession(process.arguments);
    if (argv.kind !== "remote" || argv.target !== target || argv.session !== session) continue;
    const clientPid = children.get(process.pid);
    if (clientPid === undefined) continue;
    clients.push({ pid: process.pid, tty: process.tty, clientPid });
  }
  return clients;
}

export function buildTerminalFocusScript(ttys: string[]): string {
  const values = ttys.map(appleScriptString).join(", ");
  return `set targetTtys to {${values}}
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if targetTtys contains (tty of t) then
        set selected of t to true
        set frontmost of w to true
        activate
        return tty of t
      end if
    end repeat
  end repeat
  return "miss"
end tell`;
}

export function buildITermFocusScript(ttys: string[]): string {
  const filter = ttys.map((tty) => `tty is ${appleScriptString(tty)}`).join(" or ");
  return `tell application "iTerm"
  set matches to every session of every tab of every window whose ${filter}
  repeat with windowIndex from 1 to count matches
    set windowMatches to item windowIndex of matches
    repeat with tabIndex from 1 to count windowMatches
      set tabMatches to item tabIndex of windowMatches
      if (count tabMatches) > 0 then
        set w to item windowIndex of windows
        set tb to item tabIndex of tabs of w
        set s to item 1 of tabMatches
        select w
        select tb
        select s
        activate
        return tty of s
      end if
    end repeat
  end repeat
  return "miss"
end tell`;
}

export function buildGhosttyFocusScript(title: string): string {
  const targetTitle = appleScriptString(title);
  return `tell application "Ghostty"
  ignoring case
    repeat 5 times
      repeat with t in terminals
        if (name of t as text) is ${targetTitle} then
          focus t
          return "focused"
        end if
      end repeat
      delay 0.02
    end repeat
  end ignoring
  return "miss"
end tell`;
}

export function buildTerminalTtyListScript(): string {
  return `tell application "Terminal" to get tty of every tab of every window`;
}

export function buildITermTtyListScript(): string {
  return `tell application "iTerm" to get tty of every session of every tab of every window`;
}

/** osascript prints nested lists flattened as "/dev/ttys001, /dev/ttys002". */
export function parseTtyList(output: string): string[] {
  return [...new Set(output.split(/[,\s]+/).filter((item) => item.startsWith("/dev/")))];
}

/** The given ttys that are WezTerm panes, with the window of the first match. */
export function parseWezTermPanes(output: string): WezTermPane[] | undefined {
  let panes: unknown;
  try {
    panes = JSON.parse(output);
  } catch {
    return undefined;
  }
  return Array.isArray(panes) ? (panes as WezTermPane[]) : undefined;
}

export interface WezTermMatch {
  tty: string;
  windowId?: string;
  paneId?: string;
}

/**
 * The given ttys that are WezTerm panes, each with its Terminal Window, plus the
 * window of the first match. The per-match window lets a caller act on one
 * window rather than on every pane it found.
 */
export function selectWezTermPanes(
  output: string,
  ttys: string[],
): { matches: WezTermMatch[]; windowId?: string } | undefined {
  const panes = parseWezTermPanes(output);
  if (!panes) return undefined;
  const matches = panes
    .filter((pane) => pane.tty_name && ttys.includes(pane.tty_name))
    .map((pane) => ({
      tty: pane.tty_name as string,
      windowId: Number.isInteger(pane.window_id) ? String(pane.window_id) : undefined,
      paneId: Number.isInteger(pane.pane_id) ? String(pane.pane_id) : undefined,
    }));
  return { matches, windowId: matches.find((match) => match.windowId !== undefined)?.windowId };
}

export function selectWezTermPane(output: string, ttys: string[]): string | undefined {
  const match = parseWezTermPanes(output)?.find((pane) => pane.tty_name && ttys.includes(pane.tty_name));
  return match ? String(match.pane_id) : undefined;
}

export function selectWezTermWindow(output: string): string | undefined {
  const windowId = parseWezTermPanes(output)?.find((pane) => Number.isInteger(pane.window_id))?.window_id;
  return windowId === undefined ? undefined : String(windowId);
}
