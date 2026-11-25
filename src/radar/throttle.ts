/**
 * A version of `write` that runs at once when idle and otherwise no more often
 * than every `intervalMs`, always running again after the last call. Safari
 * throws if the address is rewritten more than 100 times in 30 seconds.
 */
export function spaced(write: () => void, intervalMs: number): () => void {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = undefined;
    last = Date.now();
    write();
  };
  return () => {
    if (timer !== undefined) return;
    const wait = last + intervalMs - Date.now();
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };
}
