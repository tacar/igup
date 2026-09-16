import type { EventState, Persisted, StoredEvent } from "./store.js";

export type PublicEvent = { id: number; at: string; type: StoredEvent["type"]; payload: unknown };

/**
 * Per-owner event queue. Webhook deliveries and seminar sign-ups wait here until the desktop polls them,
 * so the PC never has to be reachable from the internet.
 */
export class EventQueue {
  constructor(private readonly store: Persisted<EventState>, private readonly ttlMs = 24 * 3_600_000, private readonly maxEvents = 5_000) {}

  push(targets: string[], type: StoredEvent["type"], payload: unknown, now = Date.now()): StoredEvent {
    this.sweep(now);
    const state = this.store.value;
    state.seq += 1;
    const event: StoredEvent = {
      id: state.seq,
      at: new Date(now).toISOString(),
      type,
      targets: [...new Set(targets.filter((target) => typeof target === "string" && target.length > 0))],
      payload,
    };
    state.events.push(event);
    if (state.events.length > this.maxEvents) state.events.splice(0, state.events.length - this.maxEvents);
    this.store.save();
    return event;
  }

  list(keys: string[], after: number, limit: number, now = Date.now()): { events: PublicEvent[]; cursor: number } {
    this.sweep(now);
    const wanted = new Set(keys);
    const events: PublicEvent[] = [];
    for (const event of this.store.value.events) {
      if (event.id <= after || !event.targets.some((target) => wanted.has(target))) continue;
      events.push({ id: event.id, at: event.at, type: event.type, payload: event.payload });
      if (events.length >= limit) break;
    }
    const last = events[events.length - 1];
    return { events, cursor: last ? last.id : Math.max(after, this.store.value.seq) };
  }

  /** Drops events older than the TTL. Events are appended in order, so only the head needs checking. */
  sweep(now = Date.now()): number {
    const state = this.store.value;
    const cutoff = now - this.ttlMs;
    let index = 0;
    while (index < state.events.length && Date.parse(state.events[index]!.at) < cutoff) index += 1;
    if (index > 0) {
      state.events.splice(0, index);
      this.store.save();
    }
    return index;
  }

  get size(): number {
    return this.store.value.events.length;
  }
}
