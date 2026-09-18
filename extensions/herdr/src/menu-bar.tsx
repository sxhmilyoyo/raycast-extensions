import {
  Icon,
  Keyboard,
  LaunchType,
  MenuBarExtra,
  launchCommand,
  openExtensionPreferences,
  showHUD,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useHerdrSnapshot } from "./hooks/use-herdr-snapshot";
import { agentIcon, agentName } from "./lib/agent-appearance";
import {
  focusResource,
  formatHerdrError,
  getAgentTarget,
  getSessions,
  machineProblemOf,
  stoppedSessionOf,
  updateRequiredFor,
  type SessionListState,
} from "./lib/herdr";
import { listMachines, sessionRefPresence, type MachineListState } from "./lib/machines";
import { getHerdrPreferences } from "./lib/preferences";
import { formatSessionRef } from "./lib/session-ref";
import { launchHerdrInTerminal, revealFocusedHerdr } from "./lib/terminal";
import type { AgentInfo, AgentStatus, HerdrSnapshot } from "./lib/types";
import { statusIcon, statusTitle } from "./lib/ui";

const DISPLAYED_STATUSES: AgentStatus[] = ["blocked", "done", "working", "unknown"];

function agentLocation(agent: AgentInfo, snapshot: HerdrSnapshot): string {
  const workspace = snapshot.workspaces.find((item) => item.workspace_id === agent.workspace_id);
  const tab = snapshot.tabs.find((item) => item.tab_id === agent.tab_id);
  return (
    [workspace?.label, tab?.label].filter(Boolean).join(" › ") || agent.foreground_cwd || agent.cwd || agent.pane_id
  );
}

// Clicking an item unloads the menu bar command, so a toast held open across the
// work would never be resolved. A HUD expires on its own. Reporting is
// best-effort for the same reason: an unloaded command cannot show one either.
async function reportFailure(error: unknown): Promise<void> {
  const formatted = formatHerdrError(error);
  const title = formatted.message ? `${formatted.title}: ${formatted.message}` : formatted.title;
  await showHUD(title).catch(() => undefined);
}

async function focusAgent(agent: AgentInfo): Promise<void> {
  try {
    await focusResource("agent", getAgentTarget(agent));
    await revealFocusedHerdr();
  } catch (error) {
    await reportFailure(error);
  }
}

async function openHerdr(): Promise<void> {
  try {
    await launchHerdrInTerminal();
  } catch (error) {
    await reportFailure(error);
  }
}

/** What the menu bar shows in place of the agent list when the Snapshot could not be read. */
interface Problem {
  tooltip: string;
  /** The one item offered, and whether it opens Manage Sessions rather than Herdr itself. */
  title: string;
  icon: Icon;
  opensManageSessions: boolean;
}

// Herdr reports a missing session as not running too, and starting it would
// create it, so Start and Attach is offered only once a list has confirmed the
// Session. A Machine's Session needs a Herdr that accepts --machine first.
function describeProblem(error: unknown, sessions: SessionListState, machines: MachineListState): Problem | undefined {
  if (!error) return undefined;
  const updateRequired = updateRequiredFor(error);
  if (updateRequired) {
    const title = formatSessionRef(updateRequired, machines.data);
    return {
      tooltip: `Herdr · needs an update to reach ${title}`,
      title: `Herdr Needs an Update to Reach “${title}” — Manage Sessions…`,
      icon: Icon.Download,
      opensManageSessions: true,
    };
  }
  const stopped = stoppedSessionOf(error);
  if (stopped) {
    const title = formatSessionRef(stopped, machines.data);
    const presence = sessionRefPresence(stopped, sessions, machines);
    return {
      tooltip: `Herdr · ${title} is stopped`,
      title:
        presence === "listed"
          ? `Session “${title}” Is Stopped — Start and Attach`
          : presence === "missing"
            ? `Session “${title}” Not Found — Manage Sessions…`
            : `Session “${title}” Is Stopped — Manage Sessions…`,
      icon: Icon.Circle,
      opensManageSessions: presence !== "listed",
    };
  }
  const machineProblem = machineProblemOf(error);
  if (machineProblem) {
    const title = formatSessionRef(machineProblem, machines.data);
    return {
      tooltip: `Herdr · ${title} is unavailable`,
      title: `Session “${title}” Is Unavailable — Manage Sessions…`,
      icon: Icon.Network,
      opensManageSessions: true,
    };
  }
  return {
    tooltip: "Herdr is unavailable",
    title: "Herdr Unavailable — Open Herdr",
    icon: Icon.ExclamationMark,
    opensManageSessions: false,
  };
}

function AgentItem({ agent, snapshot }: { agent: AgentInfo; snapshot: HerdrSnapshot }) {
  return (
    <MenuBarExtra.Item
      icon={agentIcon(agent.agent)}
      title={agentName(agent)}
      subtitle={agentLocation(agent, snapshot)}
      tooltip={`${statusTitle(agent.agent_status)} · ${agentLocation(agent, snapshot)}`}
      onAction={() => void focusAgent(agent)}
    />
  );
}

