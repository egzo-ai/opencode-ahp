/**
 * Directory allowlist (design §3.3): the optional
 * `allowedWorkingDirectories` option — an allowlist of absolute path
 * prefixes. When configured, client-named paths must resolve under one of
 * the prefixes (after symlink resolution): the
 * `createSession.workingDirectories` target and the unconfined `resource*`
 * commands (`resourceResolve` / `resourceList` / `resourceMkdir`).
 *
 * Pure decision logic — filesystem access is injected
 * (`PathPolicyEnv`), so unit tests never touch the disk.
 */

import { isAbsolute, normalize } from "node:path";
import { isPathInside } from "./host-util.js";

/**
 * The filesystem half of the decision, injected to keep this module pure:
 * canonicalize the symlinks of the EXISTING prefix portion of `path` —
 * walk up to the deepest existing ancestor, canonicalize it, and re-append
 * the missing tail. The result may not yet exist (the tail is never
 * created). May throw (e.g. EACCES on an existing ancestor).
 */
export interface PathPolicyEnv {
  resolveExisting: (path: string) => Promise<string>;
}

/**
 * The directory allowlist. `prefixes` are already normalized (see
 * `normalizeDirPrefix`; the plugin entry additionally canonicalizes the
 * ones that exist), `env` supplies the target resolution. An empty prefix
 * list is the unrestricted policy.
 */
export class PathPolicy {
  private constructor(
    private readonly prefixes: readonly string[],
    private readonly env?: PathPolicyEnv,
  ) {}

  /** No prefixes — every path is permitted. */
  static unrestricted(): PathPolicy {
    return new PathPolicy([]);
  }

  static restricted(prefixes: readonly string[], env: PathPolicyEnv): PathPolicy {
    return new PathPolicy(prefixes, env);
  }

  /**
   * Whether `path` is permitted: its symlink-resolved form (existing
   * prefix portion canonicalized, missing tail re-appended) must be a
   * prefix itself or strictly inside one. When the resolved form cannot
   * be determined (the resolver throws — e.g. EACCES on an existing
   * ancestor) the decision defers: the underlying operation runs and
   * produces its own errno error.
   */
  async allows(path: string): Promise<boolean> {
    if (this.prefixes.length === 0) return true;
    let resolved: string;
    try {
      resolved = await this.env!.resolveExisting(path);
    } catch {
      return true;
    }
    return this.prefixes.some((prefix) => isPathInside(resolved, prefix));
  }
}

/**
 * Lexically normalize an allowlist prefix: resolve `.`/`..` segments,
 * drop the trailing slash (root stays `/`). Throws when `p` is not
 * absolute — a relative prefix would silently scope the host to the wrong
 * place, so it is a configuration error (the plugin entry fails closed:
 * AHP off, opencode keeps serving).
 */
export function normalizeDirPrefix(p: string): string {
  if (!isAbsolute(p)) throw new Error(`not an absolute path: ${p}`);
  let n = normalize(p);
  // POSIX preserves a leading double slash; on Linux it is just `/`.
  if (n.startsWith("//")) n = n.slice(1);
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}
