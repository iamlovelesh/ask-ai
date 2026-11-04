export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0; // Ensure 32-bit unsigned
  }

  private next(): number {
    this.state |= 0; // Convert to signed 32-bit
    this.state = (this.state + 0x6d2b79f5) | 0;

    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  pick<T>(arr: T[]): T {
    if (arr.length === 0) {
      throw new Error('pick from empty array');
    }
    const index = this.int(arr.length);
    return arr[index] as T;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
