import { describe, expect, it } from "vitest";
import {
  formatSessionRef,
  parseSessionRef,
  sameSessionRef,
  serializeSessionRef,
  sessionRefKey,
} from "../src/lib/session-ref";
import { cddMeshclaw } from "./helpers/machines";

const machineId = cddMeshclaw.id;
const otherMachineId = "0f3c1a9b7e2d4c6a8b1d3e5f7a9c2b4d";

describe("sessionRefKey", () => {
  // A Machine's Session keeps its remote name, which a Local Host Session may
  // share, and two Machines may point at the same remote Session. A key that
  // was the bare name would fold those rows into one list entry.
  it("keeps a Local Host Session apart from Machines whose Session shares its name", () => {
    const keys = [
      sessionRefKey({ name: "meshclaw" }),
      sessionRefKey({ machine: machineId, name: "meshclaw" }),
      sessionRefKey({ machine: otherMachineId, name: "meshclaw" }),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});

describe("formatSessionRef", () => {
  it("names a Local Host Session by its name alone", () => {
    expect(formatSessionRef({ name: "default" })).toBe("default");
  });

  // Labels rename freely, so the ref stores the id and the label is looked up at render.
  it("names a Machine's Session with the Machine's label when it is known", () => {
    expect(formatSessionRef({ machine: machineId, name: "meshclaw" }, [cddMeshclaw])).toBe("meshclaw on cdd-meshclaw");
  });

  it("falls back to a short id when the Machine is not in the list", () => {
    expect(formatSessionRef({ machine: machineId, name: "meshclaw" })).toBe("meshclaw on machine 368dca28");
    expect(formatSessionRef({ machine: machineId, name: "meshclaw" }, [])).toBe("meshclaw on machine 368dca28");
  });
});

describe("sameSessionRef", () => {
  it("matches only when both the Machine and the name agree", () => {
    expect(sameSessionRef({ name: "default" }, { name: "default" })).toBe(true);
    expect(sameSessionRef({ machine: machineId, name: "meshclaw" }, { machine: machineId, name: "meshclaw" })).toBe(
      true,
    );
    expect(sameSessionRef({ name: "meshclaw" }, { machine: machineId, name: "meshclaw" })).toBe(false);
    expect(sameSessionRef({ machine: machineId, name: "meshclaw" }, { machine: otherMachineId, name: "meshclaw" })).toBe(
      false,
    );
  });

  it("treats a missing ref as matching nothing", () => {
    expect(sameSessionRef(undefined, { name: "default" })).toBe(false);
    expect(sameSessionRef({ name: "default" }, undefined)).toBe(false);
  });
});

describe("session ref storage", () => {
  // Strict equality: a parsed Local Host ref carries no `machine` key at all, so
  // it compares equal to a freshly built `{ name }` wherever refs are deps.
  it("round-trips Local Host and Machine refs", () => {
    expect(parseSessionRef(serializeSessionRef({ name: "default" }))).toStrictEqual({ name: "default" });
    expect(parseSessionRef(serializeSessionRef({ machine: machineId, name: "meshclaw" }))).toStrictEqual({
      machine: machineId,
      name: "meshclaw",
    });
  });

  // The previous storage form named a Local Host Session the same way, and a
  // selection made under it should survive the update.
  it("still reads a version-1 Local Host ref", () => {
    expect(parseSessionRef('{"v":1,"name":"work"}')).toStrictEqual({ name: "work" });
  });

  // A version-1 ref that carried an SSH host was never reachable in a shipped
  // build, and no Machine corresponds to it, so it is no selection at all.
  it("reads a version-1 host ref as no selection", () => {
    expect(parseSessionRef('{"v":1,"host":"clouddesk-arm","name":"meshclaw"}')).toBeUndefined();
  });

  // A stored value the extension cannot read is no selection at all. Falling
  // back to the Preferred Session is what no selection already means, while
  // guessing at a Machine, or at the Local Host, is not.
  it("reads nothing from a value it did not write", () => {
    const rejected = [
      undefined,
      "tmp-b",
      "not json",
      "{}",
      '{"v":2}',
      '{"v":3,"name":"work"}',
      '{"v":2,"name":""}',
      '{"v":2,"machine":"","name":"work"}',
      '{"v":2,"machine":7,"name":"work"}',
    ];
    for (const stored of rejected) expect(parseSessionRef(stored), String(stored)).toBeUndefined();
  });
});
