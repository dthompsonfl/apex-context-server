import fg from "fast-glob";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { authorizeFile, isSensitivePath, readAuthorizedSource } from "./safety.js";

export interface PackageMeta {
  name: string;
  version: string;
  path: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  internalDependencies: string[];
}

export type WorkspaceTopology = Record<string, PackageMeta>;

export async function getWorkspaceTopology(
  root = process.cwd(),
): Promise<WorkspaceTopology> {
  const cwd = path.resolve(root);
  const files = await fg(await getWorkspacePackagePatterns(cwd), {
    absolute: true,
    cwd,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  const raw: Array<{ filePath: string; pkg: WorkspacePackageJson }> = [];
  const allNames = new Set<string>();

  for (const filePath of files.sort()) {
    if (isSensitivePath(path.relative(cwd, filePath))) continue;
    try {
      const allowed = authorizeFile(cwd, filePath);
      const pkg = JSON.parse((await readAuthorizedSource(cwd, allowed)).text) as PackageJson;
      if (!pkg.name || typeof pkg.name !== "string") {
        continue;
      }

      allNames.add(pkg.name);
      raw.push({ filePath, pkg: { ...pkg, name: pkg.name } });
    } catch {
      continue;
    }
  }

  const topology: WorkspaceTopology = {};

  for (const { filePath, pkg } of raw) {
    const dependencies = normalizeDependencyMap(pkg.dependencies);
    const devDependencies = normalizeDependencyMap(pkg.devDependencies);
    const peerDependencies = normalizeDependencyMap(pkg.peerDependencies);
    const allDeps = {
      ...dependencies,
      ...devDependencies,
      ...peerDependencies,
    };

    topology[pkg.name] = {
      name: pkg.name,
      version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
      path: path.relative(cwd, path.dirname(filePath)),
      dependencies,
      devDependencies,
      peerDependencies,
      internalDependencies: Object.keys(allDeps)
        .filter((dependencyName) => allNames.has(dependencyName))
        .sort(),
    };
  }

  return topology;
}

export function formatTopologySummary(topology: WorkspaceTopology): string {
  const packages = Object.values(topology).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const lines = [`Workspace Topology - ${packages.length} package(s)`];

  for (const meta of packages) {
    const deps =
      meta.internalDependencies.length > 0
        ? meta.internalDependencies.join(", ")
        : "(none)";
    lines.push(`- ${meta.name} [${meta.path}] -> ${deps}`);
  }

  return lines.join("\n");
}

interface PackageJson {
  name?: unknown;
  version?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
}

interface WorkspacePackageJson extends PackageJson {
  name: string;
}

function normalizeDependencyMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version === "string") {
      output[name] = version;
    }
  }

  return output;
}

async function getWorkspacePackagePatterns(root: string): Promise<string[]> {
  const patterns = new Set<string>([
    "apps/*/package.json",
    "packages/*/package.json",
    "services/*/package.json",
    "libs/*/package.json",
    "tools/*/package.json",
    "workers/*/package.json",
  ]);

  try {
    const rootPkg = JSON.parse((await readAuthorizedSource(root, "package.json")).text) as PackageJson;
    for (const workspace of normalizeWorkspaces(rootPkg.workspaces).filter(isSafeWorkspaceGlob)) {
      patterns.add(`${workspace.replace(/\/?$/, "")}/package.json`);
    }
  } catch {
    // Root package.json is optional for topology discovery.
  }

  try {
    const pnpmWorkspace = (await readAuthorizedSource(root, "pnpm-workspace.yaml")).text;
    for (const workspace of parsePnpmWorkspacePackages(pnpmWorkspace).filter(isSafeWorkspaceGlob)) {
      patterns.add(`${workspace.replace(/\/?$/, "")}/package.json`);
    }
  } catch {
    // pnpm-workspace.yaml is optional.
  }

  return [...patterns];
}

function normalizeWorkspaces(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (value && typeof value === "object" && "packages" in value) {
    const packages = (value as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((item): item is string => typeof item === "string");
    }
  }

  return [];
}

function parsePnpmWorkspacePackages(value: string): string[] {
  const packages: string[] = [];
  let inPackages = false;

  for (const line of value.split(/\r?\n/)) {
    if (/^\s*packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }

    if (inPackages && /^\S/.test(line) && !/^\s*-/.test(line)) {
      inPackages = false;
    }

    const match = inPackages ? line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/) : null;
    if (match) {
      packages.push(match[1]);
    }
  }

  return packages;
}

function isSafeWorkspaceGlob(value: string): boolean {
  return !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !/^[!~]/.test(value) && !/^[A-Za-z]:/.test(value);
}
