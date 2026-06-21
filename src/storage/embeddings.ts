/**
 * Tiny embedding store. For hackathon we use a deterministic hash-bucket
 * embedding (cheap, good enough for semantic-similarity demo).
 * Swap to Voyage / OpenAI / Cohere embeddings in prod — same interface.
 *
 * We deliberately keep this simple: 256-dim bag-of-bigrams with IDF weights,
 * normalized to unit length. Cosine similarity ~= dot product.
 *
 * Why not call an embeddings API right now?
 *   - Faster demo, no extra API key needed
 *   - Still surfaces "did the new message mention the past decision?"
 *   - We can swap implementations behind this interface
 */
import { createHash } from 'node:crypto';

const DIMS = 256;

export interface Embedding {
  vec: number[];
  dim: number;
}

export function embed(text: string): Embedding {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (const tok of tokens) counts.set(tok, (counts.get(tok) ?? 0) + 1);

  const vec = new Array<number>(DIMS).fill(0);
  for (const [tok, count] of counts) {
    const idx = hashToBucket(tok, DIMS);
    vec[idx] = (vec[idx] ?? 0) + count;
  }
  return { vec: normalize(vec), dim: DIMS };
}

export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.dim !== b.dim) return 0;
  let dot = 0;
  for (let i = 0; i < a.dim; i++) dot += (a.vec[i] ?? 0) * (b.vec[i] ?? 0);
  return dot; // both are unit vectors
}

export function topKSimilar<T>(
  query: Embedding,
  candidates: Array<{ item: T; embedding: Embedding }>,
  k: number,
  threshold = 0.15,
): Array<{ item: T; score: number }> {
  return candidates
    .map((c) => ({ item: c.item, score: cosineSimilarity(query, c.embedding) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/* ---------------------------- internals ---------------------------- */

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function hashToBucket(token: string, mod: number): number {
  const h = createHash('sha256').update(token).digest();
  // first 4 bytes as uint32
  const n = (h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!;
  return Math.abs(n) % mod;
}

function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
