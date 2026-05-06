export function normalizeConfig(raw) {
  return {
    identities: {
      logins: [...new Set(raw.identities?.logins ?? [])],
      emails: [...new Set(raw.identities?.emails ?? [])]
    },
    includeRepos: [...new Set(raw.includeRepos ?? [])],
    excludeRepos: [...new Set(raw.excludeRepos ?? [])],
    windowWeeks: raw.windowWeeks ?? 52,
    lineFilters: {
      excludePathGlobs: [...new Set(raw.lineFilters?.excludePathGlobs ?? [])]
    }
  };
}
