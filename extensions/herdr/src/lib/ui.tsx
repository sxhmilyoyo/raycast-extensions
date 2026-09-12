import { homedir } from "node:os";
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  type Keyboard,
  LaunchType,
  Toast,
  closeMainWindow,
  launchCommand,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useSessionTitle } from "../hooks/use-session-title";
import { formatHerdrError, getSessions, stoppedSessionOf, updateRequiredFor } from "./herdr";
import { showLocalPathInFinder } from "./host-paths";
import { listMachines, sessionRefPresence } from "./machines";
import { formatSessionRef, type SessionRef } from "./session-ref";
import { shortcuts } from "./shortcuts";
import { attachInTerminal, type LaunchResult } from "./terminal";
import type { AgentStatus, TabInfo } from "./types";
export { shortcuts } from "./shortcuts";

// Herdr defaults a tab's label to its number, which identifies nothing.
export function tabLabel(tab?: TabInfo): string | undefined {
  if (!tab || tab.label === String(tab.number)) return undefined;
  return tab.label;
}

export function abbreviatePath(path?: string): string | undefined {
  if (!path) return undefined;
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function statusTitle(status?: AgentStatus): string {
  switch (status) {
    case "working":
      return "Working";
    case "blocked":
      return "Needs Attention";
    case "done":
      return "Done";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}

export function statusColor(status?: AgentStatus): Color {
  switch (status) {
    case "working":
      return Color.Blue;
    case "blocked":
      return Color.Red;
    case "done":
      return Color.Green;
    case "idle":
      return Color.SecondaryText;
    default:
      return Color.Yellow;
  }
}

export function statusIcon(status?: AgentStatus): { source: Icon; tintColor: Color } {
  const source = status === "working" ? Icon.Bolt : status === "blocked" ? Icon.ExclamationMark : Icon.CircleFilled;
  return { source, tintColor: statusColor(status) };
}

/**
 * Runs `action` behind a toast. A string it returns becomes the success toast's
 * message. The type stays narrow so a raw `runHerdr` result, which is CLI
 * stdout, cannot be passed by accident.
 */
export async function runAction(
  title: string,
  action: () => Promise<void | string | LaunchResult>,
  options: { success?: string; onSuccess?: () => void | Promise<void> } = {},
): Promise<boolean> {
  const toast = await showToast({ style: Toast.Style.Animated, title });
  try {
    const message = await action();
    await options.onSuccess?.();
    toast.style = Toast.Style.Success;
    toast.title = options.success || title.replace(/^\w+ing\b/, "Done");
    if (typeof message === "string") toast.message = message;
    return true;
  } catch (error) {
    const formatted = formatHerdrError(error);
    toast.style = Toast.Style.Failure;
    toast.title = formatted.title;
    toast.message = formatted.message;
    return false;
  }
}

/**
 * Show in Finder, for a path that belongs to a Session's Host: `session` when
 * the caller knows which Session that is, else the Selected Session's. Stands
 * in for `Action.ShowInFinder`, which would hand a Remote Host's path to the
 * local Finder, and closes the main window on success as the built-in does.
 */
export function ShowLocalPathInFinderAction({
  path,
  session,
  shortcut,
}: {
  path: string;
  session?: SessionRef;
  shortcut?: Keyboard.Shortcut;
}) {
  return (
    <Action
      title="Show in Finder"
      icon={Icon.Finder}
      shortcut={shortcut}
      onAction={async () => {
        try {
          await showLocalPathInFinder(path, session);
          await closeMainWindow();
        } catch (error) {
          const formatted = formatHerdrError(error);
          await showToast({ style: Toast.Style.Failure, title: formatted.title, message: formatted.message });
        }
      }}
    />
  );
}

/**
 * Opens Manage Sessions, the one picker for the Selected Session. Selecting or
 * switching happens there, so this action is never titled Switch.
 */
export function ManageSessionsAction({ title = "Manage Sessions…" }: { title?: string }) {
  return (
    <Action
      title={title}
      icon={Icon.Switch}
      shortcut={shortcuts.manageSessions}
      onAction={() => launchCommand({ name: "sessions", type: LaunchType.UserInitiated })}
    />
  );
}

/** Attach `session` in a Terminal Pane from a recovery view, closing Raycast once the terminal has it. */
function AttachSessionAction({ session, title, progress }: { session: SessionRef; title: string; progress: string }) {
  return (
    <Action
      title={title}
      icon={Icon.Terminal}
      onAction={async () => {
        const succeeded = await runAction(progress, () => attachInTerminal(session), { success: "Terminal Opened" });
        if (succeeded) await closeMainWindow({ clearRootSearch: true });
      }}
    />
  );
}

// Reads never start a session, so a Stopped Selected Session is shown as such;
// attaching through the terminal is the only way to start it from here. Herdr
// reports a session that does not exist the same way, and `herdr --session`
// would create it, so the start action appears only once a list has confirmed
// the Session: `session list` for the Local Host, and the machine list for a
// Machine's Session, which exists for as long as its Machine is saved. While
// the list loads, or if it fails, there is no start.
function SessionStoppedView({ session, onRetry }: { session: SessionRef; onRetry?: () => void }) {
  const sessions = useCachedPromise(getSessions, [], { execute: !session.machine, keepPreviousData: true });
  const machines = useCachedPromise(listMachines, [], { execute: Boolean(session.machine), keepPreviousData: true });
  const presence = sessionRefPresence(session, sessions, machines);
  const listError = session.machine ? machines.error : sessions.error;
  const title = formatSessionRef(session, machines.data);
  const markdown =
    presence === "missing"
      ? session.machine
        ? `# Session “${title}” was not found\n\nIts Machine is no longer saved in Herdr. Choose another session for Raycast to control.`
        : `# Session “${title}” was not found\n\nIt may have been deleted, or the Default Session preference may be misspelled. Choose another session for Raycast to control.`
      : presence === "unknown" && listError
        ? `# Session “${title}” is stopped\n\nThe ${session.machine ? "machine" : "session"} list could not be read, so it cannot be started from here. Open Manage Sessions to start it or choose another session.`
        : `# Session “${title}” is stopped\n\nAttach to start it in your terminal, or choose another session for Raycast to control.`;
  return (
    <Detail
      isLoading={sessions.isLoading || machines.isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          {presence !== "listed" ? null : (
            <AttachSessionAction session={session} title="Start and Attach in Terminal" progress="Starting session" />
          )}
          <ManageSessionsAction title="Choose Another Session" />
          {onRetry ? (
            <Action title="Try Again" icon={Icon.ArrowClockwise} shortcut={shortcuts.refresh} onAction={onRetry} />
          ) : null}
          <Action title="Open Extension Preferences…" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}

// Reaching a Machine's Session needs a Herdr that accepts --machine on this Mac
// and on the Machine. Herdr 0.9.0 rejects the option before running anything, so
// nothing was read; the view says what to update rather than failing the read.
// Remote Attach needs no such build, so attaching is still offered.
function HerdrUpdateRequiredView({ session, onRetry }: { session: SessionRef; onRetry?: () => void }) {
  const title = useSessionTitle(session) ?? formatSessionRef(session);
  const markdown = `# Herdr needs an update to reach “${title}”\n\nReading and controlling a Machine's session from Raycast needs a Herdr that accepts \`--machine\`, on this Mac and on the Machine. Update both and try again, or choose another session for Raycast to control.\n\nAttaching does not need the update: Attach opens “${title}” in your terminal through Herdr's remote attach.`;
  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <AttachSessionAction session={session} title="Attach in Terminal" progress="Opening session" />
          <ManageSessionsAction title="Choose Another Session" />
          <Action.OpenInBrowser title="Open Herdr Update Guide" url="https://herdr.dev/docs/install/#update" />
          {onRetry ? (
            <Action title="Try Again" icon={Icon.ArrowClockwise} shortcut={shortcuts.refresh} onAction={onRetry} />
          ) : null}
          <Action title="Open Extension Preferences…" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const updateRequired = updateRequiredFor(error);
  if (updateRequired) return <HerdrUpdateRequiredView session={updateRequired} onRetry={onRetry} />;
  const stoppedSession = stoppedSessionOf(error);
  if (stoppedSession) return <SessionStoppedView session={stoppedSession} onRetry={onRetry} />;
  const formatted = formatHerdrError(error);
  const isMissing = error instanceof Error && "code" in error && error.code === "binary_not_found";
  const markdown = `# ${formatted.title}\n\n${formatted.message || "Make sure Herdr is installed and its server is running."}`;
  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          {onRetry ? <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={onRetry} /> : null}
          {isMissing ? (
            <Action.OpenInBrowser title="Open Herdr Installation Guide" url="https://herdr.dev/docs/install/" />
          ) : null}
          <Action title="Open Extension Preferences…" icon={Icon.Gear} onAction={openExtensionPreferences} />
          <Action.OpenInBrowser title="Open Herdr Troubleshooting" url="https://herdr.dev/docs/troubleshooting/" />
        </ActionPanel>
      }
    />
  );
}
