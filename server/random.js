import { createHash, createHmac, randomBytes } from 'node:crypto';

export const newSeed = () => randomBytes(32).toString('hex');
export const seedHash = (seed) => createHash('sha256').update(seed).digest('hex');

// Domain-separated deterministic CSPRNG. A committed seed is revealed only after settlement.
export class FairRandom {
  constructor(serverSeed, clientSeed, nonce, game) {
    this.seed = serverSeed;
    this.message = `${game}:${nonce}:${clientSeed}`;
    this.counter = 0;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
  }

  uint32() {
    if (this.offset + 4 > this.buffer.length) {
      this.buffer = createHmac('sha256', this.seed).update(`${this.message}:${this.counter++}`).digest();
      this.offset = 0;
    }
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  int(size) {
    if (!Number.isInteger(size) || size < 1 || size > 0x100000000)
      throw new RangeError('Invalid random range');
    const limit = Math.floor(0x100000000 / size) * size;
    let value;
    do value = this.uint32();
    while (value >= limit);
    return value % size;
  }
}
