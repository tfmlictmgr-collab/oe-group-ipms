"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Msg = { from: "me" | "bot"; text: string };

// Role help bubble, bottom right of every dashboard screen. It posts the
// question and nothing else — the server decides whose material answers it.
export function HelpChat({ logoUrl, logoText }: { logoUrl?: string | null; logoText?: string | null }) {
  // Rendered through a portal on <body>: inside the dashboard shell, an ancestor
  // that scrolls or transforms becomes the containing block for `fixed`, which
  // pinned the bubble to the end of the page instead of the screen corner.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
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

  if (!mounted) return null;
  return createPortal(
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
                <div style={m.from === "me" ? { background: "var(--brand)", color: "var(--brand-fg)" } : undefined} className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-left ${m.from === "me" ? "text-white" : "bg-muted"}`}>
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
            <button disabled={busy || !text.trim()} style={{ background: "var(--brand)", color: "var(--brand-fg)" }} className="rounded px-3 text-sm disabled:opacity-50">Send</button>
          </form>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close help" : "Need help? Open the help assistant"}
        style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
        className="ml-auto flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-4 text-xs font-bold uppercase tracking-wide shadow-lg"
      >
        <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-white text-xs font-bold" style={{ color: "var(--brand)" }}>
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-6 w-6 object-contain" />
          ) : (
            (logoText || "?").slice(0, 2).toUpperCase()
          )}
        </span>
        {open ? "Close" : "Need help?"}
      </button>
    </div>,
    document.body
  );
}
