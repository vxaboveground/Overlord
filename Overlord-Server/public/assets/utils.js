export function debounce(fn, delayMs) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delayMs);
  };
}

export function digestData(data, { page, pageSize, searchTerm, sort }) {
  const items =
    data.items?.map((c) => ({
      id: c.id,
      online: !!c.online,
      lastSeen: c.lastSeen,
      ping: c.pingMs,
      host: c.host,
      user: c.user,
      customTag: c.customTag,
      customTagNote: c.customTagNote,
      version: c.version,
      country: c.country,
      arch: c.arch,
      os: c.os,
      monitors: c.monitors,
      elevation: c.elevation,
    })) || [];
  return JSON.stringify({
    page,
    pageSize,
    searchTerm,
    sort,
    total: data.total,
    online: data.online,
    items,
  });
}
