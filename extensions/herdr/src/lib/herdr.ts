import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { getHerdrPreferences } from "./preferences";
import { formatSessionRef, type SessionRef } from "./session-ref";
import { resolveSessionRef } from "./session-selection";
import type { HerdrSession, HerdrSnapshot, PaneInfo } from "./types";

interface RunOptions {
  timeout?: number;
  /** The Session to target. An empty name opts out of the --session flag. */
  ref?: SessionRef;
  signal?: AbortSignal;
}

interface CliEnvelope<T> {
  id?: string;
  result?: T;
  error?: { code?: string; message?: string };
}

let resolvedBinary: string | undefined;

export class HerdrError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detail?: string,
    readonly session?: SessionRef,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHomePrefix(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path.startsWith("$HOME/")) return join(homedir(), path.slice("$HOME/".length));
  return path;
}

export async function resolveHerdrBinary(): Promise<string> {
  const preference = getHerdrPreferences().herdrPath?.trim();
  const configured = preference ? expandHomePrefix(preference) : preference;
  if (configured) {
    if (await isExecutable(configured)) return configured;
    throw new HerdrError(
      "The configured Herdr binary is not executable",
      "binary_not_found",
      `Check the Herdr Binary preference: ${configured}`,
    );
  }
  if (resolvedBinary && (await isExecutable(resolvedBinary))) return resolvedBinary;

  const candidates = [
    ...(process.env.PATH || "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "herdr")),
    join(homedir(), ".local", "bin", "herdr"),
    "/opt/homebrew/bin/herdr",
    "/usr/local/bin/herdr",
    "/usr/bin/herdr",
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) {
      resolvedBinary = candidate;
      return candidate;
    }
  }
  throw new HerdrError(
    "Herdr is not installed or could not be found",
    "binary_not_found",
    "Install it with `brew install herdr`, or set the Herdr Binary preference.",
  );
}

// Only stderr is scanned. `pane read` returns raw terminal text on stdout that
// could itself be JSON with a top-level `error` key.
function extractCliError(stderr: string): HerdrError | undefined {
  const candidate = stderr.trim();
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate) as CliEnvelope<unknown>;
    if (parsed.error) {
      return new HerdrError(parsed.error.message || "Herdr command failed", parsed.error.code, candidate);
    }
  } catch {
    // The CLI also returns human-readable errors. They are handled by the caller.
  }
  return undefined;
}

// Read commands never start a server. Herdr 0.9 answers a Stopped session with
// a `server_not_running` error envelope; older versions print the raw refused
// connection, and only that text counts there, since a missing socket path
// (NotFound) meant the session did not exist. Herdr 0.9 reports both cases
// alike, so the Stopped views check `session list` before offering to start.
const STOPPED_SESSION_CODE = "server_not_running";

function isStoppedSessionStderr(stderr: string): boolean {
  return /ConnectionRefused|Connection refused/.test(stderr);
}

function stoppedSessionError(ref: SessionRef, detail: string): HerdrError {
  return new HerdrError(`Herdr session “${formatSessionRef(ref)}” is stopped`, "session_not_running", detail, ref);
}

// Herdr 0.9.0 and earlier do not know the --machine prefix and reject it before
// running anything: an out-of-date Herdr, not a failed read. Herdr 0.9.1's
// bridge says the same of a Machine whose own Herdr predates forwarding.
function isMachinePrefixRejected(stderr: string): boolean {
  return /\bunknown option: --machine\b/.test(stderr);
}

function isRemoteForwardingUnsupported(stderr: string): boolean {
  return /remote Herdr does not support machine API forwarding/.test(stderr);
}

function machinePrefixUnsupportedError(ref: SessionRef, where: "this Mac and the Machine" | "the Machine"): HerdrError {
  return new HerdrError(
    "Herdr needs an update to reach Machines",
    "machine_prefix_unsupported",
    `Update Herdr on ${where} to a version that accepts --machine, then try again.`,
    ref,
  );
}

