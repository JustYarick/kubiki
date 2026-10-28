/** Stable partition: selected choices first, preserving order within both groups. */
export function selectedFirst<T>(items: readonly T[], selected: (item: T) => boolean): T[] {
  const active: T[] = []; const rest: T[] = [];
  for (const item of items) (selected(item) ? active : rest).push(item);
  return [...active, ...rest];
}
