import { Action, ActionPanel, Alert, Color, Icon, List, closeMainWindow, confirmAlert } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useSelectedSession } from "./hooks/use-herdr-snapshot";
import { formatHerdrError, getSessions, runHerdr } from "./lib/herdr";
import { duplicateMachineIds, listMachines, removeMachine, setMachineEnabled } from "./lib/machines";
import { getSessionEnterAction } from "./lib/preferences";
import { formatSessionRef, machineSessionRef, sameSessionRef, sessionRefKey, type SessionRef } from "./lib/session-ref";
import { clearSelectedSessionIf, setSelectedSession } from "./lib/session-selection";
import { switchToSession, type SwitchResult } from "./lib/session-switch";
import { attachInTerminal } from "./lib/terminal";
import type { Machine } from "./lib/types";
import { CONNECTING_MACHINES_GUIDE, ErrorView, ShowLocalPathInFinderAction, runAction, shortcuts } from "./lib/ui";

// Adding a Machine is Herdr's interactive setup, which asks before installing or
// replacing anything on the Remote Host, so Raycast hands the user the command.
const ADD_MACHINE_COMMAND = "herdr machine add <ssh-target> --label <label> --remote-session <session>";

function switchMessage(result: SwitchResult, machines: Machine[] | undefined): string {
  if (result.outcome === "revealed") return "Revealed its existing client";
  if (result.detached > 0) {
    const previous = formatSessionRef(result.previous, machines);
    return `Detached ${result.detached} client${result.detached === 1 ? "" : "s"} of “${previous}”`;
  }
  return result.skipped ? `Attached alongside: ${result.skipped}` : "Attached alongside";
}

function AddMachineActions() {
  return (
    <>
      <Action.CopyToClipboard title="Copy Add Machine Command" content={ADD_MACHINE_COMMAND} />
      <Action.OpenInBrowser title="Open Connecting Machines Guide" url={CONNECTING_MACHINES_GUIDE} />
    </>
  );
}

