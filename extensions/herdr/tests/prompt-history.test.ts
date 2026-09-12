import { beforeEach, describe, expect, it, vi } from "vitest";
import { addPromptHistory, getPromptHistory } from "../src/lib/prompt-history";
import { setSelectedSession } from "../src/lib/session-selection";
import type { AgentInfo } from "../src/lib/types";
import { cddMeshclaw } from "./helpers/machines";
import { storage } from "./helpers/raycast-api";

vi.mock("@raycast/api", () => import("./helpers/raycast-api"));

const preferences: { sessionName?: string } = {};
vi.mock("../src/lib/preferences", () => ({
  getHerdrPreferences: () => preferences,
}));

beforeEach(() => {
  storage.clear();
  preferences.sessionName = undefined;
});

const agent = { pane_id: "w1:p1", agent: "claude", agent_status: "idle" } as AgentInfo;
const machineId = cddMeshclaw.id;

describe("addPromptHistory", () => {
  // Pane ids are Session-scoped and collide across Hosts, so a dedup key of the
  // text and target alone drops a prompt that went to a different machine.
  it("keeps prompts with the same text and pane id on different Machines", async () => {
    await setSelectedSession({ name: "work" });
    await addPromptHistory(agent, "w1:p1", "run the tests");

    await setSelectedSession({ machine: machineId, name: "work" });
    await addPromptHistory(agent, "w1:p1", "run the tests");

    const history = await getPromptHistory();
    expect(history).toHaveLength(2);
    expect(history.map((item) => item.machine)).toEqual([machineId, undefined]);
  });

  it("still replaces a repeated prompt to the same pane on the same Host", async () => {
    await setSelectedSession({ name: "work" });
    await addPromptHistory(agent, "w1:p1", "run the tests");
    await addPromptHistory(agent, "w1:p1", "run the tests");

    await expect(getPromptHistory()).resolves.toHaveLength(1);
  });
});
