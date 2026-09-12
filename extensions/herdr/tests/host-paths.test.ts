import { showInFinder } from "@raycast/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showLocalPathInFinder } from "../src/lib/host-paths";
import { setSelectedSession } from "../src/lib/session-selection";
import { remote } from "./helpers/machines";
import { storage } from "./helpers/raycast-api";

vi.mock("@raycast/api", () => import("./helpers/raycast-api"));

const preferences: { sessionName?: string } = {};
vi.mock("../src/lib/preferences", () => ({
  getHerdrPreferences: () => preferences,
}));

beforeEach(() => {
  storage.clear();
  preferences.sessionName = undefined;
  vi.mocked(showInFinder).mockReset();
});

describe("showLocalPathInFinder", () => {
  it("opens a Local Host path in Finder", async () => {
    await setSelectedSession({ name: "work" });

    await showLocalPathInFinder("/Users/someone/src/dotfiles");

    expect(showInFinder).toHaveBeenCalledWith("/Users/someone/src/dotfiles");
  });

  // Every path in a Snapshot belongs to the Host that reported it, so a Remote
  // Host's path handed to the local Finder opens a different directory or
  // nothing, with no sign that it came from the wrong Host.
  it("refuses a path from a Machine's Session", async () => {
    await setSelectedSession(remote);

    const failure = await showLocalPathInFinder("/home/someone/src/herdr").catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "remote_path", message: expect.stringContaining("Remote Host") });
    expect(showInFinder).not.toHaveBeenCalled();
  });

  // Manage Sessions lists Local Host Sessions whatever is selected, so the row's
  // own Session decides, not the Selected Session.
  it("opens a Local Host Session's path while a Machine is selected", async () => {
    await setSelectedSession(remote);

    await showLocalPathInFinder("/Users/someone/.herdr/sessions/work", { name: "work" });

    expect(showInFinder).toHaveBeenCalledWith("/Users/someone/.herdr/sessions/work");
  });
});
