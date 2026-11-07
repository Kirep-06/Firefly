import { spawn } from "node:child_process";
import {
	createHash,
	createHmac,
	timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const postsDir = path.resolve(process.env.POSTS_DIR || path.join(projectRoot, "src/content/posts"));
const trashDir = path.resolve(process.env.POSTS_TRASH_DIR || path.join(projectRoot, "src/content/.admin-trash"));
const releasesDir = path.resolve(process.env.SITE_RELEASES_DIR || path.join(projectRoot, ".releases"));
const currentSite = path.resolve(process.env.SITE_CURRENT_DIR || path.join(projectRoot, "current"));
const port = Number(process.env.PORT || 3000);
const siteOrigin = new URL(process.env.SITE_ORIGIN || "https://kirep.top").origin;
const adminKey = process.env.ADMIN_API_KEY || "";
const slugPattern = /^(?:[\p{L}\p{N}][\p{L}\p{N}-]*)(?:\/(?:[\p{L}\p{N}][\p{L}\p{N}-]*))*$/u;
const maxBodyBytes = 2 * 1024 * 1024;
const mimeTypes = new Map([
	[".html", "text/html; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".xml", "application/xml; charset=utf-8"],
	[".txt", "text/plain; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".webp", "image/webp"],
	[".avif", "image/avif"],
	[".mp4", "video/mp4"],
	[".woff2", "font/woff2"],
	[".pdf", "application/pdf"],
]);

if (Buffer.byteLength(adminKey, "utf8") < 32) {
	console.error("ADMIN_API_KEY must contain at least 32 bytes. Set it in the server environment.");
	process.exit(1);
}

let busy = false;
const failedAttempts = new Map();

function sendJson(res, status, value) {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	});
	res.end(JSON.stringify(value));
}

function equalSecret(a, b) {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

function limited(ip) {
	const now = Date.now();
	const entries = (failedAttempts.get(ip) || []).filter((time) => now - time < 60_000);
	failedAttempts.set(ip, entries);
	return entries.length >= 10;
}

function recordFailure(ip) {
	const entries = failedAttempts.get(ip) || [];
	entries.push(Date.now());
	failedAttempts.set(ip, entries);
	if (failedAttempts.size > 5000) failedAttempts.delete(failedAttempts.keys().next().value);
}

function hasValidKey(req) {
	const match = /^Bearer (.+)$/.exec(req.headers.authorization || "");
	return Boolean(match && equalSecret(match[1], adminKey));
}

function hasExpectedOrigin(req) {
	try {
		return new URL(req.headers.origin).origin === siteOrigin;
	} catch {
		return false;
	}
}

function assertSlug(slug) {
	if (slug.length > 180 || !slugPattern.test(slug) || slug.split("/").some((part) => part.length > 100 || part.startsWith("."))) {
		const error = new Error("slug 格式无效：每段只允许中文、字母、数字和连字符。");
		error.status = 400;
		throw error;
	}
}

function isInside(parent, candidate) {
	const rel = path.relative(parent, candidate);
	return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function getPostPath(slug, includeMissing = false) {
	assertSlug(slug);
	const candidates = ["md", "mdx"].map((ext) => path.resolve(postsDir, `${slug}.${ext}`));
	if (candidates.some((candidate) => !isInside(postsDir, candidate))) {
		const error = new Error("文章路径无效。");
		error.status = 400;
		throw error;
	}
	for (const candidate of candidates) {
		try {
			const stat = await fs.lstat(candidate);
			if (stat.isSymbolicLink() || !stat.isFile()) continue;
			return candidate;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	return includeMissing ? candidates[0] : null;
}

async function walkPosts(dir = postsDir, prefix = "") {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const posts = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
		const rel = prefix ? path.join(prefix, entry.name) : entry.name;
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			posts.push(...(await walkPosts(full, rel)));
			continue;
		}
		if (!entry.isFile() || !/\.mdx?$/i.test(entry.name)) continue;
		const slug = rel.replace(/\.mdx?$/i, "").split(path.sep).join("/");
		const parsed = matter(await fs.readFile(full, "utf8"));
		posts.push({
			slug,
			title: String(parsed.data.title || slug),
			published: toIsoDate(parsed.data.published),
			draft: Boolean(parsed.data.draft),
		});
	}
	return posts.sort((a, b) => b.published.localeCompare(a.published) || a.title.localeCompare(b.title));
}

async function collectPostFiles(dir = postsDir, prefix = "") {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
		const rel = prefix ? path.join(prefix, entry.name) : entry.name;
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) files.push(...(await collectPostFiles(full, rel)));
		else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) files.push({ full, rel });
	}
	return files;
}

