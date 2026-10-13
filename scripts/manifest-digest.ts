import { createHash } from "node:crypto";

export function manifestDigest(contents: string | Uint8Array): string {
  const manifest: unknown = JSON.parse(typeof contents === "string" ? contents : new TextDecoder().decode(contents));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("package.json must be a JSON object");
  }
  const { version: _, ...inputs } = manifest as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}
