// In Herdr, route native wheel events to the center of its keyboard-focused
// pane. Outside the terminal, the native helper falls back to the pointer so
// scroll mode keeps behaving like an ordinary system wheel.
import type { HerdrClient, SessionSnapshot } from "./herdr.js";
import { terminalWindowOwner } from "./terminal.js";
import {
  postScroll,
  postSystemScroll,
  type ScrollOperation,
} from "./tapkey.js";

export type ScrollDirection = "up" | "down";

const REVERSAL_BRAKE_MS = 120;
// The native helper rejects batches beyond this many lines per invocation.
const MAX_LINES_PER_CALL = 120;

export interface ScrollController {
  scroll(direction: ScrollDirection): Promise<void> | void;
  stop(): void;
}

interface PaneTarget {
  windowX: number;
  windowY: number;
}

type PostHostScroll = typeof postScroll;
type PostFallbackScroll = typeof postSystemScroll;

function focusedTarget(snapshot: SessionSnapshot): PaneTarget | null {
  const paneId = snapshot.focused_pane_id;
  if (!paneId) return null;
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane?.tab_id) return null;
  const layout = snapshot.layouts.find(
    (candidate) => candidate.tab_id === pane.tab_id,
  );
  const placement = layout?.panes.find(
    (candidate) => candidate.pane_id === paneId,
  );
  if (!layout || !placement) return null;

  const totalCols = layout.area.x + layout.area.width;
  const totalRows = layout.area.y + layout.area.height;
  if (totalCols < 1 || totalRows < 1) return null;
  return {
    // The native helper maps these outer-terminal cell fractions onto the
    // terminal window and commits the pointer move before scrolling, which
    // Ghostty needs to route the wheel gesture to the virtual pane.
    windowX: (placement.rect.x + placement.rect.width / 2) / totalCols,
    windowY: (placement.rect.y + placement.rect.height / 2) / totalRows,
  };
}

export class HerdrScroller implements ScrollController {
  private generation = 0;
  // Signed wheel lines awaiting delivery. Detents arriving while a helper is
  // in flight fold in here and drain as one batch, so a fast spin buffers at
  // most one helper call of latency instead of a process per detent.
  private buffered = 0;
  private drain: Promise<void> | null = null;
  private operation: ScrollOperation | null = null;
  private direction: ScrollDirection | null = null;
  private brakeUntil = 0;

  constructor(
    private herdr: HerdrClient,
    private log: (message: string) => void,
    private stepsPerTick: () => number = () => 1,
    private postHostScroll: PostHostScroll = postScroll,
    private postFallbackScroll: PostFallbackScroll = postSystemScroll,
    private now: () => number = () => performance.now(),
  ) {}

  scroll(direction: ScrollDirection): Promise<void> {
    const now = this.now();
    if (now < this.brakeUntil) return Promise.resolve();
    this.brakeUntil = 0;

    if (
      this.direction !== null &&
      direction !== this.direction &&
      (this.buffered !== 0 || this.drain !== null)
    ) {
      this.cancelBufferedScroll();
      this.direction = direction;
      this.brakeUntil = now + REVERSAL_BRAKE_MS;
      return Promise.resolve();
    }
    this.direction = direction;
    // Captured per detent, so a live scroll_steps reload cannot retroactively
    // change work the user already dialed in.
    this.buffered += (direction === "up" ? 1 : -1) * this.stepsPerTick();
    return this.ensureDrain();
  }

  // Invalidates a snapshot lookup already in flight when the user leaves
  // scroll mode or the device disconnects.
  stop(): void {
    this.cancelBufferedScroll();
    this.direction = null;
    this.brakeUntil = 0;
  }

  private ensureDrain(): Promise<void> {
    if (this.drain === null) {
      const drain: Promise<void> = this.runDrain()
        .catch((error: Error) => this.log(`scroll failed: ${error.message}`))
        .finally(() => {
          if (this.drain === drain) this.drain = null;
        });
      this.drain = drain;
    }
    return this.drain;
  }

  private async runDrain(): Promise<void> {
    const generation = this.generation;
    while (generation === this.generation && this.buffered !== 0) {
      const lines = Math.max(
        -MAX_LINES_PER_CALL,
        Math.min(MAX_LINES_PER_CALL, this.buffered),
      );
      this.buffered -= lines;
      let target: PaneTarget | null = null;
      try {
        target = focusedTarget(await this.herdr.sessionSnapshot());
      } catch (error) {
        // Losing Herdr must not take plain wheel behavior down with it:
        // without a snapshot, scroll beneath the pointer like a real wheel.
        this.log(`focus-aware scroll failed: ${(error as Error).message}`);
      }
      if (generation !== this.generation) return;
      const owner = terminalWindowOwner();
      const operation =
        target && owner
          ? this.postHostScroll(
              lines,
              target.windowX,
              target.windowY,
              owner,
              this.log,
            )
          : this.postFallbackScroll(lines, this.log);
      this.operation = operation;
      try {
        await operation.done;
      } finally {
        if (this.operation === operation) this.operation = null;
      }
    }
  }

  private cancelBufferedScroll(): void {
    this.generation += 1;
    this.buffered = 0;
    this.drain = null;
    this.operation?.cancel();
    this.operation = null;
  }
}
