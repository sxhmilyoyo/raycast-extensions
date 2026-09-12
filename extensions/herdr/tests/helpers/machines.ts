import type { Machine } from "../../src/lib/types";

/** The one Machine on the reference Mac, as `herdr machine list --json` printed it on Herdr 0.9.0. */
export const cddMeshclaw: Machine = {
  id: "368dca2803d6dae146d14d03ce018776",
  label: "cdd-meshclaw",
  target: "clouddesk-arm",
  session: "meshclaw",
  enabled: true,
  selected: false,
};

/** The Session Ref that selects `cddMeshclaw`. */
export const remote = { machine: cddMeshclaw.id, name: cddMeshclaw.session };
