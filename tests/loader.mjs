// Node test loader: resolves the Workers-only `cloudflare:workers`
// specifier (used by state.js for the DurableObject base class) to a
// local stub so the worker module can be imported under plain Node.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: new URL('./cloudflare-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
