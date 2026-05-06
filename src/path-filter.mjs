function normalizeRepoPath(filePath) {
  return String(filePath ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function globToRegExp(glob) {
  const normalizedGlob = normalizeRepoPath(glob);
  let source = '^';

  for (let index = 0; index < normalizedGlob.length;) {
    if (normalizedGlob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
      continue;
    }

    if (normalizedGlob.startsWith('**', index)) {
      source += '.*';
      index += 2;
      continue;
    }

    const char = normalizedGlob[index];

    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }

    index += 1;
  }

  return new RegExp(`${source}$`);
}

export function createPathExcluder(globs = []) {
  const regexes = [...new Set(globs)]
    .filter((glob) => typeof glob === 'string' && glob.trim() !== '')
    .map((glob) => globToRegExp(glob));

  return (filePath) => {
    const normalizedPath = normalizeRepoPath(filePath);
    return regexes.some((regex) => regex.test(normalizedPath));
  };
}
