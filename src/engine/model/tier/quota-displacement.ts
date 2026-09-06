import type {
  TierCandidateDetail,
  TierTopNCascadeResolutionDetail,
} from "@/engine/model/tier/resolver.ts";

/**
 * True when a candidate lost its routing slot to quota alone: quota-blocked yet
 * otherwise viable. Cooldown-carrying candidates are excluded — transient
 * cooldowns belong to the interactive deviation machinery, and once the
 * cooldown lapses this predicate reassesses against the live quota SoT.
 */
export function isQuotaDisplacedCandidate(candidate: TierCandidateDetail): boolean {
  return (
    candidate.quotaBlocked &&
    candidate.credentialsConfigured &&
    candidate.modelAvailable &&
    candidate.cooldownUntilEpochMs === null
  );
}

export function quotaDisplacedBeforeTopNSelection(
  detail: TierTopNCascadeResolutionDetail,
): TierCandidateDetail | null {
  for (const tierDetail of detail.tiers) {
    if (detail.selectedTier !== null && tierDetail.tier === detail.selectedTier) {
      break;
    }
    for (const candidate of tierDetail.candidates) {
      if (isQuotaDisplacedCandidate(candidate)) {
        return candidate;
      }
    }
  }

  if (detail.selectedTier !== null) {
    const selectedTierDetail = detail.tiers.find((t) => t.tier === detail.selectedTier);
    if (selectedTierDetail) {
      const candidates = selectedTierDetail.candidates;
      const selected = detail.selected;
      const picked = new Set(selected);

      if (selected.length < detail.requestedCount) {
        for (const candidate of candidates) {
          if (!picked.has(candidate) && isQuotaDisplacedCandidate(candidate)) {
            return candidate;
          }
        }
      } else {
        const last = selected[selected.length - 1];
        const lastIdx = last !== undefined ? candidates.indexOf(last) : -1;
        const end = lastIdx >= 0 ? lastIdx : candidates.length;
        for (let i = 0; i < end; i++) {
          const candidate = candidates[i];
          if (candidate === undefined || picked.has(candidate)) continue;
          if (isQuotaDisplacedCandidate(candidate)) return candidate;
        }
      }
    }
  }

  return null;
}
