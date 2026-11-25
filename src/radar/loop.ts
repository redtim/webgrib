/**
 * The set of frames in an animation loop and which one is in view. Frames are
 * identified by their bucket key, which sorts by scan time.
 */

const FRAME_MS = 300;
const NEWEST_FRAME_MS = 1500;

/** How long playback rests on a frame. */
export function frameDelay(index: number, length: number): number {
  return index === length - 1 ? NEWEST_FRAME_MS : FRAME_MS;
}

export class FrameLoop<T extends { key: string }> {
  /** Loaded frames, oldest first. */
  frames: T[] = [];
  index = 0;
  private wanted = new Set<string>();
  /** The viewer has picked a frame, so arrivals must not move the view. */
  private moved = false;
  private readonly followNewest: boolean;

  /** `followNewest`: whether a view on the newest frame moves to later arrivals. */
  constructor({ followNewest = true }: { followNewest?: boolean } = {}) {
    this.followNewest = followNewest;
  }

  get current(): T | undefined {
    return this.frames[this.index];
  }

  /**
   * Set which scans belong in the loop, dropping any others. Returns the keys
   * still to be loaded, newest first.
   */
  setWindow(keys: string[]): string[] {
    this.wanted = new Set(keys);
    const inView = this.current?.key;
    this.frames = this.frames.filter((f) => this.wanted.has(f.key));
    const kept = this.frames.findIndex((f) => f.key === inView);
    // The viewer's choice of frame lapses once that frame leaves the window.
    if (kept < 0) this.moved = false;
    this.index = Math.max(0, kept);
    const held = new Set(this.frames.map((f) => f.key));
    return keys.filter((k) => !held.has(k)).sort().reverse();
  }

  /**
   * Insert a loaded frame. A view resting on the newest frame follows a newer
   * one; otherwise the same scan stays in view.
   */
  add(frame: T): void {
    if (!this.wanted.has(frame.key) || this.frames.some((f) => f.key === frame.key)) return;
    const inView = this.current;
    const wasNewest = this.followNewest && this.index === this.frames.length - 1;
    this.frames = [...this.frames, frame].sort((a, b) => (a.key < b.key ? -1 : 1));
    // Following means moving to a later arrival, never back to an earlier one.
    const follow = !inView || (wasNewest && frame.key > inView.key);
    if (!this.followNewest && !this.moved) this.index = 0;
    else this.index = this.frames.indexOf(follow ? this.frames[this.frames.length - 1]! : inView);
  }

  seek(index: number): void {
    this.moved = true;
    this.index = Math.max(0, Math.min(index, this.frames.length - 1));
  }

  step(by: number): void {
    const n = this.frames.length;
    this.moved = true;
    if (n > 0) this.index = (((this.index + by) % n) + n) % n;
  }
}
