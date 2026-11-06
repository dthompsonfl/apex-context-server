import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FixtureWorkspace {
  root: string;
  configDir: string;
  cleanup: () => Promise<void>;
}

export async function createFixtureWorkspace(prefix = "apex-fixture-"): Promise<FixtureWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const configDir = path.join(root, ".apex-config");
  process.env.APEX_CONTEXT_CONFIG_DIR = configDir;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  await mkdir(configDir, { recursive: true });

  await mkdir(path.join(root, "apps/web/src/app"), { recursive: true });
  await mkdir(path.join(root, "apps/web/src/components"), { recursive: true });
  await mkdir(path.join(root, "apps/web/src/lib"), { recursive: true });
  await mkdir(path.join(root, "packages/ui/src"), { recursive: true });
  await mkdir(path.join(root, "packages/shared/src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });

  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-monorepo", private: true, workspaces: ["apps/*", "packages/*"] }, null, 2));
  await writeFile(path.join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["packages/shared/src/*"], "@ui/*": ["packages/ui/src/*"] } } }, null, 2));
  await writeFile(path.join(root, "apps/web/package.json"), JSON.stringify({ name: "@fixture/web", version: "1.0.0", dependencies: { "@fixture/ui": "workspace:*", "@fixture/shared": "workspace:*" } }, null, 2));
  await writeFile(path.join(root, "packages/ui/package.json"), JSON.stringify({ name: "@fixture/ui", version: "1.0.0", dependencies: { "@fixture/shared": "workspace:*" } }, null, 2));
  await writeFile(path.join(root, "packages/shared/package.json"), JSON.stringify({ name: "@fixture/shared", version: "1.0.0" }, null, 2));
  await writeFile(path.join(root, "apps/web/tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@shared/*": ["../../packages/shared/src/*"] } } }, null, 2));
  await writeFile(path.join(root, "packages/shared/src/format.ts"), `export interface FormatOptions { uppercase?: boolean; }\nexport function formatTitle(value: string, opts: FormatOptions = {}): string {\n  const trimmed = value.trim();\n  return opts.uppercase ? trimmed.toUpperCase() : trimmed;\n}\nexport const SHARED_TOKEN = "shared-token";\n`);
  await writeFile(path.join(root, "packages/shared/src/index.ts"), `export { formatTitle, SHARED_TOKEN } from "./format";\nexport type { FormatOptions } from "./format";\n`);
  await writeFile(path.join(root, "packages/ui/src/Button.tsx"), `import { formatTitle, type FormatOptions } from "@fixture/shared";\nexport interface ButtonProps { label: string; format?: FormatOptions; }\nexport function Button(props: ButtonProps): string {\n  return formatTitle(props.label, props.format);\n}\n`);
  await writeFile(path.join(root, "apps/web/src/components/Card.tsx"), `import { Button, type ButtonProps } from "@ui/Button";\nexport type CardProps = ButtonProps & { id: string };\nexport function Card(props: CardProps): string {\n  return Button(props);\n}\n`);
  await writeFile(path.join(root, "apps/web/src/lib/local.ts"), `export function localHelper(input: string): string { return input + "!"; }\n`);
  await writeFile(path.join(root, "apps/web/src/app/page.tsx"), `import { Card } from "@/components/Card";\nimport { localHelper } from "@/lib/local";\nexport default function Page() {\n  return Card({ id: "home", label: localHelper("hello") });\n}\n`);
  await writeFile(path.join(root, "apps/web/src/app/route.ts"), `export async function GET() { return new Response("ok"); }\n`);
  await writeFile(path.join(root, "docs/overview.md"), `# Fixture\nThis documents Button and Card.\n`);
  await writeFile(path.join(root, "packages/ui/src/Button.test.ts"), `import { Button } from "./Button";\nexport const t = Button({ label: "x" });\n`);

  return { root, configDir, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}