function machineUnavailableError(ref: SessionRef, detail: string): HerdrError {
  return new HerdrError(`“${formatSessionRef(ref)}” is unreachable`, "machine_unavailable", detail, ref);
}

/** The text inside Herdr's `Error: Custom { kind: …, error: "…" }`, or the whole message when it has another shape. */
function bridgeErrorText(stderr: string): string {
  const quoted = /error: "((?:[^"\\]|\\.)*)"/.exec(stderr);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : stderr;
}

/**
 * What a failed `--machine` command means, or nothing when it is an ordinary
 * failure. Herdr answers in three shapes. A usage error, exit 2 and `error: …`
 * on stderr, never reached SSH: the Machine is unknown or disabled, or the
 * command is one Herdr does not forward. A remote API error is the JSON
 * envelope, handled before this. Anything else is the bridge failing, exit 1
 * and Rust's Debug text naming the Machine: SSH could not connect or
 * authenticate, a step timed out, the Machine's Herdr predates forwarding, or
 * the remote server is Stopped, which arrives as the remote bridge failing to
 * reach its socket. The Local Host's refused-connection rule does not apply
 * here: SSH reports a refused connection when the Machine's sshd is down, and
 * that is an unreachable Machine, not a Stopped Session.
 */
function machineFailure(ref: SessionRef, args: string[], stderr: string, timedOut: boolean): HerdrError | undefined {
  const text = stderr.trim();
  if (timedOut) return machineUnavailableError(ref, "Herdr did not answer within the command timeout.");
  if (isMachinePrefixRejected(text)) return machinePrefixUnsupportedError(ref, "this Mac and the Machine");
  if (isRemoteForwardingUnsupported(text)) return machinePrefixUnsupportedError(ref, "the Machine");
  if (/^error: unknown machine '/.test(text)) {
    return new HerdrError(
      `The Machine of “${formatSessionRef(ref)}” is no longer saved in Herdr`,
      "machine_unknown",
      "Choose another session for Raycast to control, or add the Machine again with `herdr machine add`.",
      ref,
    );
  }
  if (/^error: machine '.*' is disabled/.test(text)) {
    return new HerdrError(
      `The Machine of “${formatSessionRef(ref)}” is disabled`,
      "machine_disabled",
      "Enable it in Manage Sessions, or choose another session for Raycast to control.",
      ref,
    );
  }
  if (/^error: `.*` is not an API-backed machine command/.test(text)) {
    return new HerdrError(
      `“${args.slice(0, 2).join(" ")}” is not available for a Machine`,
      "machine_command_unavailable",
      "Attach to the Machine and run it there.",
      ref,
    );
  }
  if (/failed to connect to remote Herdr API socket/.test(text)) return stoppedSessionError(ref, text);
  if (/^Error: [\s\S]*machine '/.test(text)) return machineUnavailableError(ref, bridgeErrorText(text));
  return undefined;
}

export async function runHerdr(args: string[], options: RunOptions = {}): Promise<string> {
  const binary = await resolveHerdrBinary();
  const ref = await resolveSessionRef(options.ref);
  // A Machine's Session is reached through Herdr's --machine prefix, which
  // routes the command over Herdr's own bridge; --session would name a Local
  // Host Session instead. Without --session the CLI falls back to an inherited
  // HERDR_SESSION, so a Local Host Session is always named explicitly, and an
  // empty name opts out for commands that span sessions.
  const sessionArgs = ref.machine ? ["--machine", ref.machine] : ref.name ? ["--session", ref.name] : [];

  return new Promise<string>((resolve, reject) => {
    execFile(
      binary,
      [...sessionArgs, ...args],
      {
        timeout: options.timeout ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const cliError = extractCliError(stderr);
        if (cliError) {
          if (ref.name && cliError.code === STOPPED_SESSION_CODE)
            return reject(stoppedSessionError(ref, cliError.detail ?? ""));
          return reject(cliError);
        }
        if (error) {
          const detail = stderr.trim() || stdout.trim() || error.message;
          const timedOut = "killed" in error && error.killed;
          if (ref.machine) {
            const failure = machineFailure(ref, args, stderr, Boolean(timedOut));
            if (failure) return reject(failure);
          } else if (ref.name && !timedOut && isStoppedSessionStderr(stderr)) {
            // Read from stderr alone, and only when the command ran to
            // completion: `pane read` puts raw terminal text on stdout, which
            // can quote a refused connection of its own.
            return reject(stoppedSessionError(ref, detail));
          }
          return reject(
            new HerdrError(
              timedOut ? "The Herdr command timed out" : "Unable to run the Herdr command",
              timedOut ? "timeout" : "command_failed",
              detail,
            ),
          );
        }
        resolve(stdout);
      },
    );
  });
}

export async function runHerdrJson<T>(args: string[], options: RunOptions = {}): Promise<T> {
  const output = await runHerdr(args, options);
  try {
    const parsed = JSON.parse(output) as CliEnvelope<T> & T;
    if (parsed.error) throw new HerdrError(parsed.error.message || "Herdr command failed", parsed.error.code, output);
    return parsed.result === undefined ? (parsed as T) : parsed.result;
  } catch (error) {
    if (error instanceof HerdrError) throw error;
    throw new HerdrError("Herdr returned an unexpected response", "invalid_json", output.slice(0, 2_000));
  }
}

export async function getSnapshot(signal?: AbortSignal, ref?: SessionRef): Promise<HerdrSnapshot> {
  const result = await runHerdrJson<{ snapshot: HerdrSnapshot }>(["api", "snapshot"], { signal, ref });
  if (!result.snapshot) throw new HerdrError("Herdr did not return a session snapshot", "invalid_snapshot");
  return result.snapshot;
}

export async function getSessions(): Promise<HerdrSession[]> {
  const response = await runHerdrJson<{ sessions: HerdrSession[] }>(["session", "list", "--json"], {
    ref: { name: "" },
  });
  return response.sessions ?? [];
}

export async function focusResource(kind: "workspace" | "tab" | "pane" | "agent", id: string): Promise<void> {
  if (kind === "pane") {
    await focusPane(id);
    return;
  }
  // `agent focus` moves the server's focus but leaves the attached client on
  // the tab it is drawing, so the agent's pane is focused again through the
  // tab-switching path. The call answers with the agent, naming that pane.
  if (kind === "agent") {
    const focused = await runHerdrJson<{ agent: PaneInfo }>(["agent", "focus", id]);
    if (focused.agent?.pane_id) await focusPane(focused.agent.pane_id);
    return;
  }
  await runHerdr([kind, "focus", id]);
}

type PaneDirection = "left" | "right" | "up" | "down";

interface PaneNeighborResponse {
  neighbor: {
    pane_id: string;
    direction: PaneDirection;
    neighbor_pane_id?: string;
  };
}

export async function focusPane(paneId: string): Promise<void> {
  const target = await runHerdrJson<{ pane: PaneInfo }>(["pane", "get", paneId]);
  await runHerdr(["tab", "focus", target.pane.tab_id]);
  const layout = await runHerdrJson<{ layout: { focused_pane_id: string; panes: Array<{ pane_id: string }> } }>([
    "pane",
    "layout",
    "--pane",
    paneId,
  ]);
  const start = layout.layout.focused_pane_id;
  if (start === paneId) return;

  const directions: PaneDirection[] = ["left", "right", "up", "down"];
  const parent = new Map<string, { from: string; direction: PaneDirection }>();
  const visited = new Set<string>([start]);
  const queue = [start];

  while (queue.length > 0 && !visited.has(paneId)) {
    const source = queue.shift()!;
    const neighbors = await Promise.all(
      directions.map(async (direction) => {
        const result = await runHerdrJson<PaneNeighborResponse>([
          "pane",
          "neighbor",
          "--direction",
          direction,
          "--pane",
          source,
        ]);
        return { direction, paneId: result.neighbor.neighbor_pane_id };
      }),
    );
    for (const neighbor of neighbors) {
      if (!neighbor.paneId || visited.has(neighbor.paneId)) continue;
      visited.add(neighbor.paneId);
      parent.set(neighbor.paneId, { from: source, direction: neighbor.direction });
      queue.push(neighbor.paneId);
    }
  }

  if (!visited.has(paneId)) {
    throw new HerdrError("Herdr could not find a focus path to the selected pane", "pane_focus_path_not_found");
  }

  const path: Array<{ from: string; to: string; direction: PaneDirection }> = [];
  let current = paneId;
  while (current !== start) {
    const edge = parent.get(current);
    if (!edge) throw new HerdrError("Herdr returned an incomplete pane layout", "invalid_pane_layout");
    path.unshift({ from: edge.from, to: current, direction: edge.direction });
    current = edge.from;
  }
  for (const edge of path) {
    await runHerdr(["pane", "focus", "--direction", edge.direction, "--pane", edge.from]);
  }
}

export async function readPane(target: string, lines: number, agent = false): Promise<string> {
  return runHerdr([agent ? "agent" : "pane", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)]);
}

