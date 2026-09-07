import { join } from "node:path";
/**
 * Remediation launcher: marketplace installation never puts `pstack` on PATH,
 * so every recovery instruction names the self-resolvable installed CLI
 * entrypoint instead of a bare, unexecutable command.
 */
export function pstackCommand(...args: string[]): string {
	return `bun ${JSON.stringify(join(import.meta.dir, "cli.ts"))} ${args.join(" ")}`;
}
