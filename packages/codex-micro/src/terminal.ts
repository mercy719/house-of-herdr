// Identifying the terminal Herdr is running in, and bringing it forward.
//
// Two names per terminal because the two consumers key off different things:
// tapkey matches CGWindowList's owner name when it aims a scroll, while `open`
// resolves a bundle id. They are not interchangeable - iTerm2's windows are
// owned by "iTerm2" but the app itself ships as iTerm.app, so an `open -a`
// on the owner name would miss it.
import { spawn } from "node:child_process";

export interface HostTerminal {
  owner: string;
  bundleId: string;
}

const BY_TERM_PROGRAM: Record<string, HostTerminal> = {
  ghostty: { owner: "Ghostty", bundleId: "com.mitchellh.ghostty" },
  "iterm.app": { owner: "iTerm2", bundleId: "com.googlecode.iterm2" },
  apple_terminal: { owner: "Terminal", bundleId: "com.apple.Terminal" },
  wezterm: { owner: "WezTerm", bundleId: "com.github.wez.wezterm" },
};

const KITTY: HostTerminal = {
  owner: "kitty",
  bundleId: "net.kovidgoyal.kitty",
};
const ALACRITTY: HostTerminal = {
  owner: "Alacritty",
  bundleId: "org.alacritty",
};

export function hostTerminal(): HostTerminal | null {
  // kitty and Alacritty never set TERM_PROGRAM and pass an inherited value
  // through untouched, so their own variables must win over a stale one.
  if (process.env.KITTY_WINDOW_ID) return KITTY;
  if (process.env.ALACRITTY_WINDOW_ID) return ALACRITTY;
  return (
    BY_TERM_PROGRAM[(process.env.TERM_PROGRAM ?? "").toLowerCase()] ?? null
  );
}

export function terminalWindowOwner(): string | null {
  return hostTerminal()?.owner ?? null;
}

/**
 * Brings the host terminal to the front. `open` activates an already-running
 * app and needs no macOS permission, which matters because this has to work
 * for the many setups that never grant Accessibility.
 *
 * Falls back to the app name when the bundle id does not resolve, so a
 * terminal that ships under a bundle id this table has wrong still comes
 * forward.
 */
export function raiseTerminal(log: (message: string) => void): void {
  const terminal = hostTerminal();
  if (!terminal) return;
  runOpen(["-b", terminal.bundleId], () =>
    runOpen(["-a", terminal.owner], () =>
      log(`could not raise ${terminal.owner}`),
    ),
  );
}

function runOpen(args: string[], onFailure: () => void): void {
  const child = spawn("/usr/bin/open", args, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.on("close", (status) => {
    if (status !== 0) onFailure();
  });
  child.on("error", onFailure);
}