async function postsDigest() {
	const files = (await collectPostFiles()).sort((a, b) => a.rel.localeCompare(b.rel));
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.rel.split(path.sep).join("/"));
		hash.update("\0");
		hash.update(await fs.readFile(file.full));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function toIsoDate(value) {
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
	const date = String(value || "").slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function normalizePost(input, existing = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		const error = new Error("请求内容无效。");
		error.status = 400;
		throw error;
	}
	const title = String(input.title || "").trim();
	const published = String(input.published || "");
	const description = String(input.description || "").trim();
	const category = String(input.category || "").trim();
	const body = String(input.body || "");
	const tags = Array.isArray(input.tags)
		? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
		: String(input.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
	if (!title || title.length > 200) throw Object.assign(new Error("标题不能为空，且不能超过 200 个字符。"), { status: 400 });
	const parsedDate = new Date(`${published}T00:00:00.000Z`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(published) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== published) {
		throw Object.assign(new Error("发布日期必须是有效的 YYYY-MM-DD 日期。"), { status: 400 });
	}
	if (description.length > 1000 || category.length > 100 || tags.some((tag) => tag.length > 50) || tags.length > 30) {
		throw Object.assign(new Error("摘要、分类或标签长度超出限制。"), { status: 400 });
	}
	if (Buffer.byteLength(body, "utf8") > maxBodyBytes) throw Object.assign(new Error("正文不能超过 2 MB。"), { status: 413 });
	const data = {
		...existing,
		title,
		published: new Date(`${published}T00:00:00.000Z`),
		description,
		tags,
		category,
		draft: Boolean(input.draft),
	};
	if (!data.author) data.author = "Kirep";
	return { data, body };
}

async function readJson(req) {
	let bytes = 0;
	const chunks = [];
	for await (const chunk of req) {
		bytes += chunk.length;
		if (bytes > maxBodyBytes + 64 * 1024) throw Object.assign(new Error("请求内容过大。"), { status: 413 });
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("请求必须是有效的 JSON。"), { status: 400 });
	}
}

function buildRelease(outputDir) {
	return new Promise((resolve, reject) => {
		const env = {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			PNPM_HOME: process.env.PNPM_HOME,
			COREPACK_HOME: process.env.COREPACK_HOME,
			NODE_ENV: "production",
			CI: "1",
			ASTRO_OUT_DIR: outputDir,
		};
		const child = spawn(process.env.PNPM_BIN || "pnpm", ["run", "build"], {
			cwd: projectRoot,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		const append = (chunk) => { log = (log + chunk.toString()).slice(-6000); };
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
		child.on("error", (error) => { clearTimeout(timeout); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve(log);
			else {
				console.error(`Astro build failed (exit ${code}).\n${log}`);
				reject(Object.assign(new Error("静态站点构建失败；原文章与线上站点已恢复，请查看服务器日志。"), { status: 500 }));
			}
		});
	});
}

async function publishNewRelease() {
	await fs.mkdir(releasesDir, { recursive: true });
	const release = path.join(releasesDir, `release-${Date.now()}`);
	await fs.mkdir(release, { recursive: true });
	try {
		await buildRelease(release);
		await fs.writeFile(path.join(release, ".kirep-posts-sha256"), await postsDigest(), "utf8");
		const tempLink = `${currentSite}.next-${process.pid}`;
		await fs.rm(tempLink, { recursive: true, force: true });
		await fs.symlink(release, tempLink, "dir");
		await fs.rename(tempLink, currentSite);
		await pruneReleases(release);
		return release;
	} catch (error) {
		await fs.rm(release, { recursive: true, force: true });
		throw error;
	}
}

async function pruneReleases(currentRelease) {
	const entries = await fs.readdir(releasesDir, { withFileTypes: true });
	const releases = entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("release-"))
		.map((entry) => path.join(releasesDir, entry.name))
		.sort()
		.reverse();
	const keep = new Set([currentRelease, ...releases.slice(0, 2)]);
	for (const release of releases) {
		if (!keep.has(release)) await fs.rm(release, { recursive: true, force: true });
	}
}

async function restoreFile(file, backup) {
	if (backup === null) await fs.rm(file, { force: true });
	else {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, backup, "utf8");
	}
}

