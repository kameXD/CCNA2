// The trash list keeps the relative order of deleted entries. Resolve a
// missing neighbour through other entries still in the trash when possible.
export function restoreOrder(order, trash, ids) {
  const restored = [...order];
  const deleted = new Map(trash.map(record => [record.entry.id, record]));
  const wanted = new Set(ids);
  let minimum = 0;
  function neighbour(id, direction) {
    const visited = new Set();
    while (id && !visited.has(id)) {
      const index = restored.findIndex(entry => entry.id === id);
      if (index >= 0) return index;
      visited.add(id);
      id = deleted.get(id)?.[direction];
    }
    return -1;
  }
  for (const record of trash) {
    if (!wanted.has(record.entry.id)) continue;
    const previous = neighbour(record.previous, 'previous');
    const next = neighbour(record.next, 'next');
    let at = Math.min(record.index, restored.length);
    if (next >= 0 && previous < next) at = next;
    else if (previous >= 0 && next < 0) at = previous + 1;
    else if (next >= 0) {
      // If the neighbours were reordered across one another, use the
      // surviving position closest to where the entry was deleted.
      at = Math.abs(next - at) <= Math.abs(previous + 1 - at) ? next : previous + 1;
    }
    at = Math.max(minimum, at);
    restored.splice(at, 0, record.entry);
    minimum = at + 1;
  }
  return restored;
}

export function moveToTrash(order, trash, ids) {
  const selected = new Set(ids);
  const records = new Map(trash.map(record => [record.entry.id, record]));
  const layout = restoreOrder(order, trash, records.keys());
  const nextTrash = [];
  const moved = [];
  layout.forEach((entry, index) => {
    if (records.has(entry.id)) {
      nextTrash.push(records.get(entry.id));
    } else if (selected.has(entry.id)) {
      nextTrash.push({ entry, index, previous: layout[index - 1]?.id, next: layout[index + 1]?.id });
      moved.push(entry.id);
    }
  });
  return { order: order.filter(entry => !selected.has(entry.id)), trash: nextTrash, moved };
}
