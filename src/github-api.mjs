const API_VERSION = '2022-11-28';

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
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
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...authHeaders(token)
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub REST request failed: ${response.status} ${path}`);
  }

  return response.json();
}