export async function sendAgentPrompt(target: string, prompt: string): Promise<void> {
  await runHerdr(["agent", "prompt", target, prompt]);
}

export async function sendAgentKeys(target: string, keys: string[]): Promise<void> {
  await runHerdr(["agent", "send-keys", target, ...keys]);
}

export async function sendPaneKeys(target: string, keys: string[]): Promise<void> {
  await runHerdr(["pane", "send-keys", target, ...keys]);
}

export async function runInPane(target: string, command: string): Promise<void> {
  await runHerdr(["pane", "run", target, command]);
}

export function getAgentTarget(agent: { name?: string; pane_id: string }): string {
  return agent.name || agent.pane_id;
}

/** The state of a `session list` read, as the cached-promise hooks report it. */
export interface SessionListState {
  data?: HerdrSession[];
  isLoading: boolean;
  error?: unknown;
}

/**
 * Whether `name` is among the listed Sessions. Herdr 0.9 reports a Session that
 * does not exist exactly like a Stopped one, and `herdr --session` creates what
 * it cannot find, so a start is offered only for a listed Session. Only a
 * settled, successful listing is evidence: the hooks keep the previous list
 * while a refresh is in flight or after one fails, so a Session deleted in the
 * meantime would otherwise still read as listed. Anything else is unknown, and
 * unknown never earns a start.
 */
