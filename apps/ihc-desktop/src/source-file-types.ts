const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".mdx"] as const;

export function isMarkdownFileName(name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase("en-US");
  return MARKDOWN_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

export function isMarkdownPath(pathSegments: readonly string[]): boolean {
  return isMarkdownFileName(pathSegments[pathSegments.length - 1] ?? "");
}
