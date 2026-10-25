import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("renders control center, queues a critical task, toggles completion, and captures verification screenshot", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  await page.goto("/");

  await expect(page.getByTestId("stack-badge")).toHaveText("Agent Pipeline Ready");
  await expect(page.getByTestId("stat-total")).toHaveText("8");
  await expect(page.getByTestId("stat-completed")).toHaveText("4");
  // One critical task is already open, so the card is highlighted on load
  await expect(page.getByTestId("stat-critical")).toHaveText("1");
  await expect(page.getByTestId("stat-critical-card")).toHaveClass(/has-critical/);

  // Progress footer reflects the initial completion state (4 of 8)
  await expect(page.getByTestId("progress-footer")).toHaveText("4 of 8 tasks completed");

  // Queue a new critical task
  await page.getByTestId("task-title-input").fill("Verify the configured agent and model provider");
  await page.getByTestId("task-priority-select").selectOption("critical");
  await page.getByTestId("add-task-btn").click();

  await expect(page.getByTestId("stat-total")).toHaveText("9");
  await expect(page.getByTestId("stat-critical")).toHaveText("2");

  // Adding a task updates the footer denominator without changing completed count
  await expect(page.getByTestId("progress-footer")).toHaveText("4 of 9 tasks completed");

  // Completing a task updates the footer numerator
  await page.getByTestId("toggle-btn-task-3").click();
  await expect(page.getByTestId("progress-footer")).toHaveText("5 of 9 tasks completed");

  // Reopening a task updates the footer numerator again
  await page.getByTestId("toggle-btn-task-3").click();
  await expect(page.getByTestId("progress-footer")).toHaveText("4 of 9 tasks completed");

  // The critical stat card stays highlighted while critical tasks are open
  await expect(page.getByTestId("stat-critical-card")).toHaveClass(/has-critical/);

  // Clear completed: button is enabled while done tasks exist
  const clearBtn = page.getByTestId("clear-completed-btn");
  await expect(clearBtn).toBeEnabled();

  await clearBtn.click();

  // Completed task rows (task-1, task-2, task-6, task-7) disappear
  await expect(page.getByTestId("task-row-task-1")).toHaveCount(0);
  await expect(page.getByTestId("task-row-task-2")).toHaveCount(0);
  await expect(page.getByTestId("task-row-task-6")).toHaveCount(0);
  await expect(page.getByTestId("task-row-task-7")).toHaveCount(0);

  // Unfinished task rows remain
  await expect(page.getByTestId("task-row-task-3")).toHaveCount(1);
  await expect(page.getByTestId("task-row-task-4")).toHaveCount(1);
  await expect(page.getByTestId("task-row-task-5")).toHaveCount(1);
  await expect(page.getByTestId("task-row-task-8")).toHaveCount(1);

  // Statistics and footer reflect the removal (the queued task remains)
  await expect(page.getByTestId("stat-total")).toHaveText("5");
  await expect(page.getByTestId("stat-completed")).toHaveText("0");
  await expect(page.getByTestId("stat-rate")).toHaveText("0%");
  await expect(page.getByTestId("stat-critical")).toHaveText("2");
  await expect(page.getByTestId("stat-critical-card")).toHaveClass(/has-critical/);
  await expect(page.getByTestId("progress-footer")).toHaveText("0 of 5 tasks completed");

  // Button is disabled when no completed tasks remain
  await expect(clearBtn).toBeDisabled();

  // Completing a remaining task re-enables the button
  await page.getByTestId("toggle-btn-task-3").click();
  await expect(page.getByTestId("progress-footer")).toHaveText("1 of 5 tasks completed");
  await expect(clearBtn).toBeEnabled();

  // Completing every remaining task switches the footer to the all-done message
  const completeButtons = page.getByRole("button", { name: "Complete", exact: true });
  while ((await completeButtons.count()) > 0) {
    await completeButtons.first().click();
  }
  await expect(page.getByTestId("stat-completed")).toHaveText("5");
  await expect(page.getByTestId("progress-footer")).toHaveText("All 5 tasks done 🎉");

  // Reopening a task restores the count text with updated counts
  await page.getByTestId("toggle-btn-task-3").click();
  await expect(page.getByTestId("progress-footer")).toHaveText("4 of 5 tasks completed");

  // Save visual verification artifact for PR / agent inspection
  const artifactsDir = path.resolve(process.cwd(), ".pi/artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  await page.screenshot({
    path: path.join(artifactsDir, "ui-verify.png"),
    fullPage: true,
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
