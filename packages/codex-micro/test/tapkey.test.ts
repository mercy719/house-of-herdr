import { describe, expect, it, vi, beforeEach } from "vitest";

interface FakeChild {
  stderr: import("node:events").EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): FakeChild;
}

const { spawned } = vi.hoisted(() => ({
  spawned: [] as Array<{ command: string; args: string[]; child: FakeChild }>,
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        kill: vi.fn(),
      }) as unknown as FakeChild;
      spawned.push({ command, args, child });
      return child;
    },
  };
});

const { postKey, postScroll, postSystemScroll } =
  await import("../src/tapkey.js");

beforeEach(() => {
  spawned.length = 0;
});

describe("postScroll", () => {
  it("spawns the helper with the targeted scroll argv", async () => {
    const log = vi.fn();
    const operation = postScroll(3, 0.25, 0.5, "Ghostty", log);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command).toMatch(/bin\/tapkey$/);
    expect(spawned[0]!.args).toEqual(["scroll", "3", "0.25", "0.5", "Ghostty"]);

    spawned[0]!.child.emit("close", 0);
    await operation.done;
    expect(log).not.toHaveBeenCalled();
  });

  it("logs the helper's stderr when it exits nonzero", async () => {
    const log = vi.fn();
    const operation = postScroll(3, 0.25, 0.5, "Ghostty", log);

    spawned[0]!.child.stderr.emit("data", Buffer.from("boom\n"));
    spawned[0]!.child.emit("close", 1);
    await operation.done;

    expect(log).toHaveBeenCalledWith("scroll 3 failed: boom");
  });

  it("cancel kills the helper and suppresses its failure output", async () => {
    const log = vi.fn();
    const operation = postScroll(3, 0.25, 0.5, "Ghostty", log);

    operation.cancel();
    expect(spawned[0]!.child.kill).toHaveBeenCalledTimes(1);

    spawned[0]!.child.stderr.emit("data", Buffer.from("terminated\n"));
    spawned[0]!.child.emit("close", 1);
    await operation.done;

    expect(log).not.toHaveBeenCalled();
  });

  it("logs when the helper cannot be spawned and still settles", async () => {
    const log = vi.fn();
    const operation = postScroll(3, 0.25, 0.5, "Ghostty", log);

    spawned[0]!.child.emit("error", new Error("ENOENT"));
    await operation.done;

    expect(log).toHaveBeenCalledWith("tapkey scroll spawn failed: ENOENT");
  });
});

describe("postSystemScroll", () => {
  it("spawns the helper with the pointer-scroll argv", async () => {
    const log = vi.fn();
    const operation = postSystemScroll(-4, log);

    expect(spawned[0]!.args).toEqual(["scroll", "-4"]);

    spawned[0]!.child.emit("close", 0);
    await operation.done;
    expect(log).not.toHaveBeenCalled();
  });
});

describe("postKey", () => {
  it("spawns the helper with keycode, mode and modifier mask", () => {
    postKey({ keyCode: 55, modifiers: 3 }, "down", vi.fn());

    expect(spawned[0]!.command).toMatch(/bin\/tapkey$/);
    expect(spawned[0]!.args).toEqual(["55", "down", "3"]);
  });

  it("logs the helper's stderr when it exits nonzero", () => {
    const log = vi.fn();
    postKey({ keyCode: 55, modifiers: 0 }, "tap", log);

    spawned[0]!.child.stderr.emit("data", Buffer.from("denied\n"));
    spawned[0]!.child.emit("close", 3);

    expect(log).toHaveBeenCalledWith("key 55 tap failed: denied");
  });
});
