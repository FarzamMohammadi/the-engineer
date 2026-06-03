import { cn } from "../../lib/cn";
import { BLOCK_CATEGORY_LABELS, BLOCK_REASON_COLORS, BLOCK_REASON_LABELS } from "../../lib/constants";
import type { BlockCategory, BlockReason } from "../../types/api";

interface BlockReasonBadgeProps {
  reason: BlockReason;
  className?: string;
}

/** Color-coded badge for the coarse `BlockReason` the daemon routes on. */
export function BlockReasonBadge({ reason, className }: BlockReasonBadgeProps): React.JSX.Element {
  const colors = BLOCK_REASON_COLORS[reason] ?? BLOCK_REASON_COLORS.pipeline_failed;
  const label = BLOCK_REASON_LABELS[reason] ?? reason;
  return (
    <span
      className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium", colors, className)}
    >
      {label}
    </span>
  );
}

interface BlockCategoryBadgeProps {
  category: BlockCategory;
  className?: string;
}

/** Outline badge for the full `BlockCategory` cause — the precise reason behind the coarse routing value. */
export function BlockCategoryBadge({ category, className }: BlockCategoryBadgeProps): React.JSX.Element {
  const label = BLOCK_CATEGORY_LABELS[category] ?? category;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {label}
    </span>
  );
}

interface BlockBadgesProps {
  reason: BlockReason;
  category: BlockCategory;
  /** The operator-facing next step that unblocks the task (`blocked.needed`); shown when present. */
  needed?: string;
  /** The sub-phase the task blocked in (`blocked.sub_phase`); shown as a subtle tag when present. */
  subPhase?: string;
  className?: string;
}

/**
 * The full block taxonomy in one row: the coarse reason, the precise category, the sub-phase it blocked in,
 * and — most actionable — the `needed` next step. The owner sees only the dashboard, so `needed` is the line
 * that tells them what to do; it is rendered prominently, not buried.
 */
export function BlockBadges({ reason, category, needed, subPhase, className }: BlockBadgesProps): React.JSX.Element {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <BlockReasonBadge reason={reason} />
        <BlockCategoryBadge category={category} />
        {subPhase && (
          <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground/80">
            in {subPhase}
          </span>
        )}
      </div>
      {needed && (
        <p className="text-xs leading-relaxed text-foreground">
          <span className="font-medium text-muted-foreground">Needed: </span>
          {needed}
        </p>
      )}
    </div>
  );
}
