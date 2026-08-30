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

export function singleTouchAction(mode: TouchMode): SingleTouchAction {
  return mode === "direct" ? "pointer" : "scroll";
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
