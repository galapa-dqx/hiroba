import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "server",
	adapter: cloudflare({
		platformProxy: {
			enabled: true,
			persist: { path: "../../.wrangler-shared/v3" },
		},
	}),
	integrations: [react()],
});