export default function Command() {
  const snapshot = useHerdrSnapshot();
  const data = snapshot.data;
  const agents = data?.agents || [];
  const groups = new Map<AgentStatus, AgentInfo[]>(
    (["blocked", "done", "working", "idle", "unknown"] as AgentStatus[]).map((status) => [
      status,
      agents.filter((agent) => agent.agent_status === status),
    ]),
  );
  const blocked = groups.get("blocked") || [];
  const done = groups.get("done") || [];
  const working = groups.get("working") || [];
  const idle = groups.get("idle") || [];
  const unknown = groups.get("unknown") || [];
  const significantCount = blocked.length + done.length + working.length + unknown.length;
  const visible = getHerdrPreferences().showIdleInMenuBar !== false || significantCount > 0;
  const leadingStatus: AgentStatus | undefined =
    blocked.length > 0
      ? "blocked"
      : done.length > 0
        ? "done"
        : working.length > 0
          ? "working"
          : unknown.length > 0
            ? "unknown"
            : undefined;
  const leadingCount = leadingStatus ? groups.get(leadingStatus)?.length : undefined;
  const stoppedSession = stoppedSessionOf(snapshot.error);
  const updateRequired = updateRequiredFor(snapshot.error);
  const machineProblem = machineProblemOf(snapshot.error);
  // A list is consulted only while the Snapshot reads as Stopped, as needing an
  // update, or as a Machine problem, the menu bar's one exception to its
  // no-extra-subprocess rule (ADR-0002): `session list` for a Local Host
  // Session, the machine list for a Machine's Session and its label.
  const sessions = useCachedPromise(getSessions, [], {
    execute: stoppedSession !== undefined && !stoppedSession.machine,
    keepPreviousData: true,
  });
  const machines = useCachedPromise(listMachines, [], {
    execute: Boolean(stoppedSession?.machine) || updateRequired !== undefined || machineProblem !== undefined,
    keepPreviousData: true,
  });
  const problem = describeProblem(snapshot.error, sessions, machines);

  if (!visible) return null;

  return (
    <MenuBarExtra
      isLoading={snapshot.isLoading}
      icon={leadingStatus ? statusIcon(leadingStatus) : Icon.Terminal}
      title={leadingCount ? String(leadingCount) : undefined}
      tooltip={
        problem
          ? problem.tooltip
          : [
              "Herdr",
              snapshot.ref ? formatSessionRef(snapshot.ref, machines.data) : undefined,
              `${blocked.length} need attention`,
              `${done.length} done`,
              `${working.length} working`,
              `${idle.length} idle`,
              `${unknown.length} unknown`,
            ]
              .filter(Boolean)
              .join(" · ")
      }
    >
      {problem ? (
        <MenuBarExtra.Item
          title={problem.title}
          icon={problem.icon}
          onAction={() =>
            void (problem.opensManageSessions
              ? launchCommand({ name: "sessions", type: LaunchType.UserInitiated })
              : openHerdr())
          }
        />
      ) : null}

      {data
        ? DISPLAYED_STATUSES.map((status) => {
            const group = groups.get(status) || [];
            if (group.length === 0) return null;
            return (
              <MenuBarExtra.Section key={status} title={`${statusTitle(status)} (${group.length})`}>
                {group.map((agent) => (
                  <AgentItem key={agent.pane_id} agent={agent} snapshot={data} />
                ))}
              </MenuBarExtra.Section>
            );
          })
        : null}

      {data && idle.length > 0 ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Submenu title={`Idle (${idle.length})…`} icon={statusIcon("idle")}>
            {idle.map((agent) => (
              <AgentItem key={agent.pane_id} agent={agent} snapshot={data} />
            ))}
          </MenuBarExtra.Submenu>
        </MenuBarExtra.Section>
      ) : null}

      {!snapshot.isLoading && !snapshot.error && agents.length === 0 ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title="No Live Agents" icon={Icon.Circle} />
        </MenuBarExtra.Section>
      ) : null}

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Dashboard"
          icon={Icon.List}
          shortcut={Keyboard.Shortcut.Common.Open}
          onAction={() => void launchCommand({ name: "dashboard", type: LaunchType.UserInitiated })}
        />
        <MenuBarExtra.Item
          title="Start Agent"
          icon={Icon.Person}
          shortcut={Keyboard.Shortcut.Common.New}
          onAction={() => void launchCommand({ name: "start-agent", type: LaunchType.UserInitiated })}
        />
        <MenuBarExtra.Item
          title="Prompt Agent"
          icon={Icon.Message}
          shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
          onAction={() => void launchCommand({ name: "prompt-agent", type: LaunchType.UserInitiated })}
        />
        <MenuBarExtra.Item
          title="Open Herdr"
          icon={Icon.Terminal}
          shortcut={{ modifiers: ["cmd"], key: "t" }}
          onAction={() => void openHerdr()}
        />
        <MenuBarExtra.Item
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={() => void snapshot.revalidate()}
        />
        <MenuBarExtra.Item
          title="Manage Sessions…"
          icon={Icon.Switch}
          onAction={() => void launchCommand({ name: "sessions", type: LaunchType.UserInitiated })}
        />
        <MenuBarExtra.Item title="Preferences…" icon={Icon.Gear} onAction={openExtensionPreferences} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
