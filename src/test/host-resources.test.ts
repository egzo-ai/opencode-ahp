/**
 * Host tests — the `resource*` family: `resourceRead` (location- or
 * session-dir confined), `resourceResolve`/`resourceList`/`resourceMkdir`
 * (the errno → AHP-code mapping, symlink follow semantics, the not-a-file-URI
 * rejection), and the directory allowlist gating the unconfined commands.
 */
import { describe, expect, it } from "vitest";
import { directoryUri, fileUri, headContentRef } from "../bridge.js";
import { sessionChannelURI } from "../channels.js";
import { ERROR_INVALID_PARAMS } from "../handshake.js";
import { ERROR_PERMISSION_DENIED } from "../host.js";
import { PathPolicy, type PathPolicyEnv } from "../path-policy.js";
import {
  Harness,
  makeHarness,
  waitInit,
  createSession,
  DIR,
  OTHER,
  rpc,
  resourceRead,
} from "./host-fakes.js";

describe("resourceRead", () => {
  const SES = "ses_read";
  const FILE = `${DIR}/readme.txt`;

  async function ready(h: Harness): Promise<void> {
    h.init(1, "c1");
    await waitInit(h, 1);
    await createSession(h, 1, sessionChannelURI(SES), { provider: "gpuz" });
  }

  it("reads a file:// inside the location (utf-8 and base64)", async () => {
    const h = makeHarness();
    await ready(h);
    h.facade.disk.set(FILE, "hello\n");
    const utf8 = await resourceRead(h, { uri: fileUri(FILE), encoding: "utf-8" }, 340);
    expect(utf8.result).toEqual({ data: "hello\n", encoding: "utf-8" });
    const b64 = await resourceRead(h, { uri: fileUri(FILE) }, 341);
    expect(b64.result).toEqual({ data: Buffer.from("hello\n").toString("base64"), encoding: "base64" });
    h.stop();
  });

  it("rejects a file:// outside the location (-32009) and a missing file (-32008)", async () => {
    const h = makeHarness();
    await ready(h);
    const outside = await resourceRead(h, { uri: fileUri("/etc/passwd") }, 342);
    expect(outside.error?.code).toBe(-32009);
    const missing = await resourceRead(h, { uri: fileUri(`${DIR}/nope.txt`) }, 343);
    expect(missing.error?.code).toBe(-32008);
    const empty = await resourceRead(h, { uri: "" }, 344);
    expect(empty.error?.code).toBe(ERROR_INVALID_PARAMS);
    h.stop();
  });

  it("serves ahp-content://head from git HEAD and rejects untracked (-32008)", async () => {
    const h = makeHarness();
    await ready(h);
    h.facade.head.set(FILE, "HEAD version\n");
    const ok = await resourceRead(h, { uri: headContentRef(FILE), encoding: "utf-8" }, 345);
    expect(ok.result.data).toBe("HEAD version\n");
    const untracked = await resourceRead(h, { uri: headContentRef(`${DIR}/untracked.txt`), encoding: "utf-8" }, 346);
    expect(untracked.error?.code).toBe(-32008);
    h.stop();
  });

  it("rejects foreign and malformed content refs (-32008)", async () => {
    const h = makeHarness();
    await ready(h);
    for (const [uri, id] of [
      ["ahp-content://head/../../etc/passwd", 347],
      ["ahp-content://snap/abc/def/ghi", 348],
      ["https://example.com/x", 349],
    ] as const) {
      const res = await resourceRead(h, { uri, encoding: "utf-8" }, id);
      expect(res.error?.code).toBe(-32008);
    }
    h.stop();
  });

  it("reads a file:// inside a live session's own working directory", async () => {
    const h = makeHarness();
    await ready(h);
    // A second session pinned to a working directory outside the location.
    await createSession(h, 1, sessionChannelURI("ses_wd"), {
      provider: "gpuz",
      workingDirectories: [directoryUri(OTHER)],
    }, 360);
    const other = `${OTHER}/readme.txt`;
    h.facade.disk.set(other, "other\n");
    const ok = await resourceRead(h, { uri: fileUri(other), encoding: "utf-8" }, 361);
    expect(ok.result).toEqual({ data: "other\n", encoding: "utf-8" });
    // A path in neither the location nor any live session's directory is
    // still refused.
    const outside = await resourceRead(h, { uri: fileUri("/etc/passwd") }, 362);
    expect(outside.error?.code).toBe(-32009);
    h.stop();
  });
});

