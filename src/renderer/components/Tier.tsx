import type { ArchiveTier, SourceLink } from '../../shared/types'
import { tierOf } from '../../shared/types'

const LABEL: Record<ArchiveTier, string> = {
  none: 'Not archived',
  bronze: 'Local copy only',
  silver: 'archive.is secured',
  gold: 'Fully archived'
}

export function TierBadge({ link }: { link: SourceLink }): JSX.Element {
  if (link.excluded) {
    return (
      <span className="tier tier-excluded" title={link.excludedReason || 'Excluded'}>
        —
      </span>
    )
  }
  const tier = tierOf(link)
  return (
    <span className={`tier tier-${tier}`} title={LABEL[tier]}>
      {tier === 'none' ? '○' : '★'}
    </span>
  )
}

export function tierCounts(links: SourceLink[]): Record<ArchiveTier | 'excluded', number> {
  const counts = { none: 0, bronze: 0, silver: 0, gold: 0, excluded: 0 }
  for (const link of links) {
    if (link.excluded) counts.excluded++
    else counts[tierOf(link)]++
  }
  return counts
}
