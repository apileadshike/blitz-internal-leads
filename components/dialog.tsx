"use client";
// The app's own dialogs, used instead of the browser's alert / confirm / prompt.
//
//   if (await dialog.confirm({ title: "Delete this job?", danger: true })) …
//   const name = await dialog.prompt({ title: "Save pipeline", placeholder: "e.g. SaaS founders US" });
//   await dialog.alert("Couldn't pause the job", error);
//
// <DialogHost /> is mounted once in the root layout and shows them one at a time.
import { useEffect, useState } from "react";

type Kind = "alert" | "confirm" | "prompt";
type Options = {
  title: string; message?: React.ReactNode; confirmLabel?: string; cancelLabel?: string;
  danger?: boolean; placeholder?: string; defaultValue?: string;
};
type Request = Options & { kind: Kind; resolve: (v: unknown) => void };

let show: ((r: Request) => void) | null = null;
const waiting: Request[] = []; // asked before the host was mounted

function open<T>(kind: Kind, o: Options): Promise<T> {
  return new Promise<T>((resolve) => {
    const r: Request = { ...o, kind, resolve: resolve as (v: unknown) => void };
    if (show) show(r);
    else waiting.push(r);
  });
}

export const dialog = {
  alert: (title: string, message?: React.ReactNode) => open<void>("alert", { title, message }),
  confirm: (o: Options) => open<boolean>("confirm", o),
  prompt: (o: Options) => open<string | null>("prompt", o),
};

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [text, setText] = useState("");
  const cur = queue[0];

  useEffect(() => {
    show = (r) => setQueue((q) => [...q, r]);
    if (waiting.length) setQueue((q) => [...q, ...waiting.splice(0)]);
    return () => { show = null; };
  }, []);
  useEffect(() => { if (cur) setText(cur.defaultValue ?? ""); }, [cur]);

  const close = (value: unknown) => {
    if (!cur) return;
    cur.resolve(value);
    setQueue((q) => q.slice(1));
  };
  const ok = () => {
    if (!cur) return;
    if (cur.kind === "prompt") { if (text.trim()) close(text.trim()); }
    else close(cur.kind === "confirm" ? true : undefined);
  };
  const cancel = () => close(cur?.kind === "prompt" ? null : cur?.kind === "confirm" ? false : undefined);

  // Escape cancels, Enter confirms (the text box handles its own Enter).
  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      else if (e.key === "Enter" && cur.kind !== "prompt") { e.preventDefault(); ok(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!cur) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className={"dialog" + (cur.danger ? " danger" : "")} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div id="dialog-title" className="dialog-title">{cur.title}</div>
        {cur.message && <div className="dialog-msg">{cur.message}</div>}
        {cur.kind === "prompt" && (
          <input autoFocus value={text} placeholder={cur.placeholder} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } }} />
        )}
        <div className="dialog-actions">
          {cur.kind !== "alert" && <button type="button" className="secondary" onClick={cancel}>{cur.cancelLabel ?? "Cancel"}</button>}
          <button type="button" autoFocus={cur.kind !== "prompt"} className={cur.danger ? "danger-solid" : undefined}
            disabled={cur.kind === "prompt" && !text.trim()} onClick={ok}>
            {cur.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
