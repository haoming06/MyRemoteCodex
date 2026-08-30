export interface RemoteKeyInput {
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key: string;
  code: string;
  text?: string;
  modifiers?: number;
  repeat?: boolean;
  location?: number;
}

const NAMED_VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PrintScreen: 44,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 92,
  ContextMenu: 93,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumLock: 144,
  ScrollLock: 145,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

export function virtualKeyCode(code: string, key: string): number | undefined {
  const named = NAMED_VIRTUAL_KEY_CODES[code] ?? NAMED_VIRTUAL_KEY_CODES[key];
  if (named !== undefined) return named;
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6));
  const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (functionMatch) return 111 + Number(functionMatch[1]);
  if (/^[A-Za-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  return undefined;
}

export function cdpKeyEvent(input: RemoteKeyInput): Record<string, unknown> {
  const text = input.text || "";
  const keyCode = virtualKeyCode(input.code, input.key);
  const params: Record<string, unknown> = {
    type: input.type === "keyDown" && !text ? "rawKeyDown" : input.type,
    key: input.key,
    code: input.code,
    text,
    unmodifiedText: text,
    modifiers: input.modifiers || 0,
    autoRepeat: input.repeat || false,
    isKeypad: input.location === 3 || input.code.startsWith("Numpad"),
  };
  if (keyCode !== undefined) {
    params.windowsVirtualKeyCode = keyCode;
  }
  return params;
}
