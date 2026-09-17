/**
 * Describe a failure to start an agent process.
 *
 * Only ENOENT proves the binary is absent. Every other code -- a permissions
 * problem, a broken interpreter line, a resource limit -- means the executable
 * exists and something else went wrong, and reporting those as "not installed"
 * sends people looking for the wrong problem.
 */
export function describeSpawnError(err: NodeJS.ErrnoException, bin: string): string {
  if (err.code === 'ENOENT') {
    return `could not start "${bin}": not found on PATH. Install it, or pass --bin with an explicit path.`;
  }
  return `could not start "${bin}": ${err.code ?? 'spawn failed'} (${err.message}).`;
}
