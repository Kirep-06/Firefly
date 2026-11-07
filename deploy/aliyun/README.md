# 阿里云 ECS 部署

方案：Node.js 22 + systemd 运行 Astro 静态站点和同源文章管理 API；系统 Nginx 反向代理并提供 TLS。文章保存为 Markdown，服务端先构建一个独立发布目录，成功后原子切换站点目录。构建失败时恢复原文章并继续提供上一版站点。此部署不重启或调整 Docker Engine，避免影响 ECS 上已有容器。

管理界面和 API 源码位于 `admin/`，不随当前 Cloudflare 静态站点打包；因此迁移完成前，Cloudflare Pages 仍保持现状。

## 安全设置

- `ADMIN_API_KEY` 只放在服务器 `/etc/kirep-blog.env`，不要放进 Git、浏览器代码或聊天消息。
- 浏览器在 `/admin/` 输入密钥；密钥只保存在当前页面内存，刷新页面后需重新输入。
- 公网只开放 80/443；SSH 端口仅允许你的管理 IP。管理 API 仅绑定 `127.0.0.1:3000`。
- 管理 API 要求正确的 Bearer 密钥、匹配 `https://kirep.top` 的 Origin，并限制请求体大小。文章删除会先移到持久化回收区。
- 大陆 ECS 对外提供网站服务前，需确认 `kirep.top` 的备案接入已包含阿里云；如果此前只在其他接入商备案，需要按阿里云要求补充接入备案。

## 首次部署

1. 安装 Nginx、Git、curl 和 xz-utils；将仓库克隆到 `/srv/kirep-blog`。
2. 在阿里云 Node.js 发行镜像站下载 Node.js 22.23.4 Linux x64 压缩包和 `SHASUMS256.txt`，并用清单校验文件后安装到 `/opt/kirep-blog/node-v22.23.4`。不要替换系统 Node.js。
3. 创建无登录系统用户 `kirep-blog`，将仓库和 `/var/lib/kirep-blog` 交给该用户；启用 Corepack 并安装仓库指定的 pnpm 版本。若 ECS 访问 Docker Hub 超时，不要为了博客重启全局 Docker 服务。
4. 使用 `pnpm install --frozen-lockfile` 安装依赖，先将生产站点构建到 `/var/lib/kirep-blog/releases/initial`，再创建 `/var/lib/kirep-blog/current` 符号链接。
5. 把 `deploy/aliyun/kirep-blog.service` 安装到 `/etc/systemd/system/`。在 `/etc/kirep-blog.env` 设置 `ADMIN_API_KEY`、`PORT=3000`、`SITE_ORIGIN=https://kirep.top`、`POSTS_DIR=/srv/kirep-blog/src/content/posts`、`POSTS_TRASH_DIR=/var/lib/kirep-blog/trash`、`SITE_RELEASES_DIR=/var/lib/kirep-blog/releases` 和 `SITE_CURRENT_DIR=/var/lib/kirep-blog/current`；环境文件仅允许 root 读取。启动并检查 `kirep-blog` 服务。
6. 把 `deploy/aliyun/nginx-kirep.conf` 安装为 Nginx 站点配置，检查配置并重载 Nginx。先用 `curl -H 'Host: kirep.top' http://127.0.0.1/` 确认站点响应。
7. 若 DNS 由 Cloudflare 管理，只改 `kirep.top` 的 A 记录为 ECS 公网 IP，暂时设为 DNS only；保持原有 nameserver，并保留 Cloudflare Pages 配置便于回退。确认没有指向旧主机的 AAAA 记录。
8. DNS 生效后使用 Certbot 为 `kirep.top` 配置 HTTPS：`sudo certbot --nginx -d kirep.top --redirect`。确认浏览器能打开 `https://kirep.top/` 和 `https://kirep.top/admin/` 后再使用管理密钥。若之后重新启用 Cloudflare 代理，需把 SSL/TLS 模式设为 Full (strict)。

## 文章管理

浏览器打开 `https://kirep.top/admin/`，输入服务器密钥。可以查看、创建、修改和删除文章。新建文章 slug 只允许中文、字母、数字、连字符和 `/`，不能使用点号或路径穿越字符。发布日期按站点的 `YYYY-MM-DD` 规则保存。

管理端绑定到 `kirep.top` 同源 API。不要在 HTTPS 尚未配置时把管理页暴露到公网。不要把端口 3000 添加到 ECS 安全组。

## 更新代码

把代码更新到 `/srv/kirep-blog` 后，以 `kirep-blog` 用户安装依赖并执行：

```sh
cd /srv/kirep-blog
pnpm install --frozen-lockfile
sudo systemctl restart kirep-blog
```

文章位于 `/srv/kirep-blog/src/content/posts`，已删除文章位于 `/var/lib/kirep-blog/trash/`，发布版本位于 `/var/lib/kirep-blog/releases/`。备份文章、回收区和环境密钥。