async function mutatePost(file, newContents) {
	if (busy) throw Object.assign(new Error("另一篇文章正在构建发布，请稍后重试。"), { status: 409 });
	busy = true;
	try {
		const backup = await fs.readFile(file, "utf8").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
		await fs.mkdir(path.dirname(file), { recursive: true });
		if (newContents === null) {
			const trashPath = path.join(trashDir, `${Date.now()}-${path.relative(postsDir, file)}`);
			await fs.mkdir(path.dirname(trashPath), { recursive: true });
			await fs.copyFile(file, trashPath);
			await fs.rm(file);
			try { await publishNewRelease(); }
			catch (error) {
				await fs.mkdir(path.dirname(file), { recursive: true });
				await fs.copyFile(trashPath, file);
				await fs.rm(trashPath);
				throw error;
			}
		} else {
			await fs.writeFile(file, newContents, "utf8");
			try { await publishNewRelease(); }
			catch (error) { await restoreFile(file, backup); throw error; }
		}
	} finally {
		busy = false;
	}
}

async function serveStatic(req, res, pathname, staticRoot = currentSite, isAdmin = false) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { Allow: "GET, HEAD" }).end();
		return;
	}
	let decoded;
	try { decoded = decodeURIComponent(pathname); }
	catch { res.writeHead(400).end(); return; }
	if (decoded.includes("\\") || decoded.includes("\0")) { res.writeHead(400).end(); return; }
	if (decoded.split("/").some((part) => part.startsWith("."))) { res.writeHead(404).end("Not found"); return; }
	let root;
	try { root = await fs.realpath(staticRoot); }
	catch { res.writeHead(503, { "Retry-After": "5" }).end("Site is initializing"); return; }
	const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
	let target = path.resolve(root, rel);
	if (!isInside(root, target)) { res.writeHead(403).end(); return; }
	try {
		let stat = await fs.stat(target);
		if (stat.isDirectory()) {
			target = path.join(target, "index.html");
			stat = await fs.stat(target);
		}
		if (!stat.isFile()) throw new Error("not a file");
	} catch {
		if (!path.extname(target)) {
			try {
				target = path.join(target, "index.html");
				const stat = await fs.stat(target);
				if (!stat.isFile()) throw new Error("not a file");
			} catch { res.writeHead(404).end("Not found"); return; }
		} else { res.writeHead(404).end("Not found"); return; }
	}
	const headers = {
		"Content-Type": mimeTypes.get(path.extname(target).toLowerCase()) || "application/octet-stream",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "strict-origin-when-cross-origin",
		"X-Frame-Options": "DENY",
		"Cache-Control": isAdmin || /\.html?$/.test(target) ? "no-store" : "public, max-age=3600",
		"Accept-Ranges": "bytes",
	};
	if (isAdmin) {
		headers["Referrer-Policy"] = "no-referrer";
		headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
	}
	if (req.headers["x-forwarded-proto"] === "https") headers["Strict-Transport-Security"] = "max-age=31536000";
	if (req.method === "HEAD") {
		headers["Content-Length"] = String(stat.size);
		res.writeHead(200, headers).end();
		return;
	}
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
	if (range) {
		const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2] || 0));
		const end = range[2] && range[1] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) {
			res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" }).end();
			return;
		}
		headers["Content-Length"] = String(end - start + 1);
		headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
		res.writeHead(206, headers);
		createReadStream(target, { start, end }).pipe(res);
		return;
	}
	headers["Content-Length"] = String(stat.size);
	res.writeHead(200, headers);
	createReadStream(target).pipe(res);
}

