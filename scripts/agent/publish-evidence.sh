#!/usr/bin/env bash
# Publishes a UI screenshot to the orphan `agent-evidence` branch so it can be shown inline
# in a PR comment. The branch is never merged, so binary screenshots stay out of `main`.
#
# Usage: publish-evidence.sh <png-path> <pr-number> <run-id> [<suffix>]
# Prints the in-repo path of the stored screenshot on success.
set -euo pipefail

PNG_PATH="$1"
PR_NUM="$2"
RUN_ID="$3"
SUFFIX="${4:-}"
EVIDENCE_BRANCH="${EVIDENCE_BRANCH:-agent-evidence}"
MAX_BYTES="${EVIDENCE_MAX_BYTES:-5000000}"
if [ -n "$SUFFIX" ]; then
  SAFE_SUFFIX="$(printf '%s' "$SUFFIX" | tr -cd 'A-Za-z0-9._-')"
  TARGET_PATH="pr-${PR_NUM}/run-${RUN_ID}-${SAFE_SUFFIX}.png"
else
  TARGET_PATH="pr-${PR_NUM}/run-${RUN_ID}.png"
fi

if [ ! -s "$PNG_PATH" ]; then
  echo "No screenshot at ${PNG_PATH}; nothing to publish." >&2
  exit 0
fi
if [ "$(wc -c < "$PNG_PATH")" -gt "$MAX_BYTES" ]; then
  echo "Screenshot larger than ${MAX_BYTES} bytes; skipping." >&2
  exit 0
fi

# Build the commit with plumbing in a throwaway index, so the working tree and the
# checked-out PR branch are never touched. Retries cover concurrent publish jobs.
for attempt in 1 2 3; do
  PARENT=""
  if git fetch --quiet --depth 1 origin "refs/heads/${EVIDENCE_BRANCH}" 2>/dev/null; then
    PARENT="$(git rev-parse FETCH_HEAD)"
  fi

  export GIT_INDEX_FILE
  GIT_INDEX_FILE="$(mktemp -u)"
  if [ -n "$PARENT" ]; then
    git read-tree "$PARENT"
  else
    git read-tree --empty
  fi
  BLOB="$(git hash-object -w "$PNG_PATH")"
  git update-index --add --cacheinfo "100644,${BLOB},${TARGET_PATH}"
  TREE="$(git write-tree)"
  rm -f "$GIT_INDEX_FILE"
  unset GIT_INDEX_FILE

  COMMIT="$(git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "evidence: PR #${PR_NUM} run ${RUN_ID}")"
  if git push --quiet origin "${COMMIT}:refs/heads/${EVIDENCE_BRANCH}"; then
    echo "$TARGET_PATH"
    exit 0
  fi
  echo "Push to ${EVIDENCE_BRANCH} rejected (attempt ${attempt}); retrying." >&2
  sleep $((attempt * 2))
done

echo "Could not publish evidence after 3 attempts." >&2
exit 1
