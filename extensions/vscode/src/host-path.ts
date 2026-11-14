import * as hostPath from 'node:path';

export function hasUnambiguousRoot(entered: string, paths = hostPath): boolean {
  if (paths.sep === '\\' && (/^[a-z]:/i.test(entered) || /^[\\/]/.test(entered))) {
    // Node also treats a path rooted on the current drive as absolute. Check
    // the underlying UNC or drive root for extended-length spellings as well.
    const qualified = paths.normalize(entered).replace(/^\\\\[?.]\\UNC(?:\\|$)/i, '\\\\')
      .replace(/^\\\\[?.]\\(?=[a-z]:)/i, '');
    const root = paths.parse(qualified).root;
    if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\?)$/i.test(root)) {
      return false;
    }
  }
  return true;
}
