/**
 * opencode forms ↔ AHP chat input requests (design §8.2). opencode asks
 * the user through its Form service (the `question` tool, the web-search
 * consent, …); AHP's counterpart is a `chat/inputRequested` request whose
 * questions a client answers with `chat/inputCompleted`.
 */

import {
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  type ChatInputAnswer,
  type ChatInputQuestion,
  type ChatInputRequest,
} from "@microsoft/agent-host-protocol";
import type { FacadeFormAnswer, FacadeFormField } from "./bridge.js";

/**
 * The AHP request for an opencode form: one question per visible field.
 * An `external` field (a page to open) is the request's `url`.
 */
export function formRequest(formID: string, title: string, fields: readonly FacadeFormField[]): ChatInputRequest {
  const questions: ChatInputQuestion[] = [];
  let url: string | undefined;
  for (const f of fields) {
    if (f.hidden === true) continue;
    if (f.type === "external") {
      url ??= f.url;
      continue;
    }
    const base = {
      id: f.key,
      ...(f.title !== undefined ? { title: f.title } : {}),
      message: f.description ?? f.title ?? f.key,
      ...(f.required === true ? { required: true } : {}),
    };
    const options = (f.options ?? []).map((o) => ({
      id: o.value,
      label: o.label,
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...((Array.isArray(f.default) ? f.default.includes(o.value) : f.default === o.value) ? { recommended: true } : {}),
    }));
    switch (f.type) {
      case "string":
        if (options.length > 0) {
          questions.push({ ...base, kind: ChatInputQuestionKind.SingleSelect, options, ...(f.custom === true ? { allowFreeformInput: true } : {}) });
        } else {
          questions.push({
            ...base,
            kind: ChatInputQuestionKind.Text,
            ...(f.format !== undefined ? { format: f.format } : {}),
            ...(f.minLength !== undefined ? { min: f.minLength } : {}),
            ...(f.maxLength !== undefined ? { max: f.maxLength } : {}),
            ...(typeof f.default === "string" ? { defaultValue: f.default } : {}),
          });
        }
        break;
      case "number":
      case "integer":
        questions.push({
          ...base,
          kind: f.type === "number" ? ChatInputQuestionKind.Number : ChatInputQuestionKind.Integer,
          ...(f.minimum !== undefined ? { min: f.minimum } : {}),
          ...(f.maximum !== undefined ? { max: f.maximum } : {}),
          ...(typeof f.default === "number" ? { defaultValue: f.default } : {}),
        });
        break;
      case "boolean":
        questions.push({ ...base, kind: ChatInputQuestionKind.Boolean, ...(typeof f.default === "boolean" ? { defaultValue: f.default } : {}) });
        break;
      case "multiselect":
        questions.push({
          ...base,
          kind: ChatInputQuestionKind.MultiSelect,
          options,
          ...(f.custom === true ? { allowFreeformInput: true } : {}),
          ...(f.minItems !== undefined ? { min: f.minItems } : {}),
          ...(f.maxItems !== undefined ? { max: f.maxItems } : {}),
        });
        break;
    }
  }
  return {
    id: formID,
    ...(title !== "" ? { message: title } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(questions.length > 0 ? { questions } : {}),
  };
}

/**
 * The opencode answer for a client's AHP answers: each answered (not
 * skipped) question by its field key, in the field's own value type.
 * Free text a select allows stands in for, or joins, the selection.
 */
export function formAnswer(fields: readonly FacadeFormField[], answers: Record<string, ChatInputAnswer> | undefined): FacadeFormAnswer {
  const out: FacadeFormAnswer = {};
  for (const f of fields) {
    const a = answers?.[f.key];
    if (a === undefined || a.state === ChatInputAnswerState.Skipped) continue;
    const v = a.value;
    switch (v.kind) {
      case ChatInputAnswerValueKind.Text:
        out[f.key] = v.value;
        break;
      case ChatInputAnswerValueKind.Number:
        out[f.key] = v.value;
        break;
      case ChatInputAnswerValueKind.Boolean:
        out[f.key] = v.value;
        break;
      case ChatInputAnswerValueKind.Selected:
        out[f.key] = v.value !== "" ? v.value : (v.freeformValues?.[0] ?? "");
        break;
      case ChatInputAnswerValueKind.SelectedMany:
        out[f.key] = [...v.value, ...(v.freeformValues ?? [])];
        break;
    }
  }
  return out;
}
