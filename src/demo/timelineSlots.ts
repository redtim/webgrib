/**
 * Pure helpers that decide which forecast hours the timeline offers. A slot is
 * one tick: a forecast hour of a specific model cycle. Kept free of DOM access
 * so it can be unit tested.
 */

export type DeterministicModel = 'hrrr' | 'rrfs';

export interface TimelineSlot {
  cycle: string;
  fhour: number;
  validMs: number;
}

const HOUR_MS = 3600000;

export function parseCycleUTC(cycle: string): Date {
  return new Date(Date.UTC(
    Number(cycle.slice(0, 4)),
    Number(cycle.slice(4, 6)) - 1,
    Number(cycle.slice(6, 8)),
    Number(cycle.slice(8, 10)),
  ));
}

export function formatCycle(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  return `${y}${m}${day}${h}`;
}

const isSynoptic = (cycle: string): boolean => Number(cycle.slice(8, 10)) % 6 === 0;

/** Last forecast hour a cycle runs to: synoptic cycles run long, the rest 18 h. */
export function maxForecastHour(model: DeterministicModel, cycle: string): number {
  if (!isSynoptic(cycle)) return 18;
  return model === 'rrfs' ? 84 : 48;
}

/**
 * Candidate hourly cycles, newest first, starting `delayHours` back to allow
 * for publication. Older synoptic cycles are appended until the list holds
 * `minSynoptic` of them, so a long-range run stays on offer when the newest
 * one is not fully published yet.
 */
export function recentCycles(count: number, nowMs: number, delayHours = 3, minSynoptic = 2): string[] {
  const newest = Math.floor((nowMs - delayHours * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const cycles: string[] = [];
  for (let i = 0; i < count; i++) cycles.push(formatCycle(new Date(newest - i * HOUR_MS)));
  let synoptic = cycles.filter(isSynoptic).length;
  for (let t = newest - count * HOUR_MS; synoptic < minSynoptic; t -= HOUR_MS) {
    const c = formatCycle(new Date(t));
    if (!isSynoptic(c)) continue;
    cycles.push(c);
    synoptic++;
  }
  return cycles;
}

/** Slots for the given forecast hours of a single cycle. */
export function cycleSlots(cycle: string, fhours: readonly number[]): TimelineSlot[] {
  const cycleMs = parseCycleUTC(cycle).getTime();
  return fhours.map((fhour) => ({ cycle, fhour, validMs: cycleMs + fhour * HOUR_MS }));
}

/** Every hourly slot of one deterministic cycle. */
export function deterministicSlots(model: DeterministicModel, cycle: string): TimelineSlot[] {
  const max = maxForecastHour(model, cycle);
  return cycleSlots(cycle, Array.from({ length: max + 1 }, (_, h) => h));
}

/**
 * The longest timeline the available cycles support: each valid time comes
 * from the newest cycle that reaches it. The newest cycle supplies its whole
 * run, then older, longer-running cycles extend it past its last hour.
 */
export function blendedSlots(model: DeterministicModel, cycles: readonly string[]): TimelineSlot[] {
  const newestFirst = [...cycles].sort().reverse();
  const slots: TimelineSlot[] = [];
  for (const cycle of newestFirst) {
    const endMs = slots.length > 0 ? slots[slots.length - 1]!.validMs : -Infinity;
    for (const slot of deterministicSlots(model, cycle)) {
      if (slot.validMs > endMs) slots.push(slot);
    }
  }
  return slots;
}

/** Index of the slot whose valid time is closest to `validMs` (0 if empty). */
export function nearestSlotIndex(slots: readonly TimelineSlot[], validMs: number): number {
  let best = 0;
  for (let i = 1; i < slots.length; i++) {
    if (Math.abs(slots[i]!.validMs - validMs) < Math.abs(slots[best]!.validMs - validMs)) best = i;
  }
  return best;
}
