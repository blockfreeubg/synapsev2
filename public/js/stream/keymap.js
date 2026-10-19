// Browser input -> Android keycodes (android.view.KeyEvent).

export const AKEY = {
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
};

const KEYBOARD = {
  Space: 62,
  Enter: 66,
  NumpadEnter: 66,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  ShiftLeft: 59,
  ShiftRight: 60,
  ControlLeft: 113,
  ControlRight: 114,
  AltLeft: 57,
  AltRight: 58,
  CapsLock: 115,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Slash: 76,
  Comma: 55,
  Period: 56,
  Backquote: 68,
  PageUp: 92,
  PageDown: 93,
  Home: 122,
  End: 123,
  Insert: 124,
  NumpadAdd: 81,
};
for (let i = 0; i < 26; i++) KEYBOARD[`Key${String.fromCharCode(65 + i)}`] = 29 + i;
for (let i = 0; i < 10; i++) {
  KEYBOARD[`Digit${i}`] = 7 + i;
  KEYBOARD[`Numpad${i}`] = 7 + i;
}
for (let i = 1; i <= 10; i++) KEYBOARD[`F${i}`] = 130 + i;

export function keyboardKeycode(code) {
  return KEYBOARD[code];
}

/** Android meta state bits for the modifiers held during a KeyboardEvent. */
export function metaState(e) {
  let m = 0;
  if (e.shiftKey) m |= 0x41; // META_SHIFT_ON | META_SHIFT_LEFT_ON
  if (e.altKey) m |= 0x12; // META_ALT_ON | META_ALT_LEFT_ON
  if (e.ctrlKey) m |= 0x3000; // META_CTRL_ON | META_CTRL_LEFT_ON
  return m;
}

// Standard Gamepad API button index -> Android gamepad keycode (by position:
// the bottom face button is Android's BUTTON_A, like on most Android pads).
export const PAD_KEYCODES = [
  96, // 0 bottom  -> BUTTON_A
  97, // 1 right   -> BUTTON_B
  99, // 2 left    -> BUTTON_X
  100, // 3 top    -> BUTTON_Y
  102, // 4 L1
  103, // 5 R1
  104, // 6 L2
  105, // 7 R2
  109, // 8 SELECT
  108, // 9 START
  106, // 10 THUMBL
  107, // 11 THUMBR
  19, // 12 DPAD_UP
  20, // 13 DPAD_DOWN
  21, // 14 DPAD_LEFT
  22, // 15 DPAD_RIGHT
];

export const STICK_KEYCODES = { up: 19, down: 20, left: 21, right: 22 };
