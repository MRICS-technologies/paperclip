import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import {
  ensureLocalPluginBuilt,
  pluginLoader,
  REPO_ROOT,
} from "../services/plugin-loader.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin install auto-build tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type FixturePlugin = {
  packageName: string;
  pluginKey: string;
  packageRoot: string;
  distDir: string;
};

const repoPluginRoot = path.join(REPO_ROOT, "packages", "plugins");
const standaloneRepoPluginRoot = path.join(repoPluginRoot, "sandbox-providers");

async function createBundledPluginFixture(
  nameSuffix: string,
  options: { rootDir?: string; buildDistImmediately?: boolean } = {},
): Promise<FixturePlugin> {
  const slug = `plugin-autobuild-${nameSuffix}-${randomUUID().slice(0, 8)}`;
  const packageName = `@paperclipai/${slug}`;
  const pluginKey = `paperclip.${slug.replace(/^plugin-/, "").replace(/-/g, "_")}`;
  const packageRoot = path.join(options.rootDir ?? repoPluginRoot, slug);
  const distDir = path.join(packageRoot, "dist");
  const isStandaloneFixture = (options.rootDir ?? repoPluginRoot) === standaloneRepoPluginRoot;
  const postinstallScript = isStandaloneFixture
    ? `node ${path.relative(packageRoot, path.join(REPO_ROOT, "scripts", "link-plugin-dev-sdk.mjs"))}`
    : null;

  await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        ...(postinstallScript ? { postinstall: postinstallScript } : {}),
        build: "node ./scripts/build.mjs",
      },
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
        worker: "./dist/worker.js",
        ui: "./dist/ui/",
      },
    }, null, 2),
    "utf8",
  );

  const manifest = {
    id: pluginKey,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Autobuild Fixture",
    description: "Bundled plugin fixture for install-time auto-build coverage.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["companies.read"],
    entrypoints: {
      worker: "./dist/worker.js",
    },
  };

  await writeFile(
    path.join(packageRoot, "scripts", "build.mjs"),
    [
      "import { mkdir, writeFile } from \"node:fs/promises\";",
      "import path from \"node:path\";",
      "import { fileURLToPath } from \"node:url\";",
      "",
      "const scriptDir = path.dirname(fileURLToPath(import.meta.url));",
      "const packageRoot = path.resolve(scriptDir, \"..\");",
      "const distDir = path.join(packageRoot, \"dist\");",
      "const uiDir = path.join(distDir, \"ui\");",
      `const manifest = ${JSON.stringify(manifest, null, 2)};`,
      "",
      "await mkdir(uiDir, { recursive: true });",
      "await writeFile(path.join(distDir, \"manifest.js\"), `export default ${JSON.stringify(manifest, null, 2)};\\n`, \"utf8\");",
      "await writeFile(path.join(distDir, \"worker.js\"), \"export {};\\n\", \"utf8\");",
      "await writeFile(path.join(uiDir, \"index.js\"), \"export default {};\\n\", \"utf8\");",
    ].join("\n"),
    "utf8",
  );

  if (options.buildDistImmediately) {
    await mkdir(path.join(distDir, "ui"), { recursive: true });
    await writeFile(path.join(distDir, "manifest.js"), `export default ${JSON.stringify(manifest, null, 2)};\n`, "utf8");
    await writeFile(path.join(distDir, "worker.js"), "export {};\n", "utf8");
    await writeFile(path.join(distDir, "ui", "index.js"), "export default {};\n", "utf8");
  }

  return { packageName, pluginKey, packageRoot, distDir };
}

async function createInstallApp(db: ReturnType<typeof createDb>) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const loader = pluginLoader(db, {
    enableLocalFilesystem: false,
    enableNpmDiscovery: false,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(db as never, loader as never, {} as never, undefined, {} as never, {} as never));
  app.use(errorHandler);
  return app;
}

