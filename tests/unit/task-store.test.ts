import { describe, expect, it } from "vitest";
import { TaskStore } from "../../src/task-store";

describe("TaskStore domain logic", () => {
  it("adds tasks with defaults and computes sprint summary accurately", () => {
    const store = new TaskStore();
    const t1 = store.addTask({
      title: "Configure the model provider",
      priority: "critical",
      status: "done",
      estimatePoints: 3,
      tags: ["provider", "agent"],
    });
    const t2 = store.addTask({
      title: "Add Langfuse JSONL trace ingestion",
      priority: "high",
      status: "todo",
      estimatePoints: 5,
      tags: ["langfuse", "observability"],
    });

    expect(t1.id).toBe("task-1");
    expect(t2.id).toBe("task-2");

    const summary = store.getSummary();
    expect(summary).toEqual({
      totalTasks: 2,
      completedTasks: 1,
      completionRatePct: 50,
      totalPoints: 8,
      completedPoints: 3,
      criticalOpenCount: 0,
    });
  });

  it("sorts tasks by priority weight (critical -> high -> medium -> low) and filters by search query", () => {
    const store = new TaskStore();
    store.addTask({ title: "Low priority cleanup", priority: "low" });
    store.addTask({ title: "Critical production fix", priority: "critical", tags: ["prod"] });
    store.addTask({ title: "High priority feature", priority: "high" });

    const ordered = store.listTasks();
    expect(ordered.map((t) => t.priority)).toEqual(["critical", "high", "low"]);

    const filtered = store.listTasks({ search: "prod" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Critical production fix");
  });

  it("updates task status and rejects empty titles", () => {
    const store = new TaskStore();
    expect(() => store.addTask({ title: "   " })).toThrow("Task title cannot be empty");

    const task = store.addTask({ title: "Write Playwright E2E test", priority: "critical" });
    expect(store.getSummary().criticalOpenCount).toBe(1);

    store.updateStatus(task.id, "done");
    expect(store.getSummary().criticalOpenCount).toBe(0);
    expect(store.getSummary().completionRatePct).toBe(100);
  });

  it("removes an existing task and updates listTasks and getSummary", () => {
    const store = new TaskStore();
    const t1 = store.addTask({
      title: "Delete me",
      priority: "critical",
      status: "done",
      estimatePoints: 3,
    });
    store.addTask({ title: "Keep me", priority: "low", estimatePoints: 2 });

    expect(store.removeTask(t1.id)).toBe(true);
    expect(store.listTasks().map((t) => t.title)).toEqual(["Keep me"]);
    expect(store.getSummary()).toEqual({
      totalTasks: 1,
      completedTasks: 0,
      completionRatePct: 0,
      totalPoints: 2,
      completedPoints: 0,
      criticalOpenCount: 0,
    });
  });

  it("returns false when removing an unknown task id", () => {
    const store = new TaskStore();
    store.addTask({ title: "Existing task" });

    expect(store.removeTask("does-not-exist")).toBe(false);
    expect(store.listTasks()).toHaveLength(1);
  });

  it("clearCompleted removes only completed tasks and returns the removed count", () => {
    const store = new TaskStore();
    const doneA = store.addTask({
      title: "Completed A",
      priority: "high",
      status: "done",
      estimatePoints: 3,
      tags: ["a"],
    });
    const todo = store.addTask({
      title: "Still todo",
      priority: "critical",
      status: "todo",
      estimatePoints: 5,
    });
    const inProgress = store.addTask({
      title: "In progress",
      priority: "medium",
      status: "in_progress",
      estimatePoints: 2,
    });
    const doneB = store.addTask({
      title: "Completed B",
      priority: "low",
      status: "done",
      estimatePoints: 1,
    });

    const removed = store.clearCompleted();

    expect(removed).toBe(2);
    const remainingIds = store.listTasks().map((t) => t.id).sort();
    expect(remainingIds).toEqual([todo.id, inProgress.id].sort());
    expect(store.listTasks().some((t) => t.id === doneA.id || t.id === doneB.id)).toBe(false);
    // Non-completed task data is preserved unchanged
    const keptTodo = store.listTasks().find((t) => t.id === todo.id);
    expect(keptTodo).toEqual({
      ...todo,
      tags: [...todo.tags],
    });
    expect(store.getSummary()).toEqual({
      totalTasks: 2,
      completedTasks: 0,
      completionRatePct: 0,
      totalPoints: 7,
      completedPoints: 0,
      criticalOpenCount: 1,
    });

    // Repeated clear removes nothing and leaves state unchanged
    expect(store.clearCompleted()).toBe(0);
    expect(store.getSummary().totalTasks).toBe(2);
  });

  it("clearCompleted removes all tasks when every task is done", () => {
    const store = new TaskStore();
    store.addTask({ title: "Done 1", status: "done", estimatePoints: 2 });
    store.addTask({ title: "Done 2", status: "done", estimatePoints: 4 });

    expect(store.clearCompleted()).toBe(2);
    expect(store.listTasks()).toEqual([]);
    expect(store.getSummary()).toEqual({
      totalTasks: 0,
      completedTasks: 0,
      completionRatePct: 0,
      totalPoints: 0,
      completedPoints: 0,
      criticalOpenCount: 0,
    });
  });

  it("clearCompleted returns 0 on an empty store", () => {
    const store = new TaskStore();

    expect(store.clearCompleted()).toBe(0);
    expect(store.listTasks()).toEqual([]);
  });

  it("allocates a fresh id when adding after a mixed-status clear", () => {
    const store = new TaskStore();
    store.addTask({ title: "Done task", status: "done", estimatePoints: 1 });
    const todo = store.addTask({ title: "Todo task", status: "todo", estimatePoints: 2 });
    const inProgress = store.addTask({
      title: "In progress task",
      status: "in_progress",
      estimatePoints: 3,
    });

    expect(store.clearCompleted()).toBe(1);

    const added = store.addTask({ title: "Added after clear" });

    // The new task must not reuse the id of any retained task
    expect(added.id).not.toBe(todo.id);
    expect(added.id).not.toBe(inProgress.id);

    // Retained unfinished tasks are preserved and the new task is present
    expect(store.listTasks().map((t) => t.id).sort()).toEqual(
      [todo.id, inProgress.id, added.id].sort()
    );
    expect(store.getSummary().totalTasks).toBe(3);
  });

  it("returns detached copies so callers cannot change stored tasks or their tags", () => {
    const store = new TaskStore();
    const added = store.addTask({ title: "Isolated task", estimatePoints: 3, tags: ["infra"] });

    // Mutating any returned object must not reach the store, which validates its own writes
    added.tags.push("leaked-from-add");
    const listed = store.listTasks()[0];
    listed.estimatePoints = -100;
    listed.tags.push("leaked-from-list");
    const updated = store.updateStatus(added.id, "in_progress");
    updated.title = "";

    const stored = store.listTasks()[0];
    expect(stored.estimatePoints).toBe(3);
    expect(stored.tags).toEqual(["infra"]);
    expect(stored.title).toBe("Isolated task");
    expect(store.getSummary().totalPoints).toBe(3);
  });
});
