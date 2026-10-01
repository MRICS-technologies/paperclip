import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_CATALOG } from "../services/bundled-plugins.js";

/**
 * Drift guard for the cloud image variant (Dockerfile `cloud` target).
 *
 * The cloud image builds the sandbox-provider plugins named in the
 * CLOUD_BUNDLED_PLUGINS build arg so managed instances can auto-install
 * them from the bundled catalog at boot. That contract spans three places
 * that nothing else ties together: the Dockerfile ARG default, the docker
 * workflow's build-arg, and BUNDLED_PLUGIN_CATALOG. A rename or removal in
 * any one of them would otherwise surface only when the image build fails
 * on master — or worse, as a silent "bundle not present" skip at instance
 * boot.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker.yml"), "utf8");
const cloudWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker-cloud.yml"), "utf8");
const mricsWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "mrics-production-image.yml"), "utf8");

function parseList(source: string, pattern: RegExp, label: string): string[] {
  const match = source.match(pattern);
  expect(match, `${label} must declare CLOUD_BUNDLED_PLUGINS`).toBeTruthy();
  const names = (match?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  expect(names.length, `${label} CLOUD_BUNDLED_PLUGINS must not be empty`).toBeGreaterThan(0);
  return names;
}

const dockerfileDefault = parseList(
  dockerfile,
  /^ARG CLOUD_BUNDLED_PLUGINS="([^"]*)"/m,
  "Dockerfile",
);
const workflowArg = parseList(
  cloudWorkflow,
  /^\s*CLOUD_BUNDLED_PLUGINS=(.*)$/m,
  "docker workflow",
);

describe("cloud image bundled plugins", () => {
  it("keeps the Dockerfile default and the workflow build-arg in sync", () => {
    expect(workflowArg).toEqual(dockerfileDefault);
  });

  it.each([...new Set([...dockerfileDefault, ...workflowArg])])(
    "plugin %s is buildable and resolvable by the auto-installer",
    (name) => {
      const dir = path.join(repoRoot, "packages", "plugins", "sandbox-providers", name);
      expect(existsSync(dir), `${dir} must exist`).toBe(true);
      expect(
        existsSync(path.join(dir, "src", "manifest.ts")),
        `${name} must have src/manifest.ts so the build produces dist/manifest.js`,
      ).toBe(true);
      const packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      expect(packageJson.scripts?.build, `${name} must have a build script`).toBeTruthy();

      // The auto-installer resolves catalog keys to relative paths; a plugin
      // baked into the image but absent from the catalog (or vice versa)
      // can never be auto-installed.
      const catalogEntry = BUNDLED_PLUGIN_CATALOG.find(
        (entry) => entry.relativePath === `sandbox-providers/${name}`,
      );
      expect(catalogEntry, `${name} must be listed in BUNDLED_PLUGIN_CATALOG`).toBeTruthy();
    },
  );

  it("pins the default image build to the production target", () => {
    // The Dockerfile's final stage is `cloud`; without an explicit target
    // the workflow's main build would silently publish the cloud variant
    // to the self-hosted tags.
    expect(workflow).toMatch(/^\s*target: production$/m);
  });

  it("publishes the cloud image in its own job with no needs coupling", () => {
    const caller = workflow.split("  build-and-push-cloud:")[1]?.split("  promote_canary_channel:")[0];
    expect(caller, "tag and manual builds must call the cloud workflow").toContain("uses: ./.github/workflows/docker-cloud.yml");
    expect(caller, "the reusable caller must also remain independent of production").not.toMatch(/^\s*needs:/m);
    // The reusable cloud workflow owns its job and SHA concurrency group.
    // Production publication must not gate, delay, or skip the cloud build.
    const jobsSection = cloudWorkflow.slice(cloudWorkflow.indexOf("\njobs:\n"));
    const headers = [...jobsSection.matchAll(/^ {2}([\w-]+):[^\n]*$/gm)];
    expect(
      headers.length,
      "docker-cloud.yml must declare a cloud build job under jobs:",
    ).toBeGreaterThanOrEqual(1);

    // Locate the job block that carries the cloud build (target: cloud) and
    // assert it declares no `needs:` — coupling it to another job would
    // reintroduce the shared failure the split job exists to remove.
    const cloudHeaderIdx = headers.findIndex((header, i) => {
      const start = header.index ?? 0;
      const end = headers[i + 1]?.index ?? jobsSection.length;
      return jobsSection.slice(start, end).includes("target: cloud");
    });
    expect(cloudHeaderIdx, "one job must build the cloud target").toBeGreaterThanOrEqual(0);
    const start = headers[cloudHeaderIdx].index ?? 0;
    const end = headers[cloudHeaderIdx + 1]?.index ?? jobsSection.length;
    const cloudJobBlock = jobsSection.slice(start, end);
    expect(
      cloudJobBlock,
      "the cloud job must not couple to another job via needs:",
    ).not.toMatch(/^\s*needs:/m);
  });

  it("throttles the docker workflow with cancel-in-progress: false", () => {
    // Concurrency is declared at the workflow (top) level so a single group
    // spans the whole run, and cancel-in-progress is false so an in-flight
    // image build always finishes — a newer push only supersedes the pending
    // slot instead of killing the build that is already publishing.
    expect(workflow).toMatch(/^concurrency:$/m);
    // Pin the per-ref group key: without it the block could keep
    // cancel-in-progress: false yet lose the group that scopes serialization
    // to a single ref, silently changing which builds queue behind each other.
    expect(workflow).toContain("group: docker-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("cancel-in-progress: true");
  });

  it("builds the MRICS production image from the cloud target with only Daytona baked", () => {
    // The production runtime never builds sandbox providers, so the MRICS
    // image must ship Daytona prebuilt (dist + node_modules) via `cloud`.
    expect(mricsWorkflow).toMatch(/^\s*target: cloud$/m);
    expect(mricsWorkflow).not.toMatch(/^\s*target: production$/m);
    expect(parseList(mricsWorkflow, /^\s*CLOUD_BUNDLED_PLUGINS=(.*)$/m, "MRICS workflow")).toEqual(["daytona"]);
    expect(mricsWorkflow).toMatch(/^\s*CLOUD_BUNDLED_SERVER_DEPS=@sentry\/node$/m);
    expect(BUNDLED_PLUGIN_CATALOG.find((entry) => entry.key === "daytona")?.relativePath)
      .toBe("sandbox-providers/daytona");
  });

  it("bakes sandbox providers from their committed lockfile without install scripts", () => {
    const stage = dockerfile.split(/^FROM build AS cloud-plugins$/m)[1]?.split(/^FROM /m)[0] ?? "";
    expect(stage).toContain('pnpm -C "$dir" install --ignore-workspace --ignore-scripts --frozen-lockfile;');
    expect(stage).not.toMatch(/^\s*pnpm [^\n]*--no-lockfile/m);
    // Providers do not declare the SDK; it must be linked before the build.
    const link = stage.indexOf(`m.linkSdkInto(process.argv[1]))" "$PWD/$dir";`);
    expect(link).toBeGreaterThan(stage.indexOf("--frozen-lockfile;"));
    expect(stage.indexOf('pnpm -C "$dir" build;')).toBeGreaterThan(link);
    // After the build, devDependencies are pruned and the SDK link is
    // restored, then both are verified.
    const prune = stage.indexOf('pnpm -C "$dir" prune --prod --ignore-scripts;');
    expect(prune).toBeGreaterThan(stage.indexOf('pnpm -C "$dir" build;'));
    expect(stage.indexOf(`m.linkSdkInto(process.argv[1]))" "$PWD/$dir";`, prune)).toBeGreaterThan(prune);
    expect(stage.slice(prune)).toContain("still has devDependency");
    expect(stage.slice(prune)).toContain("lost its @paperclipai/plugin-sdk link after prune");
    for (const name of parseList(dockerfile, /^ARG CLOUD_BUNDLED_PLUGINS="(.*)"$/m, "Dockerfile")) {
      expect(existsSync(path.join(repoRoot, "packages", "plugins", "sandbox-providers", name, "pnpm-lock.yaml")), name).toBe(true);
    }
  });

  it("proves each baked provider loads its SDK and dependencies from the final cloud image", () => {
    const cloudStage = dockerfile.split(/^FROM production AS cloud$/m)[1] ?? "";
    expect(cloudStage).toMatch(/^ARG CLOUD_BUNDLED_PLUGINS=/m);
    expect(cloudStage).toContain("node --import /app/cli/node_modules/tsx/dist/loader.mjs --input-type=module -e");
    expect(cloudStage).toContain("for (const name of ['@paperclipai/plugin-sdk', ...Object.keys(pkg.dependencies ?? {})]) await import(name);");
    expect(cloudStage).toContain("for (const rel of Object.values(pkg.paperclipPlugin ?? {})) if (!fs.existsSync(rel))");
    // The proof's tsx cache is dropped in the same layer.
    expect(cloudStage).toMatch(/done; \\\n {2}rm -rf "\$\{TMPDIR:-\/tmp\}\/tsx-\$\(id -u\)"$/m);
    // The proof must use the loader the server forks plugin workers with.
    const loaderSource = readFileSync(path.join(repoRoot, "server", "src", "services", "plugin-loader.ts"), "utf8");
    expect(loaderSource).toContain('const DEV_TSX_LOADER_PATH = path.resolve(__dirname, "../../../cli/node_modules/tsx/dist/loader.mjs");');
  });

  it("marks only the production stage as the production container so runtime provider builds stay off", () => {
    const [beforeProduction = "", afterProduction = ""] = dockerfile.split(/^FROM base AS production$/m);
    const productionStage = afterProduction.split(/^FROM /m)[0] ?? "";
    expect(productionStage).toMatch(/^ {2}PAPERCLIP_PRODUCTION_CONTAINER=1 \\$/m);
    // Build stages (and so the provider bake) must not see the marker.
    expect(beforeProduction).not.toContain("PAPERCLIP_PRODUCTION_CONTAINER");
    expect(afterProduction.slice(productionStage.length)).not.toMatch(/PAPERCLIP_PRODUCTION_CONTAINER=/);
  });

  it("installs cloud server deps without lifecycle scripts and documents the no-lockfile trade-off", () => {
    const stage = dockerfile.split(/^FROM build AS cloud-server-deps$/m)[1]?.split(/^FROM /m)[0] ?? "";
    expect(stage).toContain("pnpm add --ignore-workspace --ignore-scripts --no-lockfile $specifiers");
    expect(dockerfile).toContain("The install writes no lock file (`--no-lockfile`) on purpose.");
  });
});