export type SessionPresence = "listed" | "missing" | "unknown";

export function sessionPresence(list: SessionListState, name: string): SessionPresence {
  if (list.isLoading || list.error !== undefined || list.data === undefined) return "unknown";
  return list.data.some((session) => session.name === name) ? "listed" : "missing";
}

/** The Session a failure names when Herdr rejected the --machine prefix, so views can show the update state. */
export function updateRequiredFor(error: unknown): SessionRef | undefined {
  return error instanceof HerdrError && error.code === "machine_prefix_unsupported" ? error.session : undefined;
}

/** The Session a failure names when its server is Stopped, so views can offer to start it. */
export function stoppedSessionOf(error: unknown): SessionRef | undefined {
  return error instanceof HerdrError && error.code === "session_not_running" ? error.session : undefined;
}

const MACHINE_PROBLEM_CODES = new Set(["machine_unavailable", "machine_disabled", "machine_unknown"]);

/** The Session a failure names when its Machine could not be used: unreachable, disabled, or no longer saved. */
export function machineProblemOf(error: unknown): SessionRef | undefined {
  return error instanceof HerdrError && error.code !== undefined && MACHINE_PROBLEM_CODES.has(error.code)
    ? error.session
    : undefined;
}

export function formatHerdrError(error: unknown): { title: string; message?: string } {
  if (error instanceof HerdrError) return { title: error.message, message: error.detail };
  if (error instanceof Error) return { title: error.message };
  return { title: "Unexpected Herdr error", message: String(error) };
}
