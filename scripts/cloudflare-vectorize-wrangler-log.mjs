import { unlink } from "node:fs/promises";

export async function removeTemporaryWranglerLog(file) {
    try {
        await unlink(file);
    } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") return;
        throw new Error("temporary Wrangler log could not be removed");
    }
}

export async function withTemporaryWranglerLogRemoved(file, run) {
    await removeTemporaryWranglerLog(file);
    try {
        return await run();
    } finally {
        await removeTemporaryWranglerLog(file);
    }
}
