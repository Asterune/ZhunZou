/**
 * One project, one entry.
 *
 * The hub learns a project's name from whatever the client reports: a folder
 * basename, an editor setting, or a label someone typed into the dashboard.
 * Those sources disagree about case and trailing punctuation, so one checkout
 * can arrive as `FitAI-`, `FitAI` and `fitai` — three rows that split tickets,
 * sessions and the project picker.
 *
 * Matching therefore happens on a key that ignores case, whitespace runs and
 * trailing separators, while the display name stays a spelling the hub has
 * already stored. Nothing here invents a prettier name: a project called
 * `FitAI-` keeps its dash.
 */

/** Matching key shared by every spelling of one project. */
export function projectKey(name: string): string {
  return projectDisplayName(name)
    .toLowerCase()
    .replace(/[\s._-]+$/, '');
}

/** The spelling the hub stores: trimmed, with inner whitespace collapsed. */
export function projectDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * The first spelling already known for this project, else the cleaned input.
 *
 * Callers pass candidates in preference order, so the platform decides which
 * spelling wins (the repository prefers the most-used one).
 */
export function canonicalProjectName(
  name: string,
  existing: Iterable<string>,
): string {
  const key = projectKey(name);
  const cleaned = projectDisplayName(name);
  if (!key) return cleaned;
  for (const candidate of existing) {
    if (projectKey(candidate) === key) return projectDisplayName(candidate);
  }
  return cleaned;
}

/** One label per project, keeping the first spelling seen. */
export function dedupeProjectNames(names: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const name = projectDisplayName(raw);
    const key = projectKey(name);
    if (!key || seen.has(key)) continue;
    seen.set(key, name);
  }
  return [...seen.values()];
}
