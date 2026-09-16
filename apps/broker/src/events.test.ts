import { describe, expect, it } from "vitest";
import { EventQueue } from "./events.js";
import { Persisted, type EventState } from "./store.js";

function memoryStore(): Persisted<EventState> {
  return new Persisted<EventState>(null, { seq: 0, events: [] });
}

describe("EventQueue", () => {
  it("delivers events only to owners named in targets", () => {
    const queue = new EventQueue(memoryStore());
    queue.push(["owner-a"], "webhook", { hello: "a" }, 1_000);
    queue.push(["owner-b"], "webhook", { hello: "b" }, 1_000);
    const forA = queue.list(["owner-a"], 0, 100, 1_000);
    expect(forA.events).toHaveLength(1);
    expect(forA.events[0]?.payload).toEqual({ hello: "a" });
  });

  it("pages with a cursor that advances past delivered events", () => {
    const queue = new EventQueue(memoryStore());
    for (let i = 0; i < 5; i += 1) queue.push(["owner"], "webhook", { i }, 1_000);
    const first = queue.list(["owner"], 0, 2, 1_000);
    expect(first.events.map((event) => (event.payload as { i: number }).i)).toEqual([0, 1]);
    const second = queue.list(["owner"], first.cursor, 2, 1_000);
    expect(second.events.map((event) => (event.payload as { i: number }).i)).toEqual([2, 3]);
  });

  it("advances the cursor to the latest sequence even with nothing new to deliver", () => {
    const queue = new EventQueue(memoryStore());
    queue.push(["owner"], "webhook", {}, 1_000);
    const result = queue.list(["someone-else"], 0, 100, 1_000);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(1);
  });

  it("drops events older than the TTL", () => {
    const queue = new EventQueue(memoryStore(), 1_000);
    queue.push(["owner"], "webhook", {}, 0);
    expect(queue.size).toBe(1);
    queue.sweep(2_000);
    expect(queue.size).toBe(0);
  });
});
