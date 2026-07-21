export const POINTER_REORDER_THRESHOLD_PX = 6;

export type HorizontalReorderItem<T extends string = string> = {
  id: T;
  left: number;
  right: number;
};

export type HorizontalReorderTarget<T extends string = string> = {
  targetId: T;
  position: "before" | "after";
};

export function crossedPointerReorderThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  thresholdPx = POINTER_REORDER_THRESHOLD_PX,
): boolean {
  if (
    !Number.isFinite(startX) ||
    !Number.isFinite(startY) ||
    !Number.isFinite(currentX) ||
    !Number.isFinite(currentY) ||
    !Number.isFinite(thresholdPx) ||
    thresholdPx < 0
  ) {
    return false;
  }
  return Math.hypot(currentX - startX, currentY - startY) >= thresholdPx;
}

export function horizontalReorderTarget<T extends string>(
  items: readonly HorizontalReorderItem<T>[],
  draggedId: T,
  pointerX: number,
): HorizontalReorderTarget<T> | null {
  if (!Number.isFinite(pointerX)) return null;
  const candidates = items.filter(
    (item) =>
      item.id !== draggedId &&
      Number.isFinite(item.left) &&
      Number.isFinite(item.right) &&
      item.right >= item.left,
  );
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    if (pointerX < candidate.left + (candidate.right - candidate.left) / 2) {
      return { targetId: candidate.id, position: "before" };
    }
  }
  return { targetId: candidates[candidates.length - 1].id, position: "after" };
}
