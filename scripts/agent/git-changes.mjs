/** Include committed, staged, unstaged and new files against the task's fixed base. */
import { execFileSync } from "node:child_process";

export function resolveTaskBase(cwd = process.cwd(), baseRef = process.env.AGENT_BASE_SHA || "origin/main") {
  return execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function getTaskChanges({ cwd = process.cwd(), baseRef = process.env.AGENT_BASE_SHA || "origin/main" } = {}) {
  const base = resolveTaskBase(cwd, baseRef);
  execFileSync("git", ["add", "-N", "."], { cwd, stdio: "ignore" });
  const options = { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 };
  const paths = [base, "--", ".", ":(exclude).pi"];
  return {
    files: execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", ...paths], options).split("\0").filter(Boolean),
    diff: execFileSync("git", ["diff", "--no-renames", ...paths], options),
  };
}
