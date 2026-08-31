import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
    entries: ["src/index"],
    declaration: "compatible",
    clean: true,
    rollup: {
        emitCJS: false,
        inlineDependencies: false,
        esbuild: { target: "es2022" },
    },
    externals: ["@chardb/core", "@chardb/core/internal/react", "better-auth", "drizzle-orm", "react"],
    failOnWarn: true,
});
