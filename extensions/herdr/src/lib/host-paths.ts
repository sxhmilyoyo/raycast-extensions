import { showInFinder } from "@raycast/api";
import { HerdrError } from "./herdr";
import type { SessionRef } from "./session-ref";
import { resolveSessionRef } from "./session-selection";

/**
 * Shows `path` in Finder, but only when the Session it came from is on the
 * Local Host: `session` when the caller knows which Session that is, else the
 * Selected Session. Every path in a Snapshot belongs to the Host that reported
 * it, so a Remote Host's path handed to the local Finder opens a different
 * directory, or nothing, with no sign that it came from the wrong Host.
 */
export async function showLocalPathInFinder(path: string, session?: SessionRef): Promise<void> {
  const ref = await resolveSessionRef(session);
  if (ref.machine) {
    throw new HerdrError(
      `“${path}” is on a Remote Host`,
      "remote_path",
      "Finder can only open paths on this Mac. Choose a Local Host session to browse its paths.",
    );
  }
  await showInFinder(path);
}
