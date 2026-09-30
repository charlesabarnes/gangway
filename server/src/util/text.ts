/** `s` without the run of `ch` at its end, in linear time (a `/-+$/` regex backtracks). */
export function trimEndChar(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) {
    end--;
  }
  return s.slice(0, end);
}

/** `s` with each whitespace run that holds a newline taken out, without a backtracking regex. */
export const dropNewlineRuns = (s: string): string =>
  s.replace(/\s+/g, (run) => (run.includes("\n") ? "" : run));
