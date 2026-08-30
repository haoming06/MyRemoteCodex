import { CdpSession } from "../src/cdp/session.js";
import { discoverAppTargets } from "../src/cdp/target.js";
import { cdpKeyEvent } from "../src/cdp/keyboard.js";

const EDITOR_EXPRESSION = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none';
  };
  const candidates = [...document.querySelectorAll(
    'textarea, [contenteditable="true"][role="textbox"], [role="textbox"]'
  )].filter(visible);
  const byBottom = (left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom;
  return candidates.filter((element) => element.getAttribute('aria-label')).sort(byBottom)[0]
    || candidates.sort(byBottom)[0];
})()`;

const FOCUS_EMPTY_EXPRESSION = `(() => {
  const editor = ${EDITOR_EXPRESSION};
  if (!editor) return { ready: false, reason: 'missing' };
  const text = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
    ? editor.value
    : editor.textContent || '';
  if (text.length !== 0) return { ready: false, reason: 'nonempty', length: text.length };
  editor.focus();
  return { ready: document.activeElement === editor };
})()`;

const READ_TEXT_EXPRESSION = `(() => {
  const editor = ${EDITOR_EXPRESSION};
  if (!editor) return null;
  return editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
    ? editor.value
    : editor.textContent || '';
})()`;

const SELECT_ALL_EXPRESSION = `(() => {
  const editor = ${EDITOR_EXPRESSION};
  if (!editor) return false;
  editor.focus();
  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
    editor.setSelectionRange(0, editor.value.length);
  } else {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return true;
})()`;

async function pressKey(session: CdpSession, key: string, code = key): Promise<void> {
  await session.send("Input.dispatchKeyEvent", cdpKeyEvent({
    type: "keyDown",
    key,
    code,
  }));
  await session.send("Input.dispatchKeyEvent", cdpKeyEvent({
    type: "keyUp",
    key,
    code,
  }));
  await new Promise((resolve) => setTimeout(resolve, 16));
}

async function expectText(session: CdpSession, stage: string, expected: string): Promise<void> {
  const actual = await session.evaluate<string | null>(READ_TEXT_EXPRESSION);
  if (actual !== expected) {
    throw new Error(`${stage} 失败: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.REMOTE_CODEX_CDP_PORT || 9341);
  const target = (await discoverAppTargets(port)).find((item) => !item.url.includes("avatar-overlay"));
  if (!target) throw new Error("没有找到 Codex 主渲染页面");

  const session = new CdpSession(target, port);
  await session.open();
  try {
    const readiness = await session.evaluate<{ ready: boolean; reason?: string; length?: number }>(
      FOCUS_EMPTY_EXPRESSION,
    );
    if (!readiness.ready) {
      throw new Error(`Codex 输入框当前不适合安全测试: ${JSON.stringify(readiness)}`);
    }

    await session.send("Input.insertText", { text: "ab中文" });
    await expectText(session, "文字插入", "ab中文");
    await pressKey(session, "Backspace");
    await expectText(session, "退格", "ab中");
    await pressKey(session, "ArrowLeft");
    await session.send("Input.insertText", { text: "X" });
    await expectText(session, "左移", "abX中");
    await pressKey(session, "Backspace");
    await expectText(session, "删除光标标记", "ab中");
    await pressKey(session, "Delete");
    await expectText(session, "左移后前向删除", "ab");
    await pressKey(session, "Home");
    await pressKey(session, "Delete");
    await expectText(session, "Home 后删除", "b");
    await pressKey(session, "End");
    await pressKey(session, "Backspace");
    await expectText(session, "End 后退格", "");
    console.log(JSON.stringify({ passed: true, checks: 5 }));
  } finally {
    await session.evaluate(SELECT_ALL_EXPRESSION).catch(() => false);
    await pressKey(session, "Backspace").catch(() => undefined);
    session.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
