function formatCompactCore(value) {
  const absolute = Math.abs(value);

  if (absolute < 1000) {
    return String(Math.round(value));
  }

  if (absolute < 100000) {
    const thousands = Math.round((value / 1000) * 10) / 10;
    return `${thousands.toFixed(Number.isInteger(thousands) ? 0 : 1)}k`;
  }

  if (absolute < 1000000) {
    return `${Math.round(value / 1000)}k`;
  }

  const millions = Math.round((value / 1000000) * 10) / 10;
  return `${millions.toFixed(Number.isInteger(millions) ? 0 : 1)}M`;
}

export function formatCompactNumber(value) {
  return formatCompactCore(value);
}

export function formatSignedCompactNumber(value) {
  if (value === 0) {
    return '0';
  }

  return `${value > 0 ? '+' : '-'}${formatCompactCore(Math.abs(value))}`;
}
