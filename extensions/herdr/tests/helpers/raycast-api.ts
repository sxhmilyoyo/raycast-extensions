import { vi } from "vitest";

// `@raycast/api` exists only inside Raycast, so a test whose imports reach
// LocalStorage substitutes this module:
//   vi.mock("@raycast/api", () => import("./helpers/raycast-api"));
export const storage = new Map<string, string | number | boolean>();

export const showInFinder = vi.fn();

// Only ever dereferenced at render, which no test does.
export const Icon = {} as Record<string, string>;

export const LocalStorage = {
  getItem: vi.fn(async (key: string) => storage.get(key)),
  setItem: vi.fn(async (key: string, value: string | number | boolean) => {
    storage.set(key, value);
  }),
  removeItem: vi.fn(async (key: string) => {
    storage.delete(key);
  }),
};
