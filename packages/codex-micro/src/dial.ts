export const DIAL_MODES = ["workspaces", "agents", "scroll"] as const;

export type DialMode = (typeof DIAL_MODES)[number];

export const DEFAULT_DIAL_MODE_ORDER: readonly DialMode[] = DIAL_MODES;
