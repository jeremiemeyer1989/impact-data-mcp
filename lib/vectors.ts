// Vector math shared by search and the clustering script.
// Embeddings from text-embedding-3-small are 1536 numbers. Cosine similarity
// is the closeness measure used everywhere in this app: 1 is the same direction,
// 0 is unrelated.

const EMBEDDING_DIMENSIONS = 1536;

export function parseVector(value: unknown): number[] {
  let numbers: number[];
  if (Array.isArray(value)) {
    numbers = value.map((item) => Number(item));
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
      throw new Error("An embedding was stored in an unexpected format.");
    }
    const body = trimmed.slice(1, -1).trim();
    numbers = body.length === 0 ? [] : body.split(",").map((part) => Number(part.trim()));
  } else {
    throw new Error("An embedding was stored in an unexpected format.");
  }

  if (numbers.length !== EMBEDDING_DIMENSIONS || numbers.some((item) => !Number.isFinite(item))) {
    throw new Error("An embedding was stored with the wrong number of dimensions.");
  }
  return numbers;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error("Cannot compare embeddings of different lengths.");
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

// The centroid is the average of the member embeddings. Averaging unit-length
// vectors does not leave a unit-length vector, so the mean is L2-normalised.
// Cosine similarity is then just the angle between two directions, which is
// what pgvector's cosine distance measures.
export function meanUnitVector(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new Error("Cannot average an empty list of embeddings.");
  }
  const width = vectors[0].length;
  const mean = new Array<number>(width).fill(0);
  for (const vector of vectors) {
    if (vector.length !== width) {
      throw new Error("Cannot average embeddings of different lengths.");
    }
    for (let index = 0; index < width; index += 1) {
      mean[index] += vector[index];
    }
  }
  for (let index = 0; index < width; index += 1) {
    mean[index] /= vectors.length;
  }
  let norm = 0;
  for (const value of mean) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return mean;
  return mean.map((value) => value / norm);
}

// Two indicators share a cluster only when they are at least this close.
// 1 would mean nearly the same text. The default 0.78 is tight enough that a
// loose topical match is not treated as the same measure.
export function readClusterThreshold(): number {
  const raw = process.env.CLUSTER_SIMILARITY_THRESHOLD?.trim();
  if (!raw) return 0.78;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error("CLUSTER_SIMILARITY_THRESHOLD must be a number from -1 to 1.");
  }
  return value;
}
