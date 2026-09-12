import { Action, ActionPanel, Alert, Icon, List, closeMainWindow, confirmAlert } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useSelectedSession } from "./hooks/use-herdr-snapshot";
import { getSessions, runHerdr } from "./lib/herdr";
import { getSessionEnterAction } from "./lib/preferences";
import { formatSessionRef, sameSessionRef, sessionRefKey, type SessionRef } from "./lib/session-ref";
import { clearSelectedSessionIf, setSelectedSession } from "./lib/session-selection";
import { switchToSession, type SwitchResult } from "./lib/session-switch";
import { attachInTerminal } from "./lib/terminal";
import { ErrorView, ShowLocalPathInFinderAction, runAction, shortcuts } from "./lib/ui";

function switchMessage(result: SwitchResult): string {
  if (result.outcome === "revealed") return "Revealed its existing client";
  if (result.detached > 0) {
    return `Detached ${result.detached} client${result.detached === 1 ? "" : "s"} of “${formatSessionRef(result.previous)}”`;
  }
  return result.skipped ? `Attached alongside: ${result.skipped}` : "Attached alongside";
}

export default function Command() {
  const sessions = useCachedPromise(getSessions, [], { keepPreviousData: true });
  const selected = useSelectedSession();
  const enterAction = getSessionEnterAction();
  if (sessions.error && !sessions.data) return <ErrorView error={sessions.error} onRetry={sessions.revalidate} />;

  async function refresh() {
    await Promise.all([sessions.revalidate(), selected.revalidate()]);
  }

  // Every attach also selects: what the terminal shows is what Raycast controls.
  async function attach(ref: SessionRef, options: { newWindow?: boolean } = {}) {
    const succeeded = await runAction(
      "Opening session",
      async () => {
        // Selected only once the terminal has the client, so a failed attach
        // never leaves Raycast pointed at a session it cannot show.
        await attachInTerminal(ref, options);
        await setSelectedSession(ref);
      },
      { success: "Terminal Opened", onSuccess: selected.revalidate },
    );
    if (succeeded) await closeMainWindow({ clearRootSearch: true });
  }

  async function switchTo(ref: SessionRef) {
    const succeeded = await runAction("Switching session", async () => switchMessage(await switchToSession(ref)), {
      success: `Switched to “${formatSessionRef(ref)}”`,
      onSuccess: selected.revalidate,
    });
    if (succeeded) await closeMainWindow({ clearRootSearch: true });
  }

  async function select(ref: SessionRef) {
    await runAction("Selecting session", () => setSelectedSession(ref), {
      success: "Session Selected",
      onSuccess: selected.revalidate,
    });
  }

  // Manage Sessions lists the Local Host, so Stop and Delete name a Local Host
  // Session outright; a Machine's Session is never stopped or deleted from here.
  async function stop(name: string) {
    if (
      !(await confirmAlert({
        title: `Stop session “${name}”?`,
        message: "Every workspace, pane, agent, and running process in this session will stop.",
        primaryAction: { title: "Stop Session", style: Alert.ActionStyle.Destructive },
      }))
    )
      return;
    await runAction(
      "Stopping session",
      () => runHerdr(["session", "stop", name, "--json"], { ref: { name: "" } }).then(() => undefined),
      {
        success: "Session Stopped",
        onSuccess: sessions.revalidate,
      },
    );
  }

  async function remove(name: string) {
    if (
      !(await confirmAlert({
        title: `Delete session “${name}”?`,
        message: "This deletes the persisted session state. The session must be stopped first.",
        primaryAction: { title: "Delete Session", style: Alert.ActionStyle.Destructive },
      }))
    )
      return;
    await runAction(
      "Deleting session",
      async () => {
        await runHerdr(["session", "delete", name, "--json"], { ref: { name: "" } });
        await clearSelectedSessionIf({ name });
      },
      {
        success: "Session Deleted",
        onSuccess: refresh,
      },
    );
  }

  return (
    <List isLoading={sessions.isLoading} searchBarPlaceholder="Search Herdr sessions…">
      <List.EmptyView
        icon={Icon.Terminal}
        title="No Sessions"
        description="Open Herdr to create the default session."
      />
      {(sessions.data || []).map((session) => {
        // `getSessions` lists the Local Host.
        const ref: SessionRef = { name: session.name };
        // The preference decides which action Enter runs by ordering the two.
        // Both keep a fixed shortcut, so neither key changes meaning with it.
        const attachAction = (
          <Action
            key="attach"
            title={session.running ? "Attach in Terminal" : "Start and Attach in Terminal"}
            icon={Icon.Terminal}
            shortcut={shortcuts.attach}
            onAction={() => attach(ref)}
          />
        );
        const switchAction = (
          <Action
            key="switch"
            title={session.running ? "Switch to Session" : "Start and Switch to Session"}
            icon={Icon.Replace}
            shortcut={shortcuts.switchSession}
            onAction={() => switchTo(ref)}
          />
        );
        const newWindowAction = (
          <Action
            key="new-window"
            title={session.running ? "Attach in New Window" : "Start and Attach in New Window"}
            icon={Icon.PlusTopRightSquare}
            shortcut={shortcuts.attachInNewWindow}
            onAction={() => attach(ref, { newWindow: true })}
          />
        );
        const selectAction = (
          <Action
            key="select"
            title="Select Session"
            icon={Icon.Checkmark}
            shortcut={shortcuts.selectSession}
            onAction={() => select(ref)}
          />
        );
        return (
          <List.Item
            key={sessionRefKey(ref)}
            icon={session.running ? { source: Icon.CircleFilled, tintColor: "#34C759" } : Icon.Circle}
            title={session.name}
            subtitle={session.session_dir}
            accessories={[
              { tag: session.running ? "Running" : "Stopped" },
              ...(session.default ? [{ tag: "Default" }] : []),
              ...(sameSessionRef(ref, selected.data) ? [{ tag: "Selected" }] : []),
            ]}
            actions={
              <ActionPanel>
                {/* Enter keeps running Attach in Terminal, and the new actions
                    follow the existing ones, unless the preference promotes
                    Switch to the Enter action. */}
                {enterAction === "switch" ? switchAction : attachAction}
                {session.running ? (
                  <Action
                    title="Stop Session"
                    icon={Icon.Stop}
                    style={Action.Style.Destructive}
                    shortcut={shortcuts.delete}
                    onAction={() => stop(session.name)}
                  />
                ) : (
                  <Action
                    title="Delete Session"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={shortcuts.delete}
                    onAction={() => remove(session.name)}
                  />
                )}
                <Action.CopyToClipboard
                  title="Copy Socket Path"
                  content={session.socket_path}
                  shortcut={shortcuts.copyId}
                />
                <ShowLocalPathInFinderAction path={session.session_dir} session={ref} shortcut={shortcuts.copyPath} />
                <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={shortcuts.refresh} onAction={refresh} />
                {enterAction === "switch" ? attachAction : switchAction}
                {newWindowAction}
                {selectAction}
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
