import type { ClipType } from "../types";

const URL_RE = /^(https?:\/\/|www\.)[^\s]+$/i;

const CODE_HINTS: RegExp[] = [
  /\b(function|const|let|var|return|import|export|class|interface|enum)\b/,
  /\b(def|lambda|elif|self\.|print\()/,
  /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY)\b/i,
  /\b(fn|impl|struct|pub|mut|match)\b/,
  /=>|::|->|<\/|\{\s*$|;\s*$/m,
  /^\s*(#include|#!\/|package |using |namespace )/m,
  /^\s*(docker|git|npm|cargo|curl|sudo|brew|kubectl)\s+\w+/m,
  /^[\s]*[$>]\s+\w+/m,
];

export function classify(text: string): ClipType {
  const trimmed = text.trim();
  if (URL_RE.test(trimmed)) return "link";

  let score = 0;
  for (const re of CODE_HINTS) if (re.test(trimmed)) score++;
  // Multi-line + indentation is a strong signal alongside any keyword hit
  const indented = /\n[ \t]{2,}\S/.test(trimmed);
  if (score >= 2 || (score >= 1 && indented)) return "code";

  return "text";
}