describe("ensureLocalPluginBuilt", () => {
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  it("skips auto-build for local plugin paths outside the repo", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-outside-"));
    const packageRoot = path.join(tempRoot, "plugin-outside");
    cleanupPaths.add(path.dirname(packageRoot));
    await mkdir(packageRoot, { recursive: true });

    const execStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await ensureLocalPluginBuilt(
      packageRoot,
      {
        name: "@paperclipai/plugin-outside",
        paperclipPlugin: {
          manifest: "./dist/manifest.js",
          worker: "./dist/worker.js",
        },
      },
      { execFileAsyncImpl: execStub },
    );

    expect(execStub).not.toHaveBeenCalled();
  });

  it("skips auto-build when PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD=1", async () => {
    const fixture = await createBundledPluginFixture("skip");
    cleanupPaths.add(fixture.packageRoot);

    const execStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      {
        processEnv: { PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD: "1" },
        execFileAsyncImpl: execStub,
      },
    );

    expect(execStub).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing dist and node_modules", buildDistImmediately: false, expected: /built entrypoints: manifest, worker, ui; runtime dependencies: @paperclipai\/plugin-sdk/ },
    { label: "missing node_modules only", buildDistImmediately: true, expected: /missing runtime dependencies: @paperclipai\/plugin-sdk\)/ },
  ])("rejects unbaked sandbox providers in the production container without a runtime build ($label)", async ({ buildDistImmediately, expected }) => {
    // Regression: the production image has no provider toolchain, so the old
    // runtime `pnpm install && pnpm build` died with "tsc: not found". A
    // provider with dist but no node_modules must not pass as a broken worker.
    const fixture = await createBundledPluginFixture("standalone-production", {
      rootDir: standaloneRepoPluginRoot,
      buildDistImmediately,
    });
    cleanupPaths.add(fixture.packageRoot);
    const pkgJson = JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>;

    for (const processEnv of [{ PAPERCLIP_PRODUCTION_CONTAINER: "1" }, { PAPERCLIP_PRODUCTION_CONTAINER: "1", PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD: "1" }]) {
      const execStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const result = ensureLocalPluginBuilt(fixture.packageRoot, pkgJson, { processEnv, execFileAsyncImpl: execStub });
      await expect(result).rejects.toThrow(expected);
      await expect(result).rejects.toThrow(/is not prebuilt in this image.*Docker target `cloud` and CLOUD_BUNDLED_PLUGINS including `plugin-autobuild-standalone-production-/);
      expect(execStub).not.toHaveBeenCalled();
    }
  });

  it("accepts a baked sandbox provider in the production container without running anything", async () => {
    const fixture = await createBundledPluginFixture("standalone-production-baked", {
      rootDir: standaloneRepoPluginRoot,
      buildDistImmediately: true,
    });
    cleanupPaths.add(fixture.packageRoot);
    await mkdir(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"), { recursive: true });

    const execStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      { processEnv: { PAPERCLIP_PRODUCTION_CONTAINER: "1" }, execFileAsyncImpl: execStub },
    );

    expect(execStub).not.toHaveBeenCalled();
  });

  it("still auto-builds sandbox providers under NODE_ENV=production outside the production container", async () => {
    // Regression: a source-checkout operator running NODE_ENV=production with
    // a toolchain must keep the runtime provider build; only the image marker
    // turns it off.
    const fixture = await createBundledPluginFixture("standalone-node-env-production", { rootDir: standaloneRepoPluginRoot });
    cleanupPaths.add(fixture.packageRoot);

    const execStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await expect(ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      { processEnv: { NODE_ENV: "production" }, execFileAsyncImpl: execStub },
    )).rejects.toThrow(/still missing built entrypoints.*after auto-build/);

    expect(execStub).toHaveBeenCalledWith(
      "pnpm",
      ["install", "--ignore-workspace", "--no-lockfile"],
      { cwd: fixture.packageRoot, timeout: 120_000 },
    );
    expect(execStub).toHaveBeenCalledWith("pnpm", ["build"], { cwd: fixture.packageRoot, timeout: 120_000 });
  });

  it("still auto-builds workspace bundled plugins in the production container", async () => {
    const fixture = await createBundledPluginFixture("workspace-production");
    cleanupPaths.add(fixture.packageRoot);

    const execStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await expect(ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      { processEnv: { PAPERCLIP_PRODUCTION_CONTAINER: "1" }, execFileAsyncImpl: execStub },
    )).rejects.toThrow(/still missing built entrypoints/);

    expect(execStub).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", fixture.packageName, "build"],
      { cwd: REPO_ROOT, timeout: 120_000 },
    );
  });

  it.each([
    undefined,
    "allowBuilds:\n  protobufjs: false\n",
    "packages:\n  - ../untrusted\ndangerouslyAllowAllBuilds: true\n",
  ])("bootstraps standalone plugins without trusting workspace policy: %s", async (localPolicy) => {
    const fixture = await createBundledPluginFixture("standalone", { rootDir: standaloneRepoPluginRoot });
    cleanupPaths.add(fixture.packageRoot);

    if (localPolicy) await writeFile(path.join(fixture.packageRoot, "pnpm-workspace.yaml"), localPolicy);
    const installArgs = ["install", "--ignore-workspace", ...(localPolicy ? ["--ignore-scripts"] : []), "--no-lockfile"];
    const execStub = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.join(" ") === installArgs.join(" ")) {
        await mkdir(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"), { recursive: true });
      }
      if (args.join(" ") === "build") {
        await mkdir(path.join(fixture.distDir, "ui"), { recursive: true });
        await writeFile(path.join(fixture.distDir, "manifest.js"), "export default {};\n", "utf8");
        await writeFile(path.join(fixture.distDir, "worker.js"), "export {};\n", "utf8");
        await writeFile(path.join(fixture.distDir, "ui", "index.js"), "export default {};\n", "utf8");
      }
      return { stdout: "", stderr: "" };
    });
    await ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      { execFileAsyncImpl: execStub },
    );

    expect(execStub).toHaveBeenCalledTimes(2);
    expect(execStub).toHaveBeenNthCalledWith(
      1,
      "pnpm",
      installArgs,
      { cwd: fixture.packageRoot, timeout: 120_000 },
    );
    expect(execStub).toHaveBeenNthCalledWith(
      2,
      "pnpm",
      ["build"],
      { cwd: fixture.packageRoot, timeout: 120_000 },
    );
  });

  it("bootstraps standalone bundled plugin runtime dependencies when dist already exists", async () => {
    const fixture = await createBundledPluginFixture("standalone-runtime", {
      rootDir: standaloneRepoPluginRoot,
      buildDistImmediately: true,
    });
    cleanupPaths.add(fixture.packageRoot);

    const execStub = vi.fn(async () => {
      await mkdir(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"), { recursive: true });
      return { stdout: "", stderr: "" };
    });
    await ensureLocalPluginBuilt(
      fixture.packageRoot,
      JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8")) as Record<string, unknown>,
      { execFileAsyncImpl: execStub },
    );

    expect(execStub).toHaveBeenCalledTimes(1);
    expect(execStub).toHaveBeenNthCalledWith(
      1,
      "pnpm",
      ["install", "--ignore-workspace", "--no-lockfile"],
      { cwd: fixture.packageRoot, timeout: 120_000 },
    );
  });
});

describeEmbeddedPostgres("plugin install auto-build route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupPaths = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-autobuild-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(plugins);
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
    delete process.env["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  it("auto-builds bundled local plugins during POST /api/plugins/install when dist is missing", async () => {
    const fixture = await createBundledPluginFixture("success");
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(200);
    expect(res.body.packageName).toBe(fixture.packageName);
    expect(res.body.pluginKey).toBe(fixture.pluginKey);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "worker.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "ui", "index.js"))).toBe(true);
    expect(mockLifecycle.load).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("auto-builds standalone bundled local plugins outside the root pnpm workspace", async () => {
    const fixture = await createBundledPluginFixture("standalone-success", { rootDir: standaloneRepoPluginRoot });
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);
    expect(existsSync(path.join(fixture.packageRoot, "node_modules"))).toBe(false);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(200);
    expect(res.body.packageName).toBe(fixture.packageName);
    expect(res.body.pluginKey).toBe(fixture.pluginKey);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "worker.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "ui", "index.js"))).toBe(true);
    expect(existsSync(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"))).toBe(true);
    expect(mockLifecycle.load).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("bootstraps standalone bundled local plugin runtime dependencies when dist already exists", async () => {
    const fixture = await createBundledPluginFixture("standalone-runtime-success", {
      rootDir: standaloneRepoPluginRoot,
      buildDistImmediately: true,
    });
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(true);
    expect(existsSync(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"))).toBe(false);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(200);
    expect(res.body.packageName).toBe(fixture.packageName);
    expect(res.body.pluginKey).toBe(fixture.pluginKey);
    expect(existsSync(path.join(fixture.packageRoot, "node_modules", "@paperclipai", "plugin-sdk"))).toBe(true);
    expect(mockLifecycle.load).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("returns the manual build command when auto-build is disabled and dist is missing", async () => {
    process.env["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"] = "1";
    const fixture = await createBundledPluginFixture("disabled");
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("does not appear to be a Paperclip plugin (no manifest found)");
    expect(res.body.error).toContain(`pnpm --filter ${fixture.packageName} build`);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);
    expect(mockLifecycle.load).not.toHaveBeenCalled();
  }, 20_000);

  it("returns the standalone bootstrap command when auto-build is disabled for sandbox-provider plugins", async () => {
    process.env["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"] = "1";
    const fixture = await createBundledPluginFixture("standalone-disabled", { rootDir: standaloneRepoPluginRoot });
    cleanupPaths.add(fixture.packageRoot);
    const app = await createInstallApp(db);

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: fixture.packageRoot, isLocalPath: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("does not appear to be a Paperclip plugin (no manifest found)");
    expect(res.body.error).toContain(path.relative(REPO_ROOT, fixture.packageRoot));
    expect(res.body.error).toContain("pnpm install --ignore-workspace --no-lockfile && pnpm build");
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);
    expect(mockLifecycle.load).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects unbuilt sandbox providers in the production container without attempting a runtime build", async () => {
    vi.stubEnv("PAPERCLIP_PRODUCTION_CONTAINER", "1");
    try {
      const fixture = await createBundledPluginFixture("standalone-production-route", { rootDir: standaloneRepoPluginRoot });
      cleanupPaths.add(fixture.packageRoot);
      const app = await createInstallApp(db);

      const res = await request(app)
        .post("/api/plugins/install")
        .send({ packageName: fixture.packageRoot, isLocalPath: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(`Sandbox provider ${fixture.packageName} is not prebuilt in this image`);
      expect(res.body.error).toContain("Docker target `cloud`");
      expect(res.body.error).not.toContain("does not appear to be a Paperclip plugin");
      expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);
      expect(existsSync(path.join(fixture.packageRoot, "node_modules"))).toBe(false);
      expect(mockLifecycle.load).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20_000);
});
