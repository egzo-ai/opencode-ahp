/**
 * Path policy tests: the directory allowlist decision logic
 * (`allowedWorkingDirectories`, design §3.3) — pure, with the filesystem
 * half (`PathPolicyEnv.resolveExisting`) faked.
 */
import { describe, expect, it } from "vitest";
import { normalizeDirPrefix, PathPolicy, type PathPolicyEnv } from "../path-policy.js";

/** The identity resolver — no symlinks in the decision. */
const identity: PathPolicyEnv = {
  resolveExisting: (p) => Promise.resolve(p),
};

describe("normalizeDirPrefix", () => {
  it("resolves dot segments and drops the trailing slash", () => {
    expect(normalizeDirPrefix("/tmp")).toBe("/tmp");
    expect(normalizeDirPrefix("/tmp/")).toBe("/tmp");
    expect(normalizeDirPrefix("/a/b/../c")).toBe("/a/c");
    expect(normalizeDirPrefix("/a/./b")).toBe("/a/b");
    expect(normalizeDirPrefix("/a//b")).toBe("/a/b");
    expect(normalizeDirPrefix("/a/b/")).toBe("/a/b");
  });

  it("the root stays the root; a leading double slash collapses", () => {
    expect(normalizeDirPrefix("/")).toBe("/");
    expect(normalizeDirPrefix("//")).toBe("/");
    expect(normalizeDirPrefix("//etc")).toBe("/etc");
  });

  it("rejects relative paths (a configuration error — fail closed)", () => {
    expect(() => normalizeDirPrefix("tmp")).toThrow();
    expect(() => normalizeDirPrefix("a/b")).toThrow();
    expect(() => normalizeDirPrefix("../x")).toThrow();
  });
});

describe("PathPolicy", () => {
  it("unrestricted: every path is permitted, no resolver involved", async () => {
    const policy = PathPolicy.unrestricted();
    expect(await policy.allows("/anything/at/all")).toBe(true);
    expect(await policy.allows("/")).toBe(true);
  });

  it("a path is permitted when it is a prefix or inside one", async () => {
    const policy = PathPolicy.restricted(["/tmp", "/home/user"], identity);
    expect(await policy.allows("/tmp")).toBe(true);
    expect(await policy.allows("/tmp/ahp-server/project")).toBe(true);
    expect(await policy.allows("/home/user")).toBe(true);
    expect(await policy.allows("/home/user/project-lan/sub")).toBe(true);
  });

  it("sibling and prefix-overlap paths are denied", async () => {
    const policy = PathPolicy.restricted(["/tmp", "/home/user"], identity);
    expect(await policy.allows("/tmp2")).toBe(false);
    expect(await policy.allows("/home/user2")).toBe(false);
    expect(await policy.allows("/home/other")).toBe(false);
    expect(await policy.allows("/etc")).toBe(false);
  });

  it("the root prefix admits everything", async () => {
    const policy = PathPolicy.restricted(["/"], identity);
    expect(await policy.allows("/etc/passwd")).toBe(true);
  });

  it("lexical .. and . segments in the target are normalized", async () => {
    const policy = PathPolicy.restricted(["/tmp"], identity);
    expect(await policy.allows("/tmp/a/../b")).toBe(true);
    expect(await policy.allows("/tmp/../etc")).toBe(false);
  });

  it("symlink escape: the resolved form is what is checked", async () => {
    // /allowed/link → /outside: the resolver canonicalizes the link.
    const env: PathPolicyEnv = {
      resolveExisting: (p) =>
        Promise.resolve(
          p === "/allowed/link" || p.startsWith("/allowed/link/")
            ? `/outside${p.slice("/allowed/link".length)}`
            : p,
        ),
    };
    const policy = PathPolicy.restricted(["/allowed"], env);
    expect(await policy.allows("/allowed/plain")).toBe(true);
    expect(await policy.allows("/allowed/link")).toBe(false);
    expect(await policy.allows("/allowed/link/sub/file.txt")).toBe(false);
  });

  it("a symlink that stays inside the prefix is permitted", async () => {
    const env: PathPolicyEnv = {
      resolveExisting: (p) =>
        Promise.resolve(p === "/allowed/link" || p.startsWith("/allowed/link/") ? "/allowed/target" + p.slice("/allowed/link".length) : p),
    };
    const policy = PathPolicy.restricted(["/allowed"], env);
    expect(await policy.allows("/allowed/link/sub")).toBe(true);
  });

  it("an undecidable resolution defers to the underlying operation (allows)", async () => {
    const failing: PathPolicyEnv = {
      resolveExisting: () => {
        throw new Error("EACCES /allowed/locked");
      },
    };
    const policy = PathPolicy.restricted(["/allowed"], failing);
    // No positive determination → the operation runs and its own errno
    // error (if any) is what the client sees.
    expect(await policy.allows("/allowed/locked")).toBe(true);
  });
});
