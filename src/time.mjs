export function weekStartUtc(input) {
  const date = new Date(input);
  const utcDay = date.getUTCDay();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - utcDay);
  return date.toISOString();
}

export function buildRollingWindow(nowIso, weekCount) {
  const lastWeek = new Date(weekStartUtc(nowIso));
  const weeks = [];

  for (let index = weekCount - 1; index >= 0; index -= 1) {
    const week = new Date(lastWeek);
    week.setUTCDate(week.getUTCDate() - index * 7);
    weeks.push(week.toISOString());
  }

  return {
    start: weeks[0],
    // Inclusive upper bound: last millisecond of the week following the final entry.
    end: new Date(
      new Date(weeks[weeks.length - 1]).getTime() + 7 * 24 * 60 * 60 * 1000 - 1
    ).toISOString(),
    weeks
  };
}
