export default {
	fetch(request: Request): Response {
		void request;
		return new Response("giraffe", {
			status: 200,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	},
} satisfies ExportedHandler;