export default function Command() {
  const sessions = useCachedPromise(getSessions, [], { keepPreviousData: true });
  // A Herdr without the `machine` command reads as one with no Machines; any
  // other listing failure is shown in the section's place.
  const machines = useCachedPromise(listMachines, [], { keepPreviousData: true });
  const selected = useSelectedSession();
  const enterAction = getSessionEnterAction();
  if (sessions.error && !sessions.data) return <ErrorView error={sessions.error} onRetry={sessions.revalidate} />;

  const machineRows = machines.data ?? [];
  const duplicates = duplicateMachineIds(machineRows);

  async function refresh() {
    await Promise.all([sessions.revalidate(), machines.revalidate(), selected.revalidate()]);
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
    const succeeded = await runAction(
      "Switching session",
      async () => switchMessage(await switchToSession(ref, { machines: machines.data }), machines.data),
      { success: `Switched to “${formatSessionRef(ref, machines.data)}”`, onSuccess: selected.revalidate },
    );
    if (succeeded) await closeMainWindow({ clearRootSearch: true });
  }

  async function select(ref: SessionRef) {
    await runAction("Selecting session", () => setSelectedSession(ref), {
      success: "Session Selected",
      onSuccess: selected.revalidate,
    });
  }

  // Manage Sessions lists the Local Host, so Stop and Delete name a Local Host
  // Session outright; a Machine's Session is stopped through its bridge below
  // and never deleted from here.
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

  // Herdr's `server stop`, routed to the Machine by `--machine <id>`: the server
  // on its Host exits with every pane process, and only an attach restarts it.
  async function stopMachineSession(machine: Machine) {
    if (
      !(await confirmAlert({
        title: `Stop session “${machine.session}” on “${machine.label}”?`,
        message: `Every workspace, pane, agent, and running process in this session will stop, and Herdr's server on ${machine.target} exits with them.`,
        primaryAction: { title: "Stop Session", style: Alert.ActionStyle.Destructive },
      }))
    )
      return;
    await runAction(
      "Stopping session",
      () => runHerdr(["server", "stop"], { ref: machineSessionRef(machine) }).then(() => undefined),
      { success: "Session Stopped" },
    );
  }

  async function setEnabled(machine: Machine, enabled: boolean) {
    await runAction(enabled ? "Enabling machine" : "Disabling machine", () => setMachineEnabled(machine.id, enabled), {
      success: enabled ? "Machine Enabled" : "Machine Disabled",
      onSuccess: machines.revalidate,
    });
  }

  async function confirmRemoveMachine(machine: Machine) {
    if (
      !(await confirmAlert({
        title: `Remove machine “${machine.label}”?`,
        message: `Herdr forgets this machine. The server on ${machine.target} and its session “${machine.session}” keep running.`,
        primaryAction: { title: "Remove Machine", style: Alert.ActionStyle.Destructive },
      }))
    )
      return;
    await runAction(
      "Removing machine",
      async () => {
        await removeMachine(machine.id);
        await clearSelectedSessionIf(machineSessionRef(machine));
      },
      { success: "Machine Removed", onSuccess: refresh },
    );
  }

  return (
    <List
      isLoading={sessions.isLoading || machines.isLoading}
      searchBarPlaceholder="Search Herdr sessions and machines…"
      actions={
        <ActionPanel>
          <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={shortcuts.refresh} onAction={refresh} />
          <AddMachineActions />
        </ActionPanel>
      }
    >
      <List.EmptyView
        icon={Icon.Terminal}
        title="No Sessions"
        description="Open Herdr to create the default session, or add a machine with the actions below."
      />
      {/* The heading appears only once there is a second section to tell the Local Host from. */}
      <List.Section title={machineRows.length > 0 ? "Local Host" : undefined}>
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
                  <ActionPanel.Section title="Machines">
                    <AddMachineActions />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
      {machineRows.length > 0 ? (
        <List.Section title="Machines" subtitle={String(machineRows.length)}>
          {machineRows.map((machine) => {
            const ref = machineSessionRef(machine);
            // A Machine's Session is Running or Stopped on its Host, which a read
            // through --machine reports; the row itself makes no claim.
            const attachAction = (
              <Action
                key="attach"
                title="Attach in Terminal"
                icon={Icon.Terminal}
                shortcut={shortcuts.attach}
                onAction={() => attach(ref)}
              />
            );
            const switchAction = (
              <Action
                key="switch"
                title="Switch to Session"
                icon={Icon.Replace}
                shortcut={shortcuts.switchSession}
                onAction={() => switchTo(ref)}
              />
            );
            return (
              <List.Item
                key={sessionRefKey(ref)}
                icon={machine.enabled ? Icon.Network : { source: Icon.Network, tintColor: Color.SecondaryText }}
                title={machine.label}
                subtitle={machine.target}
                keywords={[machine.target, machine.session, machine.id]}
                accessories={[
                  { text: machine.session, tooltip: "Session on the Machine" },
                  ...(machine.enabled ? [] : [{ tag: "Disabled" }]),
                  ...(duplicates.has(machine.id)
                    ? [
                        {
                          tag: { value: "Duplicate", color: Color.Orange },
                          tooltip: "Another machine targets the same session",
                        },
                      ]
                    : []),
                  // Herdr's own client shows one machine at a time; that choice is
                  // Herdr's, not the Selected Session.
                  ...(machine.selected ? [{ icon: Icon.Eye, tooltip: "Shown in Herdr" }] : []),
                  ...(sameSessionRef(ref, selected.data) ? [{ tag: "Selected" }] : []),
                ]}
                actions={
                  <ActionPanel>
                    {/* The same order as a Local Host row, with the Machine's own
                        management where Stop and Delete sit there. */}
                    {enterAction === "switch" ? switchAction : attachAction}
                    <Action
                      title="Remove Machine"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={shortcuts.delete}
                      onAction={() => confirmRemoveMachine(machine)}
                    />
                    <Action.CopyToClipboard
                      title="Copy SSH Target"
                      content={machine.target}
                      shortcut={shortcuts.copyId}
                    />
                    <Action
                      title="Refresh"
                      icon={Icon.ArrowClockwise}
                      shortcut={shortcuts.refresh}
                      onAction={refresh}
                    />
                    {enterAction === "switch" ? attachAction : switchAction}
                    <Action
                      title="Attach in New Window"
                      icon={Icon.PlusTopRightSquare}
                      shortcut={shortcuts.attachInNewWindow}
                      onAction={() => attach(ref, { newWindow: true })}
                    />
                    <Action
                      title="Select Session"
                      icon={Icon.Checkmark}
                      shortcut={shortcuts.selectSession}
                      onAction={() => select(ref)}
                    />
                    <Action
                      title="Stop Session"
                      icon={Icon.Stop}
                      style={Action.Style.Destructive}
                      onAction={() => stopMachineSession(machine)}
                    />
                    <ActionPanel.Section title="Machine">
                      <Action
                        title={machine.enabled ? "Disable Machine" : "Enable Machine"}
                        icon={machine.enabled ? Icon.XMarkCircle : Icon.CheckCircle}
                        onAction={() => setEnabled(machine, !machine.enabled)}
                      />
                      <AddMachineActions />
                    </ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      ) : null}
      {machines.error && machineRows.length === 0 ? (
        <List.Section title="Machines">
          <List.Item
            icon={Icon.ExclamationMark}
            title="Machines Could Not Be Listed"
            subtitle={formatHerdrError(machines.error).title}
            actions={
              <ActionPanel>
                <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={shortcuts.refresh} onAction={refresh} />
                <AddMachineActions />
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}
    </List>
  );
}
