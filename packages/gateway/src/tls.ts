import { readFileSync } from "node:fs";
import type { ServerOptions } from "node:https";

export interface ChannelTlsOptions {
	keyFile: string;
	certFile: string;
	caFile?: string;
}

export function readTlsOptions(options: ChannelTlsOptions): ServerOptions {
	return {
		key: readFileSync(options.keyFile),
		cert: readFileSync(options.certFile),
		...(options.caFile ? { ca: readFileSync(options.caFile) } : {}),
	};
}
