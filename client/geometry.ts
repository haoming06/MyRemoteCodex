export interface SourceSize {
  width: number;
  height: number;
}

export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SourcePoint {
  x: number;
  y: number;
}

export function pointToSource(
  clientX: number,
  clientY: number,
  rect: DisplayRect,
  source: SourceSize,
): SourcePoint {
  if (rect.width <= 0 || rect.height <= 0 || source.width <= 0 || source.height <= 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: Math.min(source.width, Math.max(0, (clientX - rect.left) / rect.width * source.width)),
    y: Math.min(source.height, Math.max(0, (clientY - rect.top) / rect.height * source.height)),
  };
}

export function fitScale(
  container: SourceSize,
  source: SourceSize,
  padding = 0,
): number {
  const availableWidth = Math.max(1, container.width - padding * 2);
  const availableHeight = Math.max(1, container.height - padding * 2);
  if (source.width <= 0 || source.height <= 0) return 1;
  return Math.min(availableWidth / source.width, availableHeight / source.height);
}

export function clampZoom(value: number): number {
  return Math.min(4, Math.max(0.5, value));
}
