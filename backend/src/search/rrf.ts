export interface RankedList {
  name: string;
  ids: readonly string[];
  weight?: number;
}

export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank of the item in each input list it appeared in. */
  ranks: Record<string, number>;
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ_m w_m / (k + r_m(d)), with r_m 1-based.
 * Rank-based, so BM25 scores and cosine similarities need no calibration against each other.
 * Ties are broken by best single-list rank, then by first appearance.
 */
export function reciprocalRankFusion(lists: readonly RankedList[], k = 60): FusedItem[] {
  const items = new Map<string, FusedItem & { order: number; best: number }>();
  let order = 0;
  for (const list of lists) {
    const w = list.weight ?? 1;
    const seen = new Set<string>();
    list.ids.forEach((id, i) => {
      if (seen.has(id)) return; // duplicate ids in one list only count once (at best rank)
      seen.add(id);
      const rank = i + 1;
      let item = items.get(id);
      if (!item) {
        item = { id, score: 0, ranks: {}, order: order++, best: rank };
        items.set(id, item);
      }
      item.score += w / (k + rank);
      item.ranks[list.name] = rank;
      item.best = Math.min(item.best, rank);
    });
  }
  return [...items.values()]
    .sort((a, b) => b.score - a.score || a.best - b.best || a.order - b.order)
    .map(({ id, score, ranks }) => ({ id, score, ranks }));
}
