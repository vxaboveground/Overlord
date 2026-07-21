import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import { logger } from "../../logger";
import {
  getSharedFile,
  listSharedFiles,
  insertSharedFile,
  deleteSharedFile,
  updateSharedFile,
  incrementSharedFileDownloadCount,
} from "../../db";
import { getUserById } from "../../users";
import { checkPermission, requirePermission } from "../../rbac";
import { resolveContainedPath, sanitizeUploadFilename } from "../upload-security";

type FileShareRouteDeps = {
  FILE_SHARE_ROOT: string;
};

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/vnd.rar",
    ".exe": "application/vnd.microsoft.portable-executable",
    ".dll": "application/vnd.microsoft.portable-executable",
    ".iso": "application/x-iso9660-image",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".xml": "application/xml",
  };
  return map[ext] || "application/octet-stream";
}

export async function handleFileShareRoutes(
  req: Request,
  url: URL,
  deps: FileShareRouteDeps,
): Promise<Response | null> {

  const infoMatch = url.pathname.match(/^\/api\/file-share\/([^/]+)\/info$/);
  if (req.method === "GET" && infoMatch) {
    const fileId = infoMatch[1];
    const file = getSharedFile(fileId);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    if (file.expiresAt && file.expiresAt < Date.now()) {
      return Response.json({ error: "File has expired" }, { status: 410 });
    }

    if (file.maxDownloads !== null && file.downloadCount >= file.maxDownloads) {
      return Response.json({ error: "Download limit reached" }, { status: 410 });
    }

    return Response.json({
      id: file.id,
      filename: file.filename,
      size: file.size,
      mimeType: file.mimeType,
      hasPassword: !!file.passwordHash,
      maxDownloads: file.maxDownloads,
      downloadCount: file.downloadCount,
      expiresAt: file.expiresAt,
      createdAt: file.createdAt,
      uploadedByUsername: file.uploadedByUsername,
      description: file.description,
    });
  }

  const downloadMatch = url.pathname.match(/^\/api\/file-share\/([^/]+)\/download$/);
  if (req.method === "GET" && downloadMatch) {
    const fileId = downloadMatch[1];
    const file = getSharedFile(fileId);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    if (file.expiresAt && file.expiresAt < Date.now()) {
      return Response.json({ error: "File has expired" }, { status: 410 });
    }

    if (file.maxDownloads !== null && file.downloadCount >= file.maxDownloads) {
      return Response.json({ error: "Download limit reached" }, { status: 410 });
    }

    if (file.passwordHash) {
      const providedPassword = req.headers.get("X-Download-Password") || url.searchParams.get("password") || "";
      if (!providedPassword) {
        return Response.json({ error: "Password required" }, { status: 401 });
      }
      const valid = await Bun.password.verify(providedPassword, file.passwordHash);
      if (!valid) {
        return Response.json({ error: "Invalid password" }, { status: 403 });
      }
    }

    const diskFile = Bun.file(file.storedPath);
    if (!(await diskFile.exists())) {
      return Response.json({ error: "File not found on disk" }, { status: 404 });
    }

    incrementSharedFileDownloadCount(file.id);

    const sanitizedFilename = file.filename.replace(/[^\w.\-() ]/g, "_");

    return new Response(diskFile, {
      headers: {
        "Content-Type": file.mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${sanitizedFilename}"`,
        "Content-Length": String(file.size),
      },
    });
  }

  if (!url.pathname.startsWith("/api/file-share")) {
    return null;
  }

  let user;
  try {
    user = await authenticateRequest(req);
  } catch {
    return null;
  }
  if (!user) return null;

  if (user.role === "viewer") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (req.method === "GET" && url.pathname === "/api/file-share") {
    const files = listSharedFiles();
    const userCanUpload = checkPermission(user, "files:upload");
    return Response.json({
      files: files.map((f) => ({
        id: f.id,
        filename: f.filename,
        size: f.size,
        mimeType: f.mimeType,
        uploadedBy: f.uploadedBy,
        uploadedByUsername: f.uploadedByUsername,
        hasPassword: !!f.passwordHash,
        maxDownloads: f.maxDownloads,
        downloadCount: f.downloadCount,
        expiresAt: f.expiresAt,
        createdAt: f.createdAt,
        description: f.description,
      })),
      canUpload: userCanUpload,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/file-share/upload") {
    try {
      requirePermission(user, "files:upload");
    } catch (error) {
      if (error instanceof Response) return Response.json({ error: "You do not have upload permission" }, { status: 403 });
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Invalid form data" }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Missing file" }, { status: 400 });
    }

    const filename = sanitizeUploadFilename(file.name, "upload.bin");
    const id = uuidv4();

    await fs.mkdir(deps.FILE_SHARE_ROOT, { recursive: true });
    const folder = resolveContainedPath(deps.FILE_SHARE_ROOT, id);
    await fs.mkdir(folder, { recursive: true });
    const targetPath = resolveContainedPath(folder, filename);

    const bytes = new Uint8Array(await file.arrayBuffer());
    await fs.writeFile(targetPath, bytes);

    const password = form.get("password")?.toString() || "";
    let passwordHash: string | null = null;
    if (password) {
      passwordHash = await Bun.password.hash(password, {
        algorithm: "bcrypt",
        cost: 10,
      });
    }

    const maxDownloadsStr = form.get("maxDownloads")?.toString();
    let maxDownloads: number | null = null;
    if (maxDownloadsStr && maxDownloadsStr !== "" && maxDownloadsStr !== "0") {
      const parsed = parseInt(maxDownloadsStr, 10);
      if (!isNaN(parsed) && parsed > 0) {
        maxDownloads = parsed;
      }
    }

    const expiresAtStr = form.get("expiresAt")?.toString();
    let expiresAt: number | null = null;
    if (expiresAtStr && expiresAtStr !== "") {
      const parsed = parseInt(expiresAtStr, 10);
      if (!isNaN(parsed) && parsed > Date.now()) {
        expiresAt = parsed;
      }
    }

    const description = form.get("description")?.toString() || null;

    const dbUser = getUserById(user.userId);

    const record = {
      id,
      filename,
      storedPath: targetPath,
      size: bytes.length,
      mimeType: guessMimeType(filename),
      uploadedBy: user.userId,
      uploadedByUsername: dbUser?.username || user.username || "unknown",
      passwordHash,
      maxDownloads,
      downloadCount: 0,
      expiresAt,
      createdAt: Date.now(),
      description,
    };

    insertSharedFile(record);

    logger.info(`[file-share] ${record.uploadedByUsername} uploaded "${filename}" (${bytes.length} bytes) id=${id}`);

    return Response.json({
      ok: true,
      id,
      filename,
      size: bytes.length,
    });
  }

  const deleteMatch = url.pathname.match(/^\/api\/file-share\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const fileId = deleteMatch[1];
    const file = getSharedFile(fileId);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    if (file.uploadedBy !== user.userId && user.role !== "admin") {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      const folder = path.dirname(file.storedPath);
      await fs.rm(folder, { recursive: true, force: true });
    } catch (err) {
      logger.warn(`[file-share] Failed to remove file from disk: ${file.storedPath}`, err);
    }

    deleteSharedFile(fileId);
    logger.info(`[file-share] ${user.username} deleted file "${file.filename}" id=${fileId}`);

    return Response.json({ ok: true });
  }

  const patchMatch = url.pathname.match(/^\/api\/file-share\/([^/]+)$/);
  if (req.method === "PATCH" && patchMatch) {
    const fileId = patchMatch[1];
    const file = getSharedFile(fileId);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    if (file.uploadedBy !== user.userId && user.role !== "admin") {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const updates: Record<string, any> = {};

    if (body.password !== undefined) {
      if (body.password === "" || body.password === null) {
        updates.passwordHash = null;
      } else {
        updates.passwordHash = await Bun.password.hash(body.password, {
          algorithm: "bcrypt",
          cost: 10,
        });
      }
    }

    if (body.maxDownloads !== undefined) {
      if (body.maxDownloads === null || body.maxDownloads === 0 || body.maxDownloads === "") {
        updates.maxDownloads = null;
      } else {
        const parsed = parseInt(body.maxDownloads, 10);
        if (!isNaN(parsed) && parsed > 0) {
          updates.maxDownloads = parsed;
        }
      }
    }

    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === "") {
        updates.expiresAt = null;
      } else {
        const parsed = parseInt(body.expiresAt, 10);
        if (!isNaN(parsed)) {
          updates.expiresAt = parsed;
        }
      }
    }

    if (body.description !== undefined) {
      updates.description = body.description || null;
    }

    updateSharedFile(fileId, updates);

    return Response.json({ ok: true });
  }

  return null;
}
