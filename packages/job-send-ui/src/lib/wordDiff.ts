/** One run of a word-level diff: text both versions share, or text only the newer (added) or older (removed) has. */
export type DiffSegment = { kind: "same" | "added" | "removed"; text: string };

/** Words and the whitespace between them, so joining every token gives back the exact text. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * The word-level difference from `before` to `after`, computed in the browser from the two stored texts (spec:
 * "Approval and revision"). Joining the "same" and "added" segments gives `after` exactly; joining "same" and
 * "removed" gives `before`. Inputs are bounded by the job's field rules, so the quadratic table stays small.
 */
export function wordDiff(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const width = b.length + 1;
  // lcs[i * width + j]: the length of the longest common token run between a[i..] and b[j..].
  const lcs = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] ?? "";
    const right = b[j] ?? "";
    if (left === right) {
      push("same", left);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push("removed", left);
      i += 1;
    } else {
      push("added", right);
      j += 1;
    }
  }
  for (const token of a.slice(i)) push("removed", token);
  for (const token of b.slice(j)) push("added", token);
  return segments;
}
