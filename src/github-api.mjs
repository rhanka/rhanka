const API_VERSION = '2022-11-28';
const RETRYABLE_REST_STATUSES = new Set([403, 429, 500, 502, 503, 504]);

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers?.get?.('retry-after'));

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }

  return Math.min(30000, 1000 * (2 ** attempt));
}

export async function githubGraphql(query, variables, token, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...authHeaders(token)
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL errors: ${payload.errors.map((entry) => entry.message).join('; ')}`
    );
  }

  return payload.data;
}

export async function githubRest(path, token, fetchImpl = fetch) {
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...authHeaders(token)
      }
    });

    if (response.ok) {
      return response.json();
    }

    const detail = typeof response.text === 'function' ? await response.text() : '';

    if (attempt < maxAttempts - 1 && RETRYABLE_REST_STATUSES.has(response.status)) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }

    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`GitHub REST request failed: ${response.status} ${path}${suffix}`);
  }
}
