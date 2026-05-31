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
      bookmarked: !!c.bookmarked,
      isAdmin: !!c.isAdmin,
      hwid: c.hwid,
      cpu: c.cpu,
      gpu: c.gpu,
      ram: c.ram,
      batteryPercent: c.batteryPercent,
      batteryCharging: c.batteryCharging,
      groupId: c.groupId,
      groupName: c.groupName,
      groupColor: c.groupColor,
      notificationsMuted: !!c.notificationsMuted,
      hasThumbnail: !!c.hasThumbnail,
      thumbnailVersion: c.thumbnailVersion,
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
