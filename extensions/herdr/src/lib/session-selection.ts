import { LocalStorage } from "@raycast/api";
import { getHerdrPreferences } from "./preferences";
import { parseSessionRef, sameSessionRef, serializeSessionRef, type SessionRef } from "./session-ref";

const SELECTED_SESSION_REF_KEY = "selectedSessionRef";
/** The key from before Session Refs, holding a bare name that could only mean the Local Host. */
const LEGACY_SELECTED_SESSION_KEY = "selectedSession";
export const DEFAULT_SESSION = "default";

/** A pre-ref selection as a Local Host ref, the only thing a bare name could mean. */
async function legacySelectedSession(): Promise<SessionRef | undefined> {
  const legacy = await LocalStorage.getItem<string>(LEGACY_SELECTED_SESSION_KEY);
  const name = typeof legacy === "string" ? legacy.trim() : "";
  return name ? { name } : undefined;
}

/**
 * Forgets the pre-ref key, whose value this version has just superseded. Done
 * on the write paths only: a read runs in every command process, including the
 * menu bar's, and one that persisted here could overwrite a selection the user
 * had just made in another command.
 */
async function retireLegacySelection(): Promise<void> {
  await LocalStorage.removeItem(LEGACY_SELECTED_SESSION_KEY);
}

/** The Selected Session: the one the user picked in Manage Sessions, shared by every command. */
export async function getSelectedSession(): Promise<SessionRef | undefined> {
  const stored = await LocalStorage.getItem<string>(SELECTED_SESSION_REF_KEY);
  if (stored !== undefined) return parseSessionRef(stored);
  return legacySelectedSession();
}

export async function setSelectedSession(ref: SessionRef): Promise<void> {
  await LocalStorage.setItem(SELECTED_SESSION_REF_KEY, serializeSessionRef(ref));
  await retireLegacySelection();
  // A pinned command follows its own selection, so an action fired right after
  // selecting targets the new Session rather than the pinned one.
  if (pinnedSession !== undefined) pinnedSession = ref;
}

/** Deleting the Selected Session clears the selection; stopping it does not. */
export async function clearSelectedSessionIf(ref: SessionRef): Promise<void> {
  if (!sameSessionRef(await getSelectedSession(), ref)) return;
  await LocalStorage.removeItem(SELECTED_SESSION_REF_KEY);
  // The pre-ref key may be what named this Session, and leaving it would bring
  // the deleted Session back as the selection on the next read.
  await retireLegacySelection();
}

/** The Preferred Session: the "Default Session" preference, or Herdr's own default. Always on the Local Host. */
export function getPreferredSession(): SessionRef {
  return { name: getHerdrPreferences().sessionName?.trim() || DEFAULT_SESSION };
}

let pinnedSession: SessionRef | undefined;
let pinToken = 0;

/**
 * Pins the Session a view targets for as long as it is on screen, and returns
 * the release. A view resolves the Session once and shows one Session's
 * Snapshot, while every action re-resolves independently; without the pin, a
 * selection made in another command retargets those actions at a Session the
 * user is not looking at. Pane and Tab ids are Session-scoped and collide
 * across Sessions, so an action would land on a real but wrong resource.
 */
export function pinSession(ref: SessionRef): () => void {
  pinnedSession = ref;
  // Released by identity: a selection made while pinned moves the pin to the
  // new Session, and a release that compared refs would then leave it behind.
  const token = ++pinToken;
  return () => {
    if (pinToken === token) pinnedSession = undefined;
  };
}

/** Drops any pin. For tests and for a command that stops showing one Session. */
export function releaseSessionPin(): void {
  pinnedSession = undefined;
}

/**
 * The Session a CLI call or terminal launch targets. An explicit ref wins, and
 * an empty name still means "no --session flag"; then the Session pinned by the
 * view on screen, the Selected Session, the Preferred Session, and Herdr's
 * default. Every caller resolves here so a future follow-terminal-focus layer
 * has one place to slot in above the stored selection.
 */
export async function resolveSessionRef(explicit?: SessionRef): Promise<SessionRef> {
  if (explicit !== undefined) return explicit;
  return pinnedSession ?? (await resolveStoredSession());
}

/**
 * The Selected Session as persisted, or the Preferred Session, ignoring any pin.
 * A view refreshes through this so it can discover a selection made in another
 * command; the pin exists for the actions that view fires, not for its reads.
 */
export async function resolveStoredSession(): Promise<SessionRef> {
  return (await getSelectedSession()) ?? getPreferredSession();
}