async function routeApi(req, res, url) {
	const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
	const ip = forwarded || req.socket.remoteAddress || "unknown";
	if (limited(ip)) return sendJson(res, 429, { error: "登录尝试过多，请一分钟后再试。" });
	if (!hasValidKey(req)) {
		recordFailure(ip);
		return sendJson(res, 401, { error: "密钥无效或未提供。" });
	}
	if (req.method !== "GET" && !hasExpectedOrigin(req)) return sendJson(res, 403, { error: "请求来源无效。" });
	const pathName = url.pathname;
	if (pathName === "/api/admin/status" && req.method === "GET") {
		return sendJson(res, 200, { ok: true, busy, posts: await walkPosts() });
	}
	if (pathName === "/api/admin/posts" && req.method === "GET") {
		return sendJson(res, 200, { posts: await walkPosts() });
	}
	const match = /^\/api\/admin\/posts\/(.+)$/.exec(pathName);
	if (match) {
		let slug;
		try { slug = decodeURIComponent(match[1]); }
		catch { return sendJson(res, 400, { error: "文章路径编码无效。" }); }
		assertSlug(slug);
		const file = await getPostPath(slug, req.method === "POST");
		if (req.method === "GET") {
			if (!file) return sendJson(res, 404, { error: "文章不存在。" });
			const parsed = matter(await fs.readFile(file, "utf8"));
			return sendJson(res, 200, { slug, title: String(parsed.data.title || ""), published: toIsoDate(parsed.data.published), description: String(parsed.data.description || ""), category: String(parsed.data.category || ""), tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [], draft: Boolean(parsed.data.draft), body: parsed.content, fields: parsed.data });
		}
		if (req.method === "POST") {
			if (file && await fs.stat(file).then(() => true, () => false)) return sendJson(res, 409, { error: "这个 slug 已存在。" });
			const { data, body } = normalizePost(await readJson(req));
			await mutatePost(file, matter.stringify(body, data));
			return sendJson(res, 201, { ok: true, slug, url: `/posts/${slug}/` });
		}
		if (req.method === "PUT") {
			if (!file) return sendJson(res, 404, { error: "文章不存在。" });
			const parsed = matter(await fs.readFile(file, "utf8"));
			const { data, body } = normalizePost(await readJson(req), parsed.data);
			await mutatePost(file, matter.stringify(body, data));
			return sendJson(res, 200, { ok: true, slug, url: `/posts/${slug}/` });
		}
		if (req.method === "DELETE") {
			if (!file) return sendJson(res, 404, { error: "文章不存在。" });
			await mutatePost(file, null);
			return sendJson(res, 200, { ok: true, slug, deleted: true });
		}
		return sendJson(res, 405, { error: "方法不受支持。" });
	}
	return sendJson(res, 404, { error: "接口不存在。" });
}

async function ensureInitialRelease() {
	try {
		const root = await fs.realpath(currentSite);
		const [previousDigest, currentDigest] = await Promise.all([
			fs.readFile(path.join(root, ".kirep-posts-sha256"), "utf8").catch(() => ""),
			postsDigest(),
		]);
		if (previousDigest === currentDigest) return;
	} catch {}
	await publishNewRelease();
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		if (url.pathname.startsWith("/api/admin/")) await routeApi(req, res, url);
		else if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
			const adminPath = url.pathname.slice("/admin".length) || "/";
			await serveStatic(req, res, adminPath, path.join(projectRoot, "admin/public"), true);
		}
		else await serveStatic(req, res, url.pathname);
	} catch (error) {
		if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || "服务器内部错误。" });
		else res.destroy(error);
	}
});

await fs.mkdir(path.dirname(currentSite), { recursive: true });
await ensureInitialRelease();
server.listen(port, "0.0.0.0", () => console.log(`Kirep blog server listening on ${port}`));
