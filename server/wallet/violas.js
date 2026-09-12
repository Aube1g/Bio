// Contract boundary for the later Violas integration. Never silently emulate a real wallet.
// An external implementation needs durable reservations/outbox delivery and idempotent settlement.
export class ViolasWallet {
  constructor() {
    throw new Error(
      'Violas requires the provider API specification and credentials. No real wallet is connected.',
    );
  }
}
