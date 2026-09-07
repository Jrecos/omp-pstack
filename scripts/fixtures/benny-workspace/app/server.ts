// Static fixture app server: serves index.html from its own directory.
// Runs inside the workspace container as `bun /workspace/app/server.ts <port>`.
const port = Number(process.argv[2] ?? 8791);
const index = await Bun.file(new URL("./index.html", import.meta.url)).text();
Bun.serve({
	port,
	fetch: () => new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } }),
});
console.log(`fixture app listening on ${port}`);
