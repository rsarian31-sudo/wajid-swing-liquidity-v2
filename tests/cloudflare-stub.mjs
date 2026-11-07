// Minimal stub of `cloudflare:workers` for Node-based integration tests.
// Only the DurableObject base class is needed at import time; the tests
// mock the Durable Object namespace themselves.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
