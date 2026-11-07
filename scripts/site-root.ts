import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 构建产物根目录。
 *
 * Cloudflare Pages 上构建时启用了 @astrojs/cloudflare adapter（CF_WORKERS 环境变量），
 * Astro 把静态站点输出到 dist/client；本地直接跑 astro build 时输出到 dist。
 */
export function resolveSiteRoot(): string {
	if (process.env.ASTRO_OUT_DIR) return path.resolve(process.env.ASTRO_OUT_DIR);
	return existsSync("dist/client") ? "dist/client" : "dist";
}
