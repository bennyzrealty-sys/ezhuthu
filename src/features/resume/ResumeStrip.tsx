/**
 * The resume strip (ADR-0023).
 *
 * Four destinations in a **fixed** order. The learned preference shows up as
 * which one is the default — emphasised, focused, and what Enter or a tap on
 * the strip itself activates — never as where the buttons are. A four-item
 * strip that reorders itself moves the target under a thumb that had learned
 * where it was, on the most frequent interaction in the app.
 *
 * Slots that have no answer are rendered and disabled rather than removed. That
 * is the point of a fixed order: if an absent destination closed the gap, the
 * other three would move, and the strip could no longer be operated without
 * reading it.
 *
 * The whole strip is absent until at least one destination resolves, so a fresh
 * install sees nothing rather than four dead buttons.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EzhuthuDB } from '../../db/schema';
import type { DocId } from '../../db/types';
import {
  RESUME_LABELS,
  RESUME_ORDER,
  resolveDestinations,
  type ResumeDestination,
  type ResumeKind,
} from './destinations';
import { loadPreference, recordPick, type Preference } from './preference';

export interface ResumeStripProps {
  db: EzhuthuDB;
  docId: DocId;
  onGo: (destination: ResumeDestination) => void;
  onDismiss: () => void;
}

export function ResumeStrip({ db, docId, onGo, onDismiss }: ResumeStripProps) {
  const [destinations, setDestinations] = useState<ResumeDestination[] | null>(null);
  const [preference, setPreference] = useState<Preference | null>(null);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [found, pref] = await Promise.all([
        resolveDestinations(db, docId),
        loadPreference(db),
      ]);
      if (cancelled) return;
      setDestinations(found);
      setPreference(pref);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, docId]);

  const byKind = new Map((destinations ?? []).map((d) => [d.kind, d]));
  const favourite = preference?.favourite ?? null;
  const defaultDestination = favourite === null ? undefined : byKind.get(favourite);

  /*
   * Focus the strip itself, not a button. Enter then activates the default
   * without a tab press, and Tab still walks the four slots in their fixed
   * order. Focusing a slot instead would make the default's *position* matter,
   * which is the thing ADR-0023 keeps stable.
   */
  useEffect(() => {
    if (destinations !== null && destinations.length > 0) container.current?.focus();
  }, [destinations]);

  const go = useCallback(
    (destination: ResumeDestination) => {
      /*
       * The pick is recorded before the document moves, and awaited. It is one
       * small `settings` put, so the delay is imperceptible — and unlike a
       * signal, a pick is an explicit choice rather than an observation. If the
       * app is closed the instant after resuming, which is a perfectly ordinary
       * thing to do, a fire-and-forget write can be aborted mid-transaction and
       * the choice is simply lost.
       */
      void recordPick(db, destination.kind).then(() => onGo(destination));
    },
    [db, onGo],
  );

  if (destinations === null || destinations.length === 0) return null;

  return (
    <div
      className="resume-strip"
      ref={container}
      tabIndex={-1}
      role="group"
      aria-label="Resume where you were"
      data-testid="resume-strip"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onDismiss();
          return;
        }
        // Only from the strip itself: a focused slot handles its own Enter.
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
        if (defaultDestination !== undefined) go(defaultDestination);
      }}
      onClick={(e) => {
        // A tap on the strip's own surface, not on a slot, activates the
        // default — the "strip-level tap" of ADR-0023.
        if (e.target !== e.currentTarget || defaultDestination === undefined) return;
        go(defaultDestination);
      }}
    >
      <span className="resume-title">Where you were</span>

      <div className="resume-slots">
        {RESUME_ORDER.map((kind: ResumeKind) => {
          const destination = byKind.get(kind);
          const isDefault = kind === favourite && destination !== undefined;

          return (
            <button
              key={kind}
              type="button"
              className={`resume-slot${isDefault ? ' is-default' : ''}`}
              data-testid={`resume-${kind}`}
              data-default={isDefault ? 'true' : undefined}
              disabled={destination === undefined}
              onClick={() => destination !== undefined && go(destination)}
            >
              <span className="resume-label">
                {RESUME_LABELS[kind]}
                {isDefault && <span className="resume-badge"> · default</span>}
              </span>
              <span className="resume-excerpt">
                {destination === undefined ? 'nothing yet' : destination.excerpt}
              </span>
              {destination !== undefined && (
                <span className="resume-detail">{destination.detail}</span>
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="resume-dismiss"
        data-testid="resume-dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}