describe("resource* (resolve/list/mkdir)", () => {
  async function ready(h: Harness): Promise<void> {
    h.init(1, "c1");
    await waitInit(h, 1);
  }

  it("resourceResolve: file metadata with size, times, and a weak etag", async () => {
    const h = makeHarness();
    await ready(h);
    const file = `${OTHER}/readme.txt`;
    h.facade.disk.set(file, "hello\n");
    const res = await rpc(h, "resourceResolve", { uri: fileUri(file) }, 370);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      uri: fileUri(file),
      type: "file",
      size: 6,
      mtime: new Date(h.facade.resourceTime).toISOString(),
      ctime: new Date(h.facade.resourceTime).toISOString(),
      etag: `W/"6-${h.facade.resourceTime}"`,
    });
    h.stop();
  });

  it("resourceResolve: a directory gets a trailing-slash directory URI", async () => {
    const h = makeHarness();
    await ready(h);
    h.facade.dirs.add(OTHER);
    const res = await rpc(h, "resourceResolve", { uri: directoryUri(OTHER) }, 371);
    expect(res.error).toBeUndefined();
    expect(res.result.uri).toBe(directoryUri(OTHER));
    expect(res.result.type).toBe("directory");
    h.stop();
  });

  it("resourceResolve: follows symlinks by default, lstats with followSymlinks:false", async () => {
    const h = makeHarness();
    await ready(h);
    const file = `${OTHER}/readme.txt`;
    const link = `${OTHER}/link`;
    h.facade.disk.set(file, "hello\n");
    h.facade.symlinks.set(link, file);
    const followed = await rpc(h, "resourceResolve", { uri: fileUri(link) }, 372);
    expect(followed.result).toMatchObject({ uri: fileUri(file), type: "file" });
    const lstat = await rpc(h, "resourceResolve", { uri: fileUri(link), followSymlinks: false }, 373);
    expect(lstat.result).toMatchObject({ uri: fileUri(link), type: "symlink" });
    h.stop();
  });

  it("resourceResolve: missing → -32008, restricted → -32009, bad/absent uri → -32602", async () => {
    const h = makeHarness();
    await ready(h);
    const missing = await rpc(h, "resourceResolve", { uri: fileUri(`${OTHER}/nope.txt`) }, 374);
    expect(missing.error?.code).toBe(-32008);
    const restricted = `${OTHER}/restricted`;
    h.facade.restricted.add(restricted);
    const denied = await rpc(h, "resourceResolve", { uri: fileUri(restricted) }, 375);
    expect(denied.error?.code).toBe(-32009);
    const notFile = await rpc(h, "resourceResolve", { uri: "https://example.com/x" }, 376);
    expect(notFile.error?.code).toBe(ERROR_INVALID_PARAMS);
    const absent = await rpc(h, "resourceResolve", {}, 377);
    expect(absent.error?.code).toBe(ERROR_INVALID_PARAMS);
    h.stop();
  });

  it("resourceList: entries sorted directories-first, symlinks followed", async () => {
    const h = makeHarness();
    await ready(h);
    h.facade.dirs.add(OTHER);
    h.facade.dirs.add(`${OTHER}/subdir`);
    h.facade.disk.set(`${OTHER}/readme.txt`, "x");
    h.facade.symlinks.set(`${OTHER}/link`, `${OTHER}/readme.txt`);
    h.facade.symlinks.set(`${OTHER}/dangling`, `${OTHER}/missing.txt`);
    const res = await rpc(h, "resourceList", { uri: directoryUri(OTHER) }, 378);
    expect(res.error).toBeUndefined();
    expect(res.result.entries).toEqual([
      { name: "subdir", type: "directory" },
      { name: "dangling", type: "file" },
      { name: "link", type: "file" },
      { name: "readme.txt", type: "file" },
    ]);
    h.stop();
  });

  it("resourceList: missing → -32008, not a directory → -32602, restricted → -32009", async () => {
    const h = makeHarness();
    await ready(h);
    const missing = await rpc(h, "resourceList", { uri: directoryUri(`${OTHER}/nope`) }, 379);
    expect(missing.error?.code).toBe(-32008);
    const file = `${OTHER}/readme.txt`;
    h.facade.disk.set(file, "x");
    const notDir = await rpc(h, "resourceList", { uri: fileUri(file) }, 380);
    expect(notDir.error?.code).toBe(ERROR_INVALID_PARAMS);
    const restricted = `${OTHER}/locked`;
    h.facade.dirs.add(restricted);
    h.facade.restricted.add(restricted);
    const denied = await rpc(h, "resourceList", { uri: directoryUri(restricted) }, 381);
    expect(denied.error?.code).toBe(-32009);
    h.stop();
  });

  it("resourceMkdir: creates parents, an existing directory is a no-op", async () => {
    const h = makeHarness();
    await ready(h);
    const target = `${OTHER}/deep/dir`;
    const res = await rpc(h, "resourceMkdir", { uri: directoryUri(target) }, 382);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});
    expect(h.facade.dirs.has(`${OTHER}/deep`)).toBe(true);
    expect(h.facade.dirs.has(target)).toBe(true);
    const again = await rpc(h, "resourceMkdir", { uri: directoryUri(target) }, 383);
    expect(again.error).toBeUndefined();
    expect(again.result).toEqual({});
    h.stop();
  });

  it("resourceMkdir: onto a file → -32010, restricted parent → -32009", async () => {
    const h = makeHarness();
    await ready(h);
    const file = `${OTHER}/readme.txt`;
    h.facade.disk.set(file, "x");
    const ontoFile = await rpc(h, "resourceMkdir", { uri: directoryUri(file) }, 384);
    expect(ontoFile.error?.code).toBe(-32010);
    const restricted = `${OTHER}/locked`;
    h.facade.restricted.add(restricted);
    const denied = await rpc(h, "resourceMkdir", { uri: directoryUri(`${restricted}/sub`) }, 385);
    expect(denied.error?.code).toBe(-32009);
    h.stop();
  });
});

