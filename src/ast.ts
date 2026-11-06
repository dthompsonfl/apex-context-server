import { authorizeFile, readAuthorizedSourceSync, resolveRoot, boundedOutput } from "./safety.js";
import path from "node:path";
import { Node, Project, SourceFile, SyntaxKind } from "ts-morph";

let project: Project | null = null;

interface ResolvedDefinition {
  name: string;
  source: "imported" | "local";
  sourceFile: SourceFile;
  node: Node;
  textNode: Node;
}

const MAX_DEPENDENCY_DEPTH = 6;
const GLOBAL_TYPE_NAMES = new Set([
  "Array",
  "Awaited",
  "Boolean",
  "Date",
  "Error",
  "Function",
  "Map",
  "NonNullable",
  "Number",
  "Omit",
  "Partial",
  "Pick",
  "Promise",
  "Readonly",
  "Record",
  "Required",
  "ReturnType",
  "Set",
  "String",
  "WeakMap",
  "WeakSet",
]);

function getProject(): Project {
  if (!project) {
    project = new Project({ skipAddingFilesFromTsConfig: true });
  }

  return project;
}

function getOrCreateSourceFile(filePath: string): SourceFile | undefined {
  const p = getProject();
  const verified = readAuthorizedSourceSync(resolveRoot(), filePath);
  return p.createSourceFile(verified.path, verified.text, { overwrite: true });
}

export async function extractComponentContext(
  filePath: string,
  nodeName: string,
): Promise<string> {
  const absolutePath = authorizeFile(resolveRoot(), filePath);

  const sourceFile = getOrCreateSourceFile(absolutePath);
  if (!sourceFile) {
    throw new Error(`Failed to parse: ${absolutePath}`);
  }

  const targetNode = findExportedNode(sourceFile, nodeName);
  if (!targetNode) {
    const available = [...sourceFile.getExportedDeclarations().keys()];
    throw new Error(
      `Export "${nodeName}" not found in ${filePath}. Available exports: ${
        available.join(", ") || "(none)"
      }`,
    );
  }

  const textNode = expandDeclarationTextNode(targetNode);
  const dependencyTexts = collectTypeDependencies(sourceFile, textNode);
  const relativeSource = path.relative(process.cwd(), absolutePath) || absolutePath;

  const sections = [
    `// === Source: ${relativeSource} :: ${nodeName} ===\n\n${cleanNodeText(
      textNode,
    )}`,
  ];

  if (dependencyTexts.length > 0) {
    sections.push(
      `// === Imported / Local Dependencies ===\n\n${dependencyTexts.join(
        "\n\n",
      )}`,
    );
  }

  return boundedOutput(sections.join("\n\n"));
}

function findExportedNode(
  sourceFile: SourceFile,
  nodeName: string,
): Node | undefined {
  const exported = sourceFile.getExportedDeclarations().get(nodeName);
  if (exported && exported.length > 0) {
    return exported[0];
  }

  for (const desc of sourceFile.getDescendants()) {
    if (getSupportedDeclarationName(desc) === nodeName) {
      return desc;
    }
  }

  return undefined;
}

function collectTypeDependencies(sourceFile: SourceFile, node: Node): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const rootKey = declarationKey(sourceFile, getDeclarationName(node), node);
  seen.add(rootKey);

  function visit(currentFile: SourceFile, currentNode: Node, depth: number): void {
    if (depth > MAX_DEPENDENCY_DEPTH) {
      return;
    }

    for (const typeName of collectReferencedTypeNames(currentNode)) {
      if (GLOBAL_TYPE_NAMES.has(typeName)) {
        continue;
      }

      const resolved = resolveDefinition(currentFile, typeName);
      if (!resolved) {
        continue;
      }

      const key = declarationKey(
        resolved.sourceFile,
        resolved.name,
        resolved.textNode,
      );
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      results.push(
        `// [${resolved.source}] ${resolved.name} from ${relativeFile(
          resolved.sourceFile,
        )}\n${cleanNodeText(resolved.textNode)}`,
      );
      visit(resolved.sourceFile, resolved.textNode, depth + 1);
    }
  }

  visit(sourceFile, node, 0);
  return results;
}

function collectReferencedTypeNames(node: Node): string[] {
  const names = new Set<string>();

  node.forEachDescendant((desc) => {
    if (Node.isTypeReference(desc)) {
      const typeName = desc.getTypeName();
      if (Node.isIdentifier(typeName)) {
        names.add(typeName.getText());
      } else if (Node.isQualifiedName(typeName)) {
        names.add(typeName.getLeft().getText());
      }
    }

    if (Node.isExpressionWithTypeArguments(desc)) {
      const expression = desc.getExpression();
      if (Node.isIdentifier(expression)) {
        names.add(expression.getText());
      }
    }
  });

  return [...names].filter((name) => /^[A-Z_$]/.test(name));
}

function resolveDefinition(
  sourceFile: SourceFile,
  typeName: string,
): ResolvedDefinition | null {
  const imported = resolveImportedDefinition(sourceFile, typeName);
  if (imported) {
    return imported;
  }

  return resolveLocalDefinition(sourceFile, typeName);
}

