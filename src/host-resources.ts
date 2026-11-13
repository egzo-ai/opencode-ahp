/**
 * Resources section (design §11): the filesystem `resource*` commands the
 * VS Code folder picker drives — `resourceResolve` (the existence check),
 * `resourceList` (navigating the server's filesystem), and `resourceMkdir`
 * (creating a new project directory). These are token-authenticated and
 * NOT location-confined: a client may name any path (matching the VS Code
 * reference agent host, which exposes the whole host filesystem).
 */

import { HostChangesets } from "./host-changesets.js";
import { fileURLToPath } from "node:url";
import { directoryUri, fileUri, type FacadeResourceInfo } from "./bridge.js";
import { ERROR_INVALID_PARAMS } from "./handshake.js";
import { isRecord } from "./options.js";
import {
  ERROR_ALREADY_EXISTS,
  ERROR_INTERNAL,
  ERROR_NOT_FOUND,
  ERROR_PERMISSION_DENIED,
} from "./host-errors.js";
import { RpcMessage } from "./host-types.js";
import { errorMessage } from "./host-util.js";

export class HostResources extends HostChangesets {
  /**
   * `resourceResolve` (AHP root command): resolve one filesystem URI to
   * its metadata (canonical URI, type, size, mtime/ctime, etag). The
   * default `followSymlinks: true` follows symlinks and canonicalizes the
   * path; `false` stats the path itself. Errors: -32008 (not found),
   * -32009 (permission denied), -32602 (not a file URI), -32603 (other).
   */
  protected async handleResourceResolve(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const absPath = this.resourceUri(socketId, msg, params, "resourceResolve");
    if (absPath === null) return;
    // Absent / `true` follow symlinks (the default); only `false` stats
    // the path itself (lstat semantics).
    const followSymlinks = params["followSymlinks"] !== false;
    let info: FacadeResourceInfo;
    try {
      info = await this.opts.facade.resolveResource(absPath, followSymlinks);
    } catch (err) {
      this.sendResourceError(socketId, msg.id, err);
      return;
    }
    this.sendFrame(socketId, {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {
        uri: info.type === "directory" ? directoryUri(info.path) : fileUri(info.path),
        type: info.type,
        size: info.size,
        mtime: new Date(info.mtime).toISOString(),
        ctime: new Date(info.ctime).toISOString(),
        // Weak etag of size + mtime (the spec's example shape); stable for
        // a given file state, changes when the file changes.
        etag: `W/"${info.size}-${info.mtime}"`,
      },
    });
  }

  /**
   * `resourceList` (AHP root command): list one directory's immediate
   * entries (name + file/directory kind) for remote folder pickers. The
   * target MUST exist and be a directory — otherwise an error: -32008
   * (missing), -32602 (not a directory), -32009 (inaccessible), -32603.
   */
  protected async handleResourceList(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const absPath = this.resourceUri(socketId, msg, params, "resourceList");
    if (absPath === null) return;
    let entries;
    try {
      entries = await this.opts.facade.listDirectory(absPath);
    } catch (err) {
      this.sendResourceError(socketId, msg.id, err);
      return;
    }
    this.sendFrame(socketId, {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: {
        entries: entries.map((e) => ({ name: e.name, type: e.type })),
      },
    });
  }

  /**
   * `resourceMkdir` (AHP root command): create a directory with `mkdir -p`
   * semantics (parents created as needed; an existing directory is a
   * no-op success). Errors: -32009 (permission denied), -32010 (the path
   * exists as a non-directory), -32602 (not a file URI), -32603 (other).
   */
  protected async handleResourceMkdir(socketId: number, msg: RpcMessage): Promise<void> {
    const params = isRecord(msg.params) ? msg.params : {};
    const absPath = this.resourceUri(socketId, msg, params, "resourceMkdir");
    if (absPath === null) return;
    try {
      await this.opts.facade.mkdirResource(absPath);
    } catch (err) {
      this.sendResourceError(socketId, msg.id, err);
      return;
    }
    this.sendFrame(socketId, { jsonrpc: "2.0", id: msg.id ?? null, result: {} });
  }

  /**
   * The `uri` param of a `resource*` command as an absolute filesystem
   * path. Sends the error and returns null when it is not a non-empty
   * string or not a decodable `file://` URI. A directory URI may carry a
   * trailing slash (RFC 8089) — it is dropped so the facade sees a plain
   * absolute path (the resolve result re-adds it for directories).
   */
  private resourceUri(socketId: number, msg: RpcMessage, params: Record<string, unknown>, method: string): string | null {
    const uri = params["uri"];
    if (typeof uri !== "string" || uri.length === 0) {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, `${method} requires a uri`);
      return null;
    }
    try {
      const path = fileURLToPath(uri);
      return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    } catch {
      this.sendError(socketId, msg.id, ERROR_INVALID_PARAMS, `${method} uri must be a file URI: ${uri}`);
      return null;
    }
  }

  /**
   * Map a Node `ErrnoException` from the resource facade to the AHP error
   * codes: ENOENT → NotFound, EACCES/EPERM → PermissionDenied, ENOTDIR →
   * InvalidParams ("not a directory"), EEXIST → AlreadyExists, other →
   * Internal.
   */
  private sendResourceError(socketId: number, id: unknown, err: unknown): void {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    switch (code) {
      case "ENOENT":
        this.sendError(socketId, id, ERROR_NOT_FOUND, errorMessage(err));
        break;
      case "EACCES":
      case "EPERM":
        this.sendError(socketId, id, ERROR_PERMISSION_DENIED, errorMessage(err));
        break;
      case "ENOTDIR":
        this.sendError(socketId, id, ERROR_INVALID_PARAMS, `not a directory: ${errorMessage(err)}`);
        break;
      case "EEXIST":
        this.sendError(socketId, id, ERROR_ALREADY_EXISTS, errorMessage(err));
        break;
      default:
        this.sendError(socketId, id, ERROR_INTERNAL, errorMessage(err));
        break;
    }
  }
}
