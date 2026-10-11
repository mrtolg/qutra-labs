import type { MessageKey } from "@/lib/i18n/en";
import type { AddOutcome, InvestigationFile } from "@/lib/investigationFiles";
import type { Toast } from "@/state/ui";

/* What adding files did, told in toasts: one for the files copied,
   one for those already there, one for those Rust refused. A pick and a drop
   say it the same way. */

type ToastFn = (toast: Omit<Toast, "id">) => void;
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const KNOWN_REASONS = new Set(["not_a_file", "missing_file", "too_large", "store_unreadable"]);

/** A file name with its direction marks shown, not obeyed: "invoice\u202Egnp.exe"
    would otherwise read as a picture. Rust strips them from the copy's
    name; the original name is kept as it was, so it is shown this way. */
export function visibleName(name: string): string {
  return name.replace(
    /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
    (mark) => `⟨U+${mark.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`,
  );
}

/** A refusal from Rust as a phrase; one this version does not know reads as
    a copy that went wrong. */
export function addFailureKey(reason: string): MessageKey {
  return (KNOWN_REASONS.has(reason) ? `lab.files.reason.${reason}` : "lab.files.reason.other") as MessageKey;
}

/** `show` opens a file the add copied (or found already there). `name`, when
    given, is the investigation the files went into, so the toast says which. */
export function toastAddOutcomes(
  outcomes: readonly AddOutcome[],
  toast: ToastFn,
  t: Translate,
  show?: (file: InvestigationFile) => void,
  name?: string,
) {
  const added = outcomes.flatMap((o) => (o.outcome === "added" ? [o.file] : []));
  const duplicates = outcomes.flatMap((o) => (o.outcome === "duplicate" ? [o.file] : []));
  const failed = outcomes.flatMap((o) => (o.outcome === "failed" ? [o] : []));
  const action = (file: InvestigationFile | undefined) =>
    show && file ? { actionKey: "lab.files.show" as const, onAction: () => show(file) } : {};

  if (added.length > 0) {
    toast({
      kind: "success",
      ...(name
        ? { messageKey: "lab.files.addedTo" as const, params: { count: added.length, name } }
        : { messageKey: "lab.files.added" as const, params: { count: added.length } }),
      ...action(added[0]),
    });
  }
  if (duplicates.length > 0) {
    toast({
      kind: "info",
      messageKey: "lab.files.duplicate",
      params: { count: duplicates.length },
      ...(added.length === 0 ? action(duplicates[0]) : {}),
    });
  }
  if (failed.length === 1) {
    toast({
      kind: "danger",
      messageKey: "lab.files.failedOne",
      params: {
        name: visibleName(failed[0].originalName),
        reason: t(addFailureKey(failed[0].reason)),
      },
    });
  } else if (failed.length > 1) {
    toast({ kind: "danger", messageKey: "lab.files.failed", params: { count: failed.length } });
  }
}
