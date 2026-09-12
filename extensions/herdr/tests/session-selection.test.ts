import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSelectedSessionIf,
  getSelectedSession,
  pinSession,
  releaseSessionPin,
  resolveSessionRef,
  resolveStoredSession,
  setSelectedSession,
} from "../src/lib/session-selection";
import { serializeSessionRef } from "../src/lib/session-ref";
import { snapshotOfSession } from "../src/hooks/use-herdr-snapshot";
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
  releaseSessionPin();
});

describe("resolveSessionRef", () => {
  it("prefers an explicit ref, including the empty opt-out", async () => {
    await setSelectedSession({ name: "tmp-b" });
    preferences.sessionName = "work";

    await expect(resolveSessionRef({ name: "tmp-a" })).resolves.toEqual({ name: "tmp-a" });
    await expect(resolveSessionRef({ name: "" })).resolves.toEqual({ name: "" });
  });

  it("resolves the Selected Session, with its Machine, ahead of the Preferred Session", async () => {
    await setSelectedSession(remote);
    preferences.sessionName = "work";

    await expect(resolveSessionRef()).resolves.toEqual(remote);
  });

  it("falls back to the Preferred Session on the Local Host, then to Herdr's default", async () => {
    preferences.sessionName = "work";
    await expect(resolveSessionRef()).resolves.toEqual({ name: "work" });

    preferences.sessionName = undefined;
    await expect(resolveSessionRef()).resolves.toEqual({ name: "default" });
  });

  // Before Session Refs the selection was a bare name, which could only mean the
  // Local Host. Reads run in every command process, including the menu bar's, so
  // a read that rewrote the value could land after a selection made elsewhere
  // and silently revert it; the old key is retired on the write paths instead.
  it("reads a selection stored before Session Refs as a Local Host Session, without rewriting it", async () => {
    storage.set("selectedSession", "tmp-b");

    await expect(resolveSessionRef()).resolves.toEqual({ name: "tmp-b" });
    expect(storage.get("selectedSession")).toBe("tmp-b");
    expect(storage.has("selectedSessionRef")).toBe(false);
  });

  it("retires the pre-ref key once a selection is written", async () => {
    storage.set("selectedSession", "tmp-b");

    await setSelectedSession({ name: "tmp-c" });

    expect(storage.has("selectedSession")).toBe(false);
    await expect(getSelectedSession()).resolves.toEqual({ name: "tmp-c" });
  });

  it("ignores a blank legacy selection", async () => {
    storage.set("selectedSession", "  ");
    preferences.sessionName = "work";

    await expect(resolveSessionRef()).resolves.toEqual({ name: "work" });
  });

  it("treats a selection it cannot read as none", async () => {
    storage.set("selectedSessionRef", "not a ref");
    preferences.sessionName = "work";

    await expect(resolveSessionRef()).resolves.toEqual({ name: "work" });
  });
});

describe("clearSelectedSessionIf", () => {
  it("clears only a selection of the same Session on the same Machine", async () => {
    await setSelectedSession(remote);

    await clearSelectedSessionIf({ name: "meshclaw" });
    await expect(getSelectedSession()).resolves.toEqual(remote);

    await clearSelectedSessionIf(remote);
    await expect(getSelectedSession()).resolves.toBeUndefined();
  });

  // Deleting the Selected Session clears the selection (ADR-0001). The pre-ref
  // key may be what names it, and leaving that behind would bring the deleted
  // Session back as the selection on the next read.
  it("clears a selection still held under the pre-ref key", async () => {
    storage.set("selectedSession", "tmp-b");

    await clearSelectedSessionIf({ name: "tmp-b" });

    await expect(getSelectedSession()).resolves.toBeUndefined();
  });
});

// A view command resolves its Session once and pins it, so an action fired from
// that view targets the Session on screen even after another command changes
// the stored selection.
describe("pinSession", () => {
  it("outranks the stored selection until it is released", async () => {
    await setSelectedSession({ name: "tmp-b" });

    const release = pinSession({ name: "tmp-a" });
    await expect(resolveSessionRef()).resolves.toEqual({ name: "tmp-a" });

    release();
    await expect(resolveSessionRef()).resolves.toEqual({ name: "tmp-b" });
  });

  it("never outranks an explicit ref", async () => {
    pinSession({ name: "tmp-a" });

    await expect(resolveSessionRef({ name: "tmp-c" })).resolves.toEqual({ name: "tmp-c" });
    await expect(resolveSessionRef({ name: "" })).resolves.toEqual({ name: "" });
  });

  it("follows a selection made while it is held", async () => {
    const release = pinSession({ name: "tmp-a" });

    await setSelectedSession(remote);
    await expect(resolveSessionRef()).resolves.toEqual(remote);

    release();
  });

  it("releases only its own pin", async () => {
    await setSelectedSession({ name: "tmp-c" });
    const stale = pinSession({ name: "tmp-a" });
    pinSession({ name: "tmp-b" });

    stale();
    await expect(resolveSessionRef()).resolves.toEqual({ name: "tmp-b" });
  });
});

// Regression: the cache keeps the previous Session's data while the next loads,
// so a view rendered one Session's resources under another Session's name.
describe("snapshotOfSession", () => {
  const snapshot = { workspaces: [], tabs: [], panes: [], agents: [] } as never;

  it("returns the snapshot only for the Session it was read from", () => {
    expect(snapshotOfSession({ ref: { name: "tmp-a" }, snapshot }, { name: "tmp-a" })).toBe(snapshot);
    expect(snapshotOfSession({ ref: { name: "tmp-a" }, snapshot }, { name: "tmp-b" })).toBeUndefined();
    expect(snapshotOfSession({ ref: { name: "meshclaw" }, snapshot }, remote)).toBeUndefined();
    expect(snapshotOfSession(undefined, { name: "tmp-a" })).toBeUndefined();
  });
});

// Regression: the view's periodic refresh resolved through its own pin, so it
// could never observe a selection made in another command. The menu bar runs
// in its own long-lived process, so it stayed on the session it started with.
describe("resolveStoredSession", () => {
  it("reads the stored selection past any pin", async () => {
    await setSelectedSession({ name: "tmp-b" });
    preferences.sessionName = "work";
    pinSession({ name: "tmp-a" });

    await expect(resolveStoredSession()).resolves.toEqual({ name: "tmp-b" });
    await expect(resolveSessionRef()).resolves.toEqual({ name: "tmp-a" });
  });

  it("falls back to the Preferred Session, then to Herdr's default", async () => {
    pinSession({ name: "tmp-a" });
    preferences.sessionName = "work";
    await expect(resolveStoredSession()).resolves.toEqual({ name: "work" });

    preferences.sessionName = undefined;
    await expect(resolveStoredSession()).resolves.toEqual({ name: "default" });
  });
});

// Regression guard: setSelectedSession re-points the pin to the new Session, and
// a release that compared refs then no-oped, leaving the pin behind after the
// view unmounted. The release must undo its own pin whatever the Session is now.
describe("pinSession release after a selection", () => {
  it("releases the pin even after the selection moved it", async () => {
    const release = pinSession({ name: "tmp-a" });
    await setSelectedSession({ name: "tmp-b" });
    await expect(resolveSessionRef()).resolves.toEqual({ name: "tmp-b" });

    release();
    // Written past setSelectedSession, which would move a leaked pin along.
    storage.set("selectedSessionRef", serializeSessionRef({ name: "tmp-c" }));
    await expect(resolveSessionRef()).resolves.toEqual({ name: "tmp-c" });
  });
});
