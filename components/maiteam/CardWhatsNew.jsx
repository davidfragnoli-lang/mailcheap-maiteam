"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import LinkApp from "@/components/LinkApp";
import { Button } from "@/components/ui/button";
import { markChangelogSeen } from "@/lib/maiteam/whats-new-actions";

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

// maiteam (PATCHES.md P10): the what's new card, at the bottom left so upstream's get-started panel keeps the right.
// Closing it marks everything it stood for as seen (ids), the entries past the shown ones included.
export default function CardWhatsNew({ entries, ids, more }) {
  const [isOpen, setIsOpen] = useState(true);
  const [, startClosing] = useTransition();
  if (!isOpen) return null;

  function close() {
    setIsOpen(false);
    startClosing(() => markChangelogSeen(ids));
  }

  return (
    <section
      aria-labelledby="whats-new-title"
      className="fixed bottom-4 left-64 z-30 hidden max-h-[min(28rem,calc(100dvh-2rem))] w-80 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg md:flex save-bar:invisible"
    >
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 id="whats-new-title" className="font-semibold tracking-tight">
          What&apos;s new
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={close}
          aria-label="Close"
          title="Close"
        >
          <X className="size-4" />
        </Button>
      </header>
      <ol className="flex flex-col gap-3 overflow-y-auto px-4 py-3 text-sm">
        {entries.map(({ id, date, title, parts }) => (
          <li key={id}>
            <p className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{title}</span>
              <time
                dateTime={date}
                className="shrink-0 text-xs text-muted-foreground tabular-nums"
              >
                {DATE.format(new Date(`${date}T00:00:00Z`))}
              </time>
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {parts.map((part, index) =>
                part.href ? (
                  <LinkApp
                    key={index}
                    href={part.href}
                    className="text-foreground underline underline-offset-2"
                  >
                    {part.text}
                  </LinkApp>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </p>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          And {more} more since your last look.
        </p>
      )}
    </section>
  );
}
