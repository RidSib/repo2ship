import { INITIAL_TASKS } from "./tasks.js";

let tasks = INITIAL_TASKS.map((task) => ({ ...task }));

function render() {
  const listEl = document.getElementById("task-list");
  const totalEl = document.getElementById("stat-total");
  const completedEl = document.getElementById("stat-completed");
  const rateEl = document.getElementById("stat-rate");
  const criticalEl = document.getElementById("stat-critical");
  const criticalCardEl = document.getElementById("stat-critical-card");
  const progressFooterEl = document.querySelector('[data-testid="progress-footer"]');
  const clearCompletedBtn = document.querySelector('[data-testid="clear-completed-btn"]');

  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "done").length;
  const rate = total === 0 ? 0 : Math.round((completed / total) * 100);
  const criticalOpen = tasks.filter((t) => t.priority === "critical" && t.status !== "done").length;

  totalEl.textContent = String(total);
  completedEl.textContent = String(completed);
  rateEl.textContent = `${rate}%`;
  criticalEl.textContent = String(criticalOpen);
  criticalCardEl.classList.toggle("has-critical", criticalOpen > 0);
  if (total > 0 && completed === total) {
    progressFooterEl.textContent = `All ${total} tasks done 🎉`;
  } else {
    progressFooterEl.textContent = `${completed} of ${total} tasks completed`;
  }
  clearCompletedBtn.disabled = completed === 0;

  listEl.innerHTML = "";
  for (const task of tasks) {
    const row = document.createElement("div");
    row.className = `task-item ${task.status === "done" ? "done" : ""}`;
    row.dataset.testid = `task-row-${task.id}`;

    const left = document.createElement("div");
    const pill = document.createElement("span");
    pill.className = `priority-pill priority-${task.priority}`;
    pill.textContent = task.priority;

    const title = document.createElement("span");
    title.className = "task-title";
    title.textContent = task.title;

    left.appendChild(pill);
    left.appendChild(title);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.dataset.testid = `toggle-btn-${task.id}`;
    toggleBtn.textContent = task.status === "done" ? "Reopen" : "Complete";
    toggleBtn.addEventListener("click", () => {
      task.status = task.status === "done" ? "todo" : "done";
      render();
    });

    row.appendChild(left);
    row.appendChild(toggleBtn);
    listEl.appendChild(row);
  }
}

document.getElementById("task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("task-title-input");
  const select = document.getElementById("task-priority-select");
  const title = input.value.trim();
  if (!title) return;

  tasks.unshift({
    id: `task-${Date.now()}`,
    title,
    priority: select.value,
    status: "todo",
  });
  input.value = "";
  render();
});

document.querySelector('[data-testid="clear-completed-btn"]').addEventListener("click", () => {
  tasks = tasks.filter((task) => task.status !== "done");
  render();
});

render();
