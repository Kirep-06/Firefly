# 阿里云 ECS 部署

方案：Docker Compose 运行 Astro 静态站点和同源文章管理 API；Nginx 在 ECS 上反向代理并提供 TLS。文章保存为 Markdown，服务端先构建一个独立发布目录，成功后原子切换站点目录。构建失败时恢复原文章并继续提供上一版站点。

管理界面和 API 源码位于 `admin/`，不随当前 Cloudflare 静态站点打包；因此迁移完成前，Cloudflare Pages 仍保持现状。

## 安全设置

- `ADMIN_API_KEY` 只放在服务器 `deploy/aliyun/.env`，不要放进 Git、浏览器代码或聊天消息。
- 浏览器在 `/admin/` 输入密钥；密钥只保存在当前页面内存，刷新页面后需重新输入。
- 公网只开放 80/443；SSH 端口仅允许你的管理 IP。Docker 将管理服务绑定到 `127.0.0.1:3000`。
- 管理 API 要求正确的 Bearer 密钥、匹配 `https://kirep.top` 的 Origin，并限制请求体大小。文章删除会先移到持久化回收区。
- 大陆 ECS 对外提供网站服务前，需确认 `kirep.top` 的备案接入已包含阿里云；如果此前只在其他接入商备案，需要按阿里云要求补充接入备案。

## 首次部署

1. 在 ECS 安装 Docker Engine、Docker Compose 插件和 Nginx，并将仓库克隆到 `/srv/kirep-blog`。
2. 在 `/srv/kirep-blog/deploy/aliyun` 创建 `.env`，运行 `printf 'ADMIN_API_KEY=%s\n' "$(openssl rand -hex 32)" > .env` 生成随机密钥；将文件权限设为仅 root 可读（`chmod 600 .env`）。
3. 执行 `docker compose -f /srv/kirep-blog/deploy/aliyun/compose.yaml up -d --build`。首次构建可能需要几分钟。管理 API 只绑定本机 3000 端口。
4. 把 `deploy/aliyun/nginx-kirep.conf` 安装为 Nginx 站点配置，检查配置并启动 Nginx。先通过 `http://ECS公网IP/` 确认站点可访问。
5. 若 DNS 由 Cloudflare 管理，只改 `kirep.top` 的 A 记录为 ECS 公网 IP，暂时设为 DNS only；保持原有 nameserver，并保留 Cloudflare Pages 配置便于回退。确认没有指向旧主机的 AAAA 记录。
6. DNS 生效后使用 Certbot 为 `kirep.top` 配置 HTTPS：`sudo certbot --nginx -d kirep.top --redirect`。确认浏览器能打开 `https://kirep.top/` 和 `https://kirep.top/admin/` 后再使用管理密钥。若之后重新启用 Cloudflare 代理，需把 SSL/TLS 模式设为 Full (strict)。

## 文章管理

浏览器打开 `https://kirep.top/admin/`，输入服务器密钥。可以查看、创建、修改和删除文章。新建文章 slug 只允许中文、字母、数字、连字符和 `/`，不能使用点号或路径穿越字符。发布日期按站点的 `YYYY-MM-DD` 规则保存。

管理端绑定到 `kirep.top` 同源 API。不要在 HTTPS 尚未配置时把管理页暴露到公网。不要把端口 3000 添加到 ECS 安全组。

## 更新代码

把代码更新到 `/srv/kirep-blog` 后执行：

```sh
cd /srv/kirep-blog
docker compose -f deploy/aliyun/compose.yaml up -d --build
```

持久化文章数据位于 Compose 的 `blog-posts` 卷，已删除文章位于 `blog-data` 卷的 `trash/` 目录。备份这两个卷。
