"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { from: "me" | "bot"; text: string };

// Role help bubble, bottom right of every dashboard screen. It posts the
// question and nothing else — the server decides whose material answers it.
export function HelpChat() {
  const [open, setOpen] = useState(false);
  const [starters, setStarters] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || label) return;
    fetch("/api/help-chat")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) { setStarters(j.starters ?? []); setLabel(j.roleLabel ?? ""); } })
      .catch(() => {});
  }, [open, label]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs, busy]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    const earlier = msgs.filter((m) => m.from === "me").map((m) => m.text).slice(-2);
    setMsgs((m) => [...m, { from: "me", text: question }]);
    setText("");
    setBusy(true);
    try {
      const r = await fetch("/api/help-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, earlier }),
      });
      const j = r.ok || r.status === 429 ? await r.json() : null;
      setMsgs((m) => [...m, { from: "bot", text: j?.answer ?? "Sorry, I couldn't answer that just now. Please ask your administrator." }]);
    } catch {
      setMsgs((m) => [...m, { from: "bot", text: "Sorry, I couldn't answer that just now. Please ask your administrator." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-print="screen-only" className="fixed bottom-4 right-4 z-50 print:hidden">
      {open && (
        <div className="mb-3 flex h-[28rem] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div>
              <div className="text-sm font-semibold">How do I…?</div>
              <div className="text-xs text-muted-foreground">{label ? `Help for ${label}` : "Help for your role"}</div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close help" className="px-2 text-lg leading-none">×</button>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
            {msgs.length === 0 && (
              <>
                <p className="text-muted-foreground">
                  Ask how to do your own work, step by step. For anything else, your administrator is the person to ask.
                </p>
                {starters.map((s) => (
                  <button key={s} onClick={() => ask(s)} className="block w-full rounded border px-2 py-1.5 text-left text-xs hover:bg-muted">
                    {s}
                  </button>
                ))}
              </>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.from === "me" ? "text-right" : ""}>
                <div className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-left ${m.from === "me" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                  {m.text}
                </div>
              </div>
            ))}
            {busy && <div className="text-xs text-muted-foreground">Looking that up…</div>}
            <div ref={endRef} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); ask(text); }} className="flex gap-2 border-t p-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={400}
              placeholder="Ask how to do something…"
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-sm"
            />
            <button disabled={busy || !text.trim()} className="rounded bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50">Send</button>
          </form>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close help" : "Open help"}
        className="ml-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary text-xl text-primary-foreground shadow-lg"
      >
        {open ? "×" : "?"}
      </button>
    </div>
  );
}