describe("directory allowlist (allowedWorkingDirectories)", () => {
  const PREFIX = "/allowed";
  const OUTSIDE = "/outside";
  /** The identity resolver — no symlinks in the decision. */
  const identityEnv: PathPolicyEnv = { resolveExisting: (p) => Promise.resolve(p) };

  async function ready(h: Harness): Promise<void> {
    h.init(1, "c1");
    await waitInit(h, 1);
  }

  it("createSession: a working directory outside the prefixes → flat -32009, no backend session", async () => {
    const h = makeHarness({ pathPolicy: PathPolicy.restricted([PREFIX], identityEnv) });
    await ready(h);
    const res = await createSession(h, 1, sessionChannelURI("pol-sess"), {
      provider: "gpuz",
      workingDirectories: [directoryUri(OUTSIDE)],
    });
    expect(res.error?.code).toBe(ERROR_PERMISSION_DENIED);
    expect(res.error?.message).toBe("working directory is not permitted by host policy");
    expect(h.facade.createCalls).toHaveLength(0);
    h.stop();
  });

  it("createSession: a working directory under a prefix proceeds to the backend", async () => {
    const h = makeHarness({ pathPolicy: PathPolicy.restricted([PREFIX], identityEnv) });
    await ready(h);
    const res = await createSession(h, 1, sessionChannelURI("pol-ok"), {
      provider: "gpuz",
      workingDirectories: [directoryUri(`${PREFIX}/proj`)],
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
    expect(h.facade.createCalls[0]!.location).toEqual({ directory: `${PREFIX}/proj` });
    h.stop();
  });

  it("createSession: an undecidable resolution defers (the operation runs)", async () => {
    const failing: PathPolicyEnv = {
      resolveExisting: () => {
        throw new Error("EACCES");
      },
    };
    const h = makeHarness({ pathPolicy: PathPolicy.restricted([PREFIX], failing) });
    await ready(h);
    const res = await createSession(h, 1, sessionChannelURI("pol-defer"), {
      provider: "gpuz",
      workingDirectories: [directoryUri(`${PREFIX}/proj`)],
    });
    expect(res.error).toBeUndefined();
    expect(h.facade.createCalls[0]!.location).toEqual({ directory: `${PREFIX}/proj` });
    h.stop();
  });

  it("createSession: a symlink out of a prefix is denied (resolved form is checked)", async () => {
    const env: PathPolicyEnv = {
      resolveExisting: (p) =>
        Promise.resolve(
          p === `${PREFIX}/link` || p.startsWith(`${PREFIX}/link/`)
            ? `${OUTSIDE}${p.slice(`${PREFIX}/link`.length)}`
            : p,
        ),
    };
    const h = makeHarness({ pathPolicy: PathPolicy.restricted([PREFIX], env) });
    await ready(h);
    const res = await createSession(h, 1, sessionChannelURI("pol-link"), {
      provider: "gpuz",
      workingDirectories: [directoryUri(`${PREFIX}/link`)],
    });
    expect(res.error?.code).toBe(ERROR_PERMISSION_DENIED);
    expect(h.facade.createCalls).toHaveLength(0);
    h.stop();
  });

  it("resource* commands: outside the prefixes → flat -32009, no facade effect", async () => {
    const h = makeHarness({ pathPolicy: PathPolicy.restricted([PREFIX], identityEnv) });
    await ready(h);
    h.facade.dirs.add(OUTSIDE);
    h.facade.disk.set(`${OUTSIDE}/f.txt`, "x");
    const list = await rpc(h, "resourceList", { uri: directoryUri(OUTSIDE) }, 390);
    expect(list.error?.code).toBe(ERROR_PERMISSION_DENIED);
    expect(list.error?.message).toBe("path is not permitted by host policy");
    const resolve = await rpc(h, "resourceResolve", { uri: directoryUri(OUTSIDE) }, 391);
    expect(resolve.error?.code).toBe(ERROR_PERMISSION_DENIED);
    expect(resolve.error?.message).toBe(list.error?.message); // same flat message — no oracle
    const target = `${OUTSIDE}/new-dir`;
    const mkdir = await rpc(h, "resourceMkdir", { uri: directoryUri(target) }, 392);
    expect(mkdir.error?.code).toBe(ERROR_PERMISSION_DENIED);
    expect(h.facade.dirs.has(target)).toBe(false); // no creation happened
    h.stop();
  });

  it("resource* commands: under a prefix proceed", async () => {
    const h = makeHarness({ pathPolicy: PathPolicy.restricted([PREFIX], identityEnv) });
    await ready(h);
    h.facade.dirs.add(PREFIX);
    h.facade.disk.set(`${PREFIX}/readme.txt`, "x");
    const list = await rpc(h, "resourceList", { uri: directoryUri(PREFIX) }, 393);
    expect(list.error).toBeUndefined();
    expect(list.result.entries).toEqual([{ name: "readme.txt", type: "file" }]);
    const resolve = await rpc(h, "resourceResolve", { uri: directoryUri(PREFIX) }, 394);
    expect(resolve.result.type).toBe("directory");
    const target = `${PREFIX}/new-dir`;
    const mkdir = await rpc(h, "resourceMkdir", { uri: directoryUri(target) }, 395);
    expect(mkdir.error).toBeUndefined();
    expect(h.facade.dirs.has(target)).toBe(true);
    h.stop();
  });

  it("resourceRead is NOT policy-gated (it stays per-session-confined)", async () => {
    const h = makeHarness({ pathPolicy: PathPolicy.restricted([PREFIX], identityEnv) });
    await ready(h);
    const file = `${OUTSIDE}/f.txt`;
    h.facade.disk.set(file, "secret");
    // No session covers this path: the pre-existing per-session
    // confinement answers first (not the policy message).
    const res = await rpc(h, "resourceRead", { uri: fileUri(file) }, 396);
    expect(res.error?.code).toBe(ERROR_PERMISSION_DENIED);
    expect(res.error?.message).toBe("path is outside every session's working directory");
    h.stop();
  });
});
