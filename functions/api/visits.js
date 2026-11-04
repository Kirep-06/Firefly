const cookieName = "kirep_visitor";
const visitorIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost({ request, env }) {
	const origin = request.headers.get("Origin");
	if (origin && origin !== new URL(request.url).origin) {
		return new Response(null, { status: 403 });
	}
	if (!env.VISITS_DB) {
		return new Response(null, { status: 503 });
	}

	const cookie = request.headers.get("Cookie") ?? "";
	const visitorId = cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
	const id = visitorIdPattern.test(visitorId ?? "") ? visitorId : crypto.randomUUID();

	try {
		const result = await env.VISITS_DB.prepare("INSERT OR IGNORE INTO visitors (id) VALUES (?)").bind(id).run();
		await env.VISITS_DB.prepare("UPDATE stats SET pv = pv + 1, uv = uv + ? WHERE id = 1")
			.bind(result.meta.changes > 0 ? 1 : 0).run();
		const stats = await env.VISITS_DB.prepare("SELECT pv, uv FROM stats WHERE id = 1").first();
		return Response.json(stats, {
			headers: {
			"Cache-Control": "no-store",
			"Set-Cookie": `${cookieName}=${id}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`,
		},
		});
	} catch {
		return new Response(null, { status: 503 });
	}
}
