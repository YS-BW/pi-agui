import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ThreadBinding {
	threadId: string;
	sessionId: string;
	cwd: string;
}
/** One atomically replaced file per thread. Use one supervisor per store. */
export class FileBindingStore {
	readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
	}
	private path(id: string) {
		return join(this.directory, createHash("sha256").update(id).digest("hex") + ".json");
	}
	async load(threadId: string): Promise<ThreadBinding | undefined> {
		let raw: string;
		try {
			raw = await readFile(this.path(threadId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const value = JSON.parse(raw);
		if (value.threadId !== threadId || typeof value.sessionId !== "string" || typeof value.cwd !== "string") throw new Error("Invalid thread binding");
		return value;
	}
	async save(binding: ThreadBinding) {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const destination = this.path(binding.threadId);
		const temporary = destination + "." + randomUUID() + ".tmp";
		await writeFile(temporary, JSON.stringify(binding), { mode: 0o600 });
		await rename(temporary, destination);
	}
}