function resolveImportedDefinition(
  sourceFile: SourceFile,
  typeName: string,
): ResolvedDefinition | null {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    for (const namedImport of importDecl.getNamedImports()) {
      const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      if (localName !== typeName) {
        continue;
      }

      const targetFile = getImportTargetFile(importDecl.getModuleSpecifierValue(), sourceFile);
      if (!targetFile) {
        continue;
      }

      const exportedName = namedImport.getName();
      const declaration = findDeclarationInSourceFile(targetFile, exportedName);
      if (declaration) {
        return toResolvedDefinition(
          exportedName,
          "imported",
          targetFile,
          declaration,
        );
      }
    }

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport?.getText() === typeName) {
      const targetFile = getImportTargetFile(importDecl.getModuleSpecifierValue(), sourceFile);
      if (!targetFile) {
        continue;
      }

      const declaration =
        findExportedNode(targetFile, "default") ??
        findDeclarationInSourceFile(targetFile, typeName);
      if (declaration) {
        return toResolvedDefinition(typeName, "imported", targetFile, declaration);
      }
    }
  }

  return null;
}

function resolveLocalDefinition(
  sourceFile: SourceFile,
  typeName: string,
): ResolvedDefinition | null {
  const declaration = findDeclarationInSourceFile(sourceFile, typeName);
  if (!declaration) {
    return null;
  }

  return toResolvedDefinition(typeName, "local", sourceFile, declaration);
}

function findDeclarationInSourceFile(
  sourceFile: SourceFile,
  name: string,
): Node | undefined {
  const exported = sourceFile.getExportedDeclarations().get(name);
  if (exported && exported.length > 0) {
    return exported[0];
  }

  for (const desc of sourceFile.getDescendants()) {
    if (getSupportedTypeDeclarationName(desc) === name) {
      return desc;
    }
  }

  return undefined;
}

function getImportTargetFile(
  specifier: string,
  sourceFile: SourceFile,
): SourceFile | undefined {
  const importSourceFile = sourceFile
    .getImportDeclarations()
    .find((decl) => decl.getModuleSpecifierValue() === specifier)
    ?.getModuleSpecifierSourceFile();
  if (importSourceFile) {
    try {
      authorizeFile(resolveRoot(), importSourceFile.getFilePath());
      return importSourceFile;
    } catch {
      // External or excluded declarations are not part of authorized context.
      return undefined;
    }
  }

  const resolvedPath = resolveModuleToFile(sourceFile, specifier);
  return resolvedPath ? getOrCreateSourceFile(resolvedPath) : undefined;
}

function resolveModuleToFile(
  sourceFile: SourceFile,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) {
    if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
      const sourceParts = sourceFile.getFilePath().split(path.sep);
      const srcIndex = sourceParts.lastIndexOf("src");
      const sourceRoot = srcIndex >= 0 ? sourceParts.slice(0, srcIndex + 1).join(path.sep) || path.sep : path.join(resolveRoot(), "src");
      const aliasBase = path.resolve(sourceRoot, specifier.slice(2));
      return findFirstExistingSourceFile([
        `${aliasBase}.ts`,
        `${aliasBase}.tsx`,
        `${aliasBase}.mts`,
        `${aliasBase}.cts`,
        `${aliasBase}.d.ts`,
        `${aliasBase}.js`,
        `${aliasBase}.jsx`,
        `${aliasBase}.mjs`,
        `${aliasBase}.cjs`,
        path.join(aliasBase, "index.ts"),
        path.join(aliasBase, "index.tsx"),
        path.join(aliasBase, "index.mts"),
        path.join(aliasBase, "index.cts"),
        path.join(aliasBase, "index.d.ts"),
        path.join(aliasBase, "index.js"),
        path.join(aliasBase, "index.jsx"),
        path.join(aliasBase, "index.mjs"),
        path.join(aliasBase, "index.cjs"),
      ]);
    }

    return null;
  }

  const baseDir = path.dirname(sourceFile.getFilePath());
  const base = path.resolve(baseDir, specifier);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.d.ts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.mts"),
    path.join(base, "index.cts"),
    path.join(base, "index.d.ts"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
    path.join(base, "index.mjs"),
    path.join(base, "index.cjs"),
  ];

  return findFirstExistingSourceFile(candidates);
}

function findFirstExistingSourceFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (getOrCreateSourceFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function toResolvedDefinition(
  name: string,
  source: "imported" | "local",
  sourceFile: SourceFile,
  node: Node,
): ResolvedDefinition {
  return {
    name,
    source,
    sourceFile,
    node,
    textNode: expandDeclarationTextNode(node),
  };
}

function expandDeclarationTextNode(node: Node): Node {
  if (Node.isVariableDeclaration(node)) {
    return node.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? node;
  }

  if (Node.isExportAssignment(node)) {
    return node;
  }

  return node;
}

function getDeclarationName(node: Node): string {
  return getSupportedDeclarationName(node) ?? node.getKindName();
}

function getSupportedDeclarationName(node: Node): string | undefined {
  if (
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isEnumDeclaration(node)
  ) {
    return node.getName();
  }

  return undefined;
}

function getSupportedTypeDeclarationName(node: Node): string | undefined {
  if (
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isClassDeclaration(node)
  ) {
    return node.getName();
  }

  return undefined;
}

function declarationKey(sourceFile: SourceFile, name: string, node: Node): string {
  return `${sourceFile.getFilePath()}::${name}::${node.getStart()}`;
}

function cleanNodeText(node: Node): string {
  return node.getFullText().trim();
}

function relativeFile(sourceFile: SourceFile): string {
  return path.relative(process.cwd(), sourceFile.getFilePath()) || sourceFile.getFilePath();
}
