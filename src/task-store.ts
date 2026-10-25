export type TaskPriority = "low" | "medium" | "high" | "critical";
export type TaskStatus = "todo" | "in_progress" | "done";

export interface EngineeringTask {
  id: string;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  estimatePoints: number;
  tags: string[];
  createdAt: string;
}

export interface SprintSummary {
  totalTasks: number;
  completedTasks: number;
  completionRatePct: number;
  totalPoints: number;
  completedPoints: number;
  criticalOpenCount: number;
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Detached copy, so callers can never change stored tasks (or their tags) behind the store's validation. */
function copyTask(task: EngineeringTask): EngineeringTask {
  return { ...task, tags: [...task.tags] };
}

export class TaskStore {
  private tasks: Map<string, EngineeringTask> = new Map();

  constructor(initialTasks: EngineeringTask[] = []) {
    for (const task of initialTasks) {
      this.tasks.set(task.id, copyTask(task));
    }
  }

  addTask(input: {
    id?: string;
    title: string;
    priority?: TaskPriority;
    status?: TaskStatus;
    estimatePoints?: number;
    tags?: string[];
  }): EngineeringTask {
    const trimmedTitle = input.title.trim();
    if (!trimmedTitle) {
      throw new Error("Task title cannot be empty");
    }
    const points = input.estimatePoints ?? 1;
    if (points < 0 || !Number.isFinite(points)) {
      throw new Error("Estimate points must be a non-negative number");
    }

    const task: EngineeringTask = {
      id: input.id || this.nextTaskId(),
      title: trimmedTitle,
      priority: input.priority || "medium",
      status: input.status || "todo",
      estimatePoints: points,
      tags: input.tags ? [...input.tags] : [],
      createdAt: new Date().toISOString(),
    };

    this.tasks.set(task.id, task);
    return copyTask(task);
  }

  /**
   * Allocates the next free task id, skipping ids that are still in use, so a
   * clear-then-add cycle can never overwrite a task that is still present.
   */
  private nextTaskId(): string {
    let counter = this.tasks.size + 1;
    while (this.tasks.has(`task-${counter}`)) {
      counter += 1;
    }
    return `task-${counter}`;
  }

  removeTask(id: string): boolean {
    return this.tasks.delete(id);
  }

  clearCompleted(): number {
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (task.status === "done") {
        this.tasks.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  updateStatus(id: string, status: TaskStatus): EngineeringTask {
    const existing = this.tasks.get(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }
    existing.status = status;
    return copyTask(existing);
  }

  listTasks(filter?: {
    status?: TaskStatus;
    priority?: TaskPriority;
    search?: string;
  }): EngineeringTask[] {
    const query = filter?.search?.trim().toLowerCase() || "";
    return Array.from(this.tasks.values())
      .filter((t) => {
        if (filter?.status && t.status !== filter.status) return false;
        if (filter?.priority && t.priority !== filter.priority) return false;
        if (query) {
          const inTitle = t.title.toLowerCase().includes(query);
          const inTags = t.tags.some((tag) => tag.toLowerCase().includes(query));
          if (!inTitle && !inTags) return false;
        }
        return true;
      })
      .sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
      .map(copyTask);
  }

  getSummary(): SprintSummary {
    const all = Array.from(this.tasks.values());
    const totalTasks = all.length;
    const completedTasks = all.filter((t) => t.status === "done").length;
    const totalPoints = all.reduce((sum, t) => sum + t.estimatePoints, 0);
    const completedPoints = all
      .filter((t) => t.status === "done")
      .reduce((sum, t) => sum + t.estimatePoints, 0);
    const criticalOpenCount = all.filter(
      (t) => t.priority === "critical" && t.status !== "done"
    ).length;

    const completionRatePct =
      totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

    return {
      totalTasks,
      completedTasks,
      completionRatePct,
      totalPoints,
      completedPoints,
      criticalOpenCount,
    };
  }
}
