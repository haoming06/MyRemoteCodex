import type { ClientMessage } from "../src/protocol";

export function buildSubmissionMessage(input: {
  id: string;
  text: string;
}): ClientMessage {
  return {
    type: "input/submit",
    id: input.id,
    text: input.text,
    takeControl: true,
  };
}

export function remainingComposerTextAfterSuccess(
  currentText: string,
  submittedText: string,
): string {
  if (currentText === submittedText) return "";
  return currentText.startsWith(submittedText)
    ? currentText.slice(submittedText.length)
    : currentText;
}
