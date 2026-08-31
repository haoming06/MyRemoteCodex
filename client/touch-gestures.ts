export type TouchMode = "browse" | "direct";
export type SingleTouchAction = "pointer" | "scroll";

export interface PinchGestureState {
  distance: number;
  zoom: number;
  centerX: number;
  centerY: number;
}

export interface PinchGestureUpdate {
  zoom: number;
  panX: number;
  panY: number;
  state: PinchGestureState;
}

export interface TouchPoint {
  x: number;
  y: number;
}

export interface EditableRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function singleTouchAction(mode: TouchMode): SingleTouchAction {
  return mode === "direct" ? "pointer" : "scroll";
}

export function shouldCaptureKeyboardForTouch(
  point: TouchPoint,
  editableRegions: EditableRegion[],
  movement: number,
): boolean {
  if (movement >= 9) return false;
  return editableRegions.some((region) =>
    region.width > 0
    && region.height > 0
    && point.x >= region.left
    && point.x <= region.left + region.width
    && point.y >= region.top
    && point.y <= region.top + region.height);
}

export function updatePinchGesture(
  state: PinchGestureState,
  distance: number,
  centerX: number,
  centerY: number,
): PinchGestureUpdate {
  return {
    zoom: state.zoom * distance / Math.max(state.distance, 1),
    panX: centerX - state.centerX,
    panY: centerY - state.centerY,
    state: { ...state, centerX, centerY },
  };
}
