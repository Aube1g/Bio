import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const hashSeed = (seed) => bytesToHex(sha256(utf8ToBytes(seed)));
export const newPracticeSeed = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// Same domain separation and rejection sampling as the server, also usable in file://.
export class BrowserFairRandom {
  constructor(serverSeed, clientSeed, nonce, game) {
    this.key = utf8ToBytes(serverSeed);
    this.message = `${game}:${nonce}:${clientSeed}`;
    this.counter = 0;
    this.offset = 32;
    this.block = new Uint8Array(32);
  }
  uint32() {
    if (this.offset >= this.block.length) {
      this.block = hmac(sha256, this.key, utf8ToBytes(`${this.message}:${this.counter++}`));
      this.offset = 0;
    }
    const value = new DataView(this.block.buffer, this.block.byteOffset, this.block.byteLength).getUint32(
      this.offset,
    );
    this.offset += 4;
    return value;
  }
  int(size) {
    if (!Number.isInteger(size) || size < 1 || size > 0x100000000)
      throw new RangeError('Invalid random range');
    const limit = Math.floor(0x100000000 / size) * size;
    let value;
    do {
      value = this.uint32();
    } while (value >= limit);
    return value % size;
  }
}
