import { describe, expect, it } from "vitest";
import { INITIAL_TASKS } from "../../public/tasks.js";

describe("Initial task seed data", () => {
  it("starts with 8 sample tasks spanning every priority and status", () => {
    expect(INITIAL_TASKS).toHaveLength(8);

    const priorities = new Set(INITIAL_TASKS.map((t) => t.priority));
    expect(priorities).toEqual(new Set(["low", "medium", "high", "critical"]));

    const statuses = new Set(INITIAL_TASKS.map((t) => t.status));
    expect(statuses).toEqual(new Set(["todo", "in_progress", "done"]));

    const ids = INITIAL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes the counts the UI stats cards derive from the seed data", () => {
    const total = INITIAL_TASKS.length;
    const completed = INITIAL_TASKS.filter((t) => t.status === "done").length;
    const criticalOpen = INITIAL_TASKS.filter(
      (t) => t.priority === "critical" && t.status !== "done"
    ).length;

    expect(total).toBe(8);
    expect(completed).toBe(4);
    expect(Math.round((completed / total) * 100)).toBe(50);
    expect(criticalOpen).toBe(1);
  });
});