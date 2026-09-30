declare module 'earcut' {
  /** Triangulates a flat array of vertex coordinates; returns triangle vertex indices. */
  export default function earcut(data: ArrayLike<number>, holeIndices?: number[], dim?: number): number[];
}
