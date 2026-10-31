#!/usr/bin/env node
/** Fetch task text while retaining authorship for machine-generated markers. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isPipelinePublisher(comment, login = process.env.AGENT_PUBLISHER_LOGIN || "github-actions[bot]") {
  return Boolean(login && comment?.author?.login?.toLowerCase() === login.toLowerCase());
}

export function stripPipelineMarkers(text) {
  return String(text || "").replace(/<!--\s*pi:(?:refined-spec|verification)\b[\s\S]*?(?:-->|$)/gi, "");
}

export function filterTaskThread(thread, canWrite, publisherLogin) {
  const filter = (comments = []) => comments.filter((comment) => {
    const login = comment?.author?.login;
    return login && (isPipelinePublisher(comment, publisherLogin) || canWrite(login));
  });
  return { ...thread, comments: filter(thread.comments), reviews: filter(thread.reviews) };
}

export function formatTaskThread(thread, kind = "issue") {
  const lines = [`# ${kind === "pr" ? "Pull request" : "Issue"} #${thread.number}: ${stripPipelineMarkers(thread.title)}`, "", stripPipelineMarkers(thread.body)];
  for (const comment of [...(thread.comments || []), ...(thread.reviews || [])]) {
    lines.push("", "---", `@${comment.author.login}${comment.path ? ` on ${comment.path}` : ""}:`, stripPipelineMarkers(comment.body));
  }
  return lines.join("\n") + "\n";
}

export function fetchTaskThread({
  kind,
  number,
  repository = process.env.GITHUB_REPOSITORY,
  publisherLogin = process.env.AGENT_PUBLISHER_LOGIN || "github-actions[bot]",
  gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }),
}) {
  if (!["issue", "pr"].includes(kind) || !/^\d+$/.test(String(number)) || !/^[\w.-]+\/[\w.-]+$/.test(repository || "")) {
    throw new Error("Task intake requires an issue/pr number and an explicit owner/repository.");
  }
  // REST preserves exact bot logins (including [bot]) and paginates every thread.
  const root = `repos/${repository}`;
  const thread = JSON.parse(gh(["api", `${root}/${kind === "pr" ? "pulls" : "issues"}/${number}`]));
  const comments = (endpoint) => JSON.parse(gh(["api", endpoint, "--paginate", "--slurp"]))
    .flat().map((item) => ({ ...item, author: item.user }));
  thread.comments = comments(`${root}/issues/${number}/comments`);
  if (kind === "pr") {
    thread.comments.push(...comments(`${root}/pulls/${number}/comments`));
    thread.reviews = comments(`${root}/pulls/${number}/reviews`);
  }
  const permissions = new Map();
  const canWrite = (login) => {
    if (!permissions.has(login)) {
      try {
        const result = JSON.parse(gh(["api", `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`]));
        permissions.set(login, ["admin", "maintain", "write"].includes(result.permission));
      } catch {
        // An absent author or failed permission lookup never grants instruction access.
        permissions.set(login, false);
      }
    }
    return permissions.get(login);
  };
  return filterTaskThread(thread, canWrite, publisherLogin);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [kind, number, outputDir = ".pi/artifacts", append] = process.argv.slice(2);
    const thread = fetchTaskThread({ kind, number });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, `task-${kind}.json`), JSON.stringify(thread, null, 2) + "\n");
    fs.writeFileSync(path.join(outputDir, "task-prompt.txt"), formatTaskThread(thread, kind), { flag: append === "--append" ? "a" : "w" });
  } catch (err) {
    console.error(`[task-intake] ${err.message}`);
    process.exit(1);
  }
}
