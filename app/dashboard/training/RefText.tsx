"use client";

import { Fragment, useMemo } from "react";
import { splitProcessRefs, type Process } from "@/lib/guides/processes";

// Text from the catalogue, with every quoted reference to another process
// turned into a link to it. Used by the handbook screen and the slides, so a
// reference behaves the same on both: the screen opens and scrolls to that
// process, the slides jump to its first slide.
//
// `processes` is what the reader can actually reach (the edition, or the
// current filter), so a reference to anything outside it stays plain text
// rather than becoming a link to nothing. With no `onRef` it is plain text,
// which is how the slide thumbnails render it.
export default function RefText({
  text,
  processes,
  onRef,
  className = "",
}: {
  text: string;
  processes: readonly Pick<Process, "id" | "title">[];
  onRef?: (id: string) => void;
  className?: string;
}) {
  const segments = useMemo(() => splitProcessRefs(text, processes), [text, processes]);
  if (!onRef) return <>{text}</>;
  return (
    <>
      {segments.map((s, i) =>
        s.ref ? (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.currentTarget.blur();
              onRef(s.ref!);
            }}
            className={`inline p-0 text-left font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline focus-visible:outline-2 ${className}`}
          >
            {s.text}
          </button>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        )
      )}
    </>
  );
}
